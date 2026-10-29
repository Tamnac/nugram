import { sentTools } from "./tools";
import { ApiType, Provider, ToolCall, Options, providerNames, DEFAULT_PROVIDERS, isGpt56OrLater, ReasoningEnc, extraBodyRuleMatches, type AgentPreset, type ToolMode } from './types';
import { toResponsesInput } from './responses';
import { httpFetch } from "./platform";
import { estTokensFromLength } from "./tokens";
import type { Setter } from "solid-js";

/**
 * The request body as JSON, with lone surrogates (from shell output, fetched
 * pages, run_js prints...) replaced by U+FFFD. JSON.stringify would send them
 * as `\ud800` escapes, which servers that encode to UTF-8 reject outright, and
 * since history is resent every turn the chat could never be sent again.
 */
export const encodeRequestBody = (body: unknown) =>
	JSON.stringify(body, (_key, value) => typeof value === 'string' ? value.toWellFormed() : value);

function isPlainObject(v: any): v is Record<string, any> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Recursively merge `source` into `target`, mutating and returning `target`.
 * Overlapping plain objects are merged key-by-key; everything else (primitives,
 * arrays) is overwritten by `source`. Used to fold user-supplied extra body args
 * into the generated request body.
 */
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
	for (const key of Object.keys(source)) {
		const sv = source[key];
		const tv = target[key];
		if (isPlainObject(sv) && isPlainObject(tv))
			deepMerge(tv, sv);
		else
			target[key] = sv;
	}
	return target;
}

// Generous output budget — death spirals are caught mid-stream instead, see below
const MAX_OUTPUT_TOKENS = 32000;
const MAX_OUTPUT_TOKENS_ANTH = 64000;

// Death-spiral detection: flags when the stream's tail holds a long run of one repeated
// cycle — ≥3 full repetitions for sentence-sized units, ≥6 for word-sized ones, which
// repeat legitimately ("no no no"). Checks suffixes of the window rather than the whole
// window because real spirals start mid-response, after unique text.
const SPIRAL_WINDOW = 3000;
const SPIRAL_MIN = 500;
const SPIRAL_SMALL_UNIT = 24;

// Finds the longest suffix of s (≥ minLen) made of one cycle repeated, i.e.
// s[i] === s[i-period] throughout. Uses the KMP prefix function on the reversed
// string: f[L-1] is the longest border of the suffix of length L, and a string has
// period p iff it has a border of length L - p.
function repeatingSuffix(s: string, minLen: number): { len: number; period: number } | null {
	const n = s.length;
	const f = new Int32Array(n);
	for (let i = 1; i < n; i++) {
		let j = f[i - 1];
		const c = s[n - 1 - i];
		while (j > 0 && c !== s[n - 1 - j]) j = f[j - 1];
		if (c === s[n - 1 - j]) j++;
		f[i] = j;
	}
	for (let L = n; L >= minLen; L--) {
		const period = L - f[L - 1];
		const reps = L / period;
		if (reps >= (period < SPIRAL_SMALL_UNIT ? 6 : 3)) return { len: L, period };
	}
	return null;
}

function createRepetitionDetector() {
	let buf = '';
	let sinceCheck = 0;
	return (text: string): boolean => {
		buf = (buf + text).slice(-SPIRAL_WINDOW);
		sinceCheck += text.length;
		if (buf.length < SPIRAL_MIN || sinceCheck < 64) return false;
		sinceCheck = 0;
		return repeatingSuffix(buf, SPIRAL_MIN) !== null;
	};
}

function createToolCallFromBuffer(buffer: { id?: string; name?: string; arguments: string }): ToolCall | null {
	if (!buffer.id || !buffer.name) return null;

	try {
		const args = buffer.arguments.length > 0 ? JSON.parse(buffer.arguments) : {};
		return {
			id: buffer.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
			type: 'function',
			function: {
				name: buffer.name,
				arguments: args
			}
		};
	} catch (e) {
		return null;
	}
}

export interface StreamingResult {
	success: boolean;
	error?: string | undefined;
	toolCalls?: ToolCall[] | undefined;
	id?: string | undefined;
	timing?: MessageTiming | undefined;
	usage?: UsageData | undefined;
	thinking_signature?: string | undefined;
	/** Responses API: reasoning items (id + encrypted_content + summary parts) for turn rehydration. */
	reasoning_enc?: ReasoningEnc[] | undefined;
	finishReason?: string | undefined;
}

export interface MessageTiming {
	time_to_first_token?: number | undefined; // Time to first token in milliseconds
	estimated_tokens?: number | undefined; // Output tokens estimated from the streamed text, for providers that report none
	reasoning_time?: number | undefined; // Time spent reasoning in milliseconds
	message_time?: number | undefined; // Time spent on regular tokens in milliseconds
}

export interface UsageData {
	prompt_tokens: number;
	message_tokens: number;
	reasoning_tokens: number;
	prompt_cost: number;
	message_cost: number;
	cached_tokens?: number;
}

let seedFlip = false;

export async function streamChatCompletion(
	model: string,
	messages: any[],
	requestOptions: Options,
	apiKey: string,
	siteName: string,
	signal: AbortSignal,
	provider: Provider,
	providerUrl: string | undefined,
	apiType?: ApiType,
	onContent?: (content: string) => void,
	onReasoning?: (reasoning: string) => void,
	onError?: (error: string) => void,
	onId?: (id: string) => void,
	setInfo?: Setter<string | null>,
	selectedTools?: Record<string, boolean>,
	cacheControl?: { type: string; ttl?: string },
	/** Chat id, sent to Responses clients as prompt_cache_key (cache routing). */
	chatId?: string,
	/** How tools are offered; `run` and `js` ask for one call per turn. */
	toolMode: ToolMode = 'native',
	/** Display name for custom providers; builtins fall back to providerNames. Used by extra_body matching. */
	providerName?: string,
	/** Presets from the sending chat's config. */
	agentPresets: AgentPreset[] = []
): Promise<StreamingResult> {

		const { repetition_penalty, top_k, top_p, usage, preserve_reasoning, random_seed, reasoning, extra_body, ...rest } = requestOptions
		const useGptPromptCache = isGpt56OrLater(model) && !!cacheControl;
		const promptCacheBody = useGptPromptCache
			? { prompt_cache_options: { mode: 'implicit', ttl: '30m' } }
			: {};
		const anthropicCacheControl = cacheControl && !useGptPromptCache ? cacheControl : undefined;

		let adjustedOptions: any = rest;
		if (random_seed) {
			const max = 2147483647;
			const val = Math.floor(Math.random() * max);
			seedFlip = !seedFlip;
			adjustedOptions.seed = seedFlip ? max - val : val;
		}

		if (repetition_penalty && repetition_penalty !== 1) adjustedOptions.repetition_penalty = repetition_penalty;
		if (top_k && top_k > 0 && provider !== 'zai') adjustedOptions.top_k = top_k;
		if (top_p && top_p !== 1) adjustedOptions.top_p = top_p;
		// anth_local only supports one of temperature or top_p - if both are set, use temperature only
		if (provider === 'anth_local' && adjustedOptions.temperature !== undefined && adjustedOptions.temperature !== 1 && adjustedOptions.top_p !== undefined && adjustedOptions.top_p !== 1) {
			delete adjustedOptions.top_p;
		}
		// usage: {include} is openrouter-specific; other providers use stream_options.include_usage or report usage by default
		if (provider === 'or') adjustedOptions.usage = usage;

		// reasoning_effort is the common field for openai-completions endpoints: zai (GLM-5.2), nano, or, fireworks, anth_local, nueralwatt confirmed. Omit when unset so each provider keeps its own default
		if (reasoning?.effort) adjustedOptions.reasoning_effort = reasoning.effort;

	// Timing state lives outside the try so it can still be reported when the stream is aborted
	const startTime = performance.now();
	let firstTokenTime: number | null = null;
	let reasoningStartTime: number | null = null;
	let reasoningEndTime: number | null = null;
	let messageStartTime: number | null = null;
	let messageEndTime: number | null = null;
	let outputChars = 0;
	const toolCalls: ToolCall[] = [];
	let usageData: UsageData | undefined;

	function buildTiming(): MessageTiming {
		const endTime = performance.now();
		if (reasoningStartTime !== null && reasoningEndTime === null) reasoningEndTime = endTime;
		if (messageStartTime !== null && messageEndTime === null) messageEndTime = endTime;

		const toolCallChars = toolCalls.reduce((n, tc) => n + tc.function.name.length + JSON.stringify(tc.function.arguments).length, 0);

		return {
			time_to_first_token: firstTokenTime !== null ? firstTokenTime - startTime : undefined,
			estimated_tokens: estTokensFromLength(outputChars + toolCallChars, model),
			reasoning_time: reasoningStartTime !== null && reasoningEndTime !== null ? reasoningEndTime - reasoningStartTime : undefined,
			message_time: messageStartTime !== null && messageEndTime !== null ? messageEndTime - messageStartTime : undefined,
		};
	}

	try {
		if ((apiKey === 'YOUR_OPENROUTER_API_KEY' || !apiKey) && provider !== 'anth_local' && provider in providerNames) {
			const providerLabel = (providerNames as Record<string, string>)[provider] || provider;
			throw new Error(`Please set your ${providerLabel} API key in the sidebar`);
		}

		const filteredTools = sentTools(selectedTools, undefined, model, provider, toolMode, agentPresets);
		// One `run` or run_js call per turn is wanted; several still work, chained in order.
		const oneCall = toolMode !== 'native';
		const toolFields = filteredTools.length > 0
			? { tools: filteredTools, ...(oneCall && { parallel_tool_calls: false }) }
			: {};

		const apiUrl = providerUrl || DEFAULT_PROVIDERS[provider].url;
		
		
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		
		// Only add Authorization and X-Title headers for providers that need them
		if (provider !== 'anth_local') {
			headers["Authorization"] = `Bearer ${apiKey}`;
			if (provider !== 'fireworks' && provider !== 'neuralwatt')
				headers["X-Title"] = siteName;
		}

		let body;
		if (apiType === 'responses') {
			// reasoning_effort is a chat-completions field; Responses takes reasoning.effort
			delete adjustedOptions.reasoning_effort;
			body = {
				model,
				input: toResponsesInput(messages),
				max_output_tokens: MAX_OUTPUT_TOKENS,
				...adjustedOptions,
				...(reasoning?.effort && {
					reasoning: {
						effort: reasoning.effort,
						// The UI renders the reasoning stream; auto summaries are too sparse for that
						...(reasoning.effort !== 'none' && { summary: 'detailed' }),
					}
				}),
				...(filteredTools.length > 0 && {
					// strict schema validation rejects most real-world tool schemas
					tools: filteredTools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false })),
					...(oneCall && { parallel_tool_calls: false }),
				}),
				store: false,
				include: ['reasoning.encrypted_content'],
				...(chatId && { prompt_cache_key: chatId }),
				...promptCacheBody,
				...(anthropicCacheControl && { cache_control: anthropicCacheControl }),
			};
		} else switch (provider) {
			case "zai":
				body = {
					model,
					messages,
					max_tokens: MAX_OUTPUT_TOKENS,
					...adjustedOptions,
					thinking: requestOptions.reasoning?.effort !== 'none'
						? { type: 'enabled', ...(requestOptions.preserve_reasoning === 'full' && { clear_thinking: false }) }
						: { type: 'disabled' },
					...toolFields,
					...promptCacheBody,
				};
				break;

				case "nano":
				body = {
					model: requestOptions.reasoning?.effort !== 'none' && (/V3\.1|V3\.2|K2\.5/i).test(model) ? `${model}:thinking` : model,
					messages,
					max_tokens: MAX_OUTPUT_TOKENS,
					...adjustedOptions,
					...(adjustedOptions.stream && { stream_options: { include_usage: true } }),
					reasoning: {exclude: false},
					...toolFields,
					...promptCacheBody,
					...(anthropicCacheControl && { cache_control: anthropicCacheControl }),
				};
				break;

			case "anth_local":
				body = {
					model,
					messages,
					max_tokens: MAX_OUTPUT_TOKENS_ANTH,
					...adjustedOptions,
					...toolFields,
					...promptCacheBody,
					...(anthropicCacheControl && { cache_control: anthropicCacheControl }),
				};
				break;

			case "fireworks":
				body = {
					model: model.startsWith("accounts/fireworks/") ? model : `accounts/fireworks/models/${model}`,
					messages,
					max_tokens: MAX_OUTPUT_TOKENS,
					...adjustedOptions,
					...(adjustedOptions.stream && { stream_options: { include_usage: true } }),
					...toolFields,
					...promptCacheBody,
					...(requestOptions.preserve_reasoning === 'full' && { reasoning_history: 'preserved' }),
				};
				break;

			case "neuralwatt":
				body = {
					model,
					messages,
					max_tokens: MAX_OUTPUT_TOKENS,
					...adjustedOptions,
					...toolFields,
					...promptCacheBody,
					...(requestOptions.preserve_reasoning === 'full' && {
						chat_template_kwargs: { preserve_thinking: true, clear_thinking: false }
					}),
				};
				break;

			case "openrouter":
				body = {
					model,
					messages,
					max_tokens: MAX_OUTPUT_TOKENS,
					...adjustedOptions,
					provider: {
						ignore: ignore(model),
					},
					transforms: [] as string[],
					...toolFields,
					...promptCacheBody,
					...(anthropicCacheControl && { cache_control: anthropicCacheControl }),
				}
			break;

			default:
				body = {
					model,
					messages,
					max_tokens: MAX_OUTPUT_TOKENS,
					...adjustedOptions,
					...toolFields,
					...promptCacheBody,
				};
				break;
		}

		// Fold in matched user-supplied arbitrary JSON rules, deep-merging onto generated fields.
		if (extra_body && extra_body.length > 0) {
			const label = providerName || (providerNames as Record<string, string>)[provider] || provider;
			for (const rule of extra_body) {
				if (!extraBodyRuleMatches(rule, provider, label, model)) continue;
				const rawBody = rule.body?.trim();
				if (!rawBody) continue;
				let parsed: any;
				try {
					parsed = JSON.parse(rawBody);
				} catch (e: any) {
					throw new Error(`Invalid JSON in extra body args: ${e.message}`);
				}
				if (!isPlainObject(parsed))
					throw new Error('Extra body args must be a JSON object');
				deepMerge(body, parsed);
			}
		}

		// toggle for debugging. findme
		// console.log(body.messages)

		const response = await httpFetch(apiUrl, {
			method: "POST",
			headers,
			body: encodeRequestBody(body),
			signal
		});


		if (!response.ok) {
			const errorData = await response.json().catch(() => ({ message: response.statusText }));
			const error = new Error(`API Error (${response.status}): ${errorData.error?.message || errorData.message || errorData.detail?.error?.message || 'Unknown error'}`);
			// Attach the full error data to preserve metadata including raw field
			(error as any).errorData = errorData;
			throw error;
		}

		const reader = response.body?.getReader();
		if (!reader) throw new Error('Response body is not readable');

		const decoder = new TextDecoder();
		let buffer = '';
		let responseId: string | undefined;
		const toolCallBuffers: Map<number, { id?: string; name?: string; arguments: string }> = new Map();

		// Detect thinking tags (<think>, <thinking>, <reason>, <reasoning>) at start of content
		let contentThinkingCloseTag = '';
		let contentBuf: string | null = ''; // accumulates content until we know if it starts with a thinking tag
		let thinkBuf = ''; // buffers chunks while looking for close tag across boundaries

		let neuralwattCost: number | undefined; // applied after the stream so chunk ordering doesn't matter
		let thinkingSignature: string | undefined;
		let reasoningEnc: ReasoningEnc[] | undefined;
		let finishReason: string | undefined;
		const detectContentSpiral = createRepetitionDetector();
		const detectReasoningSpiral = createRepetitionDetector();
		let spiralDetected = false;
		const emitContent = (text: string) => {
			onContent?.(text);
			outputChars += text.length;
			if (detectContentSpiral(text)) spiralDetected = true;
		};
		const emitReasoning = (text: string) => {
			onReasoning?.(text);
			outputChars += text.length;
			if (detectReasoningSpiral(text)) spiralDetected = true;
		};
		// Emits reasoning up to the close tag (if present in the buffer yet) and any content after it
		const processThinkBuf = (): boolean => {
			const closeIdx = thinkBuf.toLowerCase().indexOf(contentThinkingCloseTag);
			if (closeIdx === -1) return false;
			if (closeIdx > 0) emitReasoning(thinkBuf.slice(0, closeIdx));
			reasoningEndTime = performance.now();
			const after = thinkBuf.slice(closeIdx + contentThinkingCloseTag.length);
			contentThinkingCloseTag = '';
			thinkBuf = '';
			if (after.trim()) {
				if (messageStartTime === null)
					messageStartTime = performance.now();
				emitContent(after);
			}
			return true;
		};

		// Summary parts and reasoning items are flattened into one thinking string for
		// display; separate them with a blank line (markdown paragraph) unless the stream
		// already ended one. Verbatim per-item parts live in reasoningEnc.
		let reasoningTail = '';
		let pendingReasoningSep = false;
		// Responses API (/v1/responses) events: synthesize a chat-completions-style choice
		// for text/reasoning deltas so the delta machinery below is shared, and record
		// tool calls, usage and terminal status straight off the event stream.
		const handleResponsesEvent = (parsed: any): any => {
			const delta = (field: string) =>
				parsed.delta ? { delta: { [field]: parsed.delta } } : undefined;
			switch (parsed.type) {
				case 'response.output_text.delta':
					return delta('content');
				case 'response.output_item.added':
					if (parsed.item?.type === 'reasoning') pendingReasoningSep = true;
					return;
				case 'response.reasoning_summary_part.added':
					pendingReasoningSep = true;
					return;
				case 'response.reasoning_summary_text.delta':
				case 'response.reasoning_text.delta': {
					let text: string = parsed.delta;
					if (pendingReasoningSep && reasoningTail && !reasoningTail.endsWith('\n\n'))
						text = (reasoningTail.endsWith('\n') ? '\n' : '\n\n') + text;
					pendingReasoningSep = false;
					if (text) reasoningTail = text.slice(-2);
					return { delta: { reasoning: text } };
				}
				case 'response.output_item.done': {
					// Function calls arrive as complete items — arguments are already whole
					const item = parsed.item;
					if (item?.type === 'function_call') {
						if (firstTokenTime === null) {
							firstTokenTime = performance.now();
							messageStartTime = firstTokenTime;
						}
						try {
							const args = typeof item.arguments === 'string' && item.arguments.length > 0
								? JSON.parse(item.arguments) : {};
							const toolCall: ToolCall = {
								id: item.call_id.replace(/[^a-zA-Z0-9_-]/g, '_'),
								type: 'function',
								function: { name: item.name, arguments: args }
							};
							if (!toolCalls.some(tc => tc.id === toolCall.id))
								toolCalls.push(toolCall);
						} catch (e) {
								console.warn('Failed to parse function call item:', item);
						}
					}
					// Reasoning items with encrypted content are stored for rehydration,
					// each with its own summary parts (the done item carries them whole)
					if (item?.type === 'reasoning' && item.encrypted_content) {
						const summary = Array.isArray(item.summary)
							? item.summary.filter((p: any) => p?.type === 'summary_text' && typeof p.text === 'string').map((p: any) => p.text as string)
							: undefined;
						(reasoningEnc ??= []).push({ ...(item.id && { id: item.id }), encrypted_content: item.encrypted_content, ...(summary?.length && { summary }) });
					}
					return;
				}
				case 'response.completed':
				case 'response.incomplete': {
					const r = parsed.response;
					if (r?.id && !responseId) {
						responseId = r.id;
						onId?.(r.id);
					}
					// Normalize to chat-completions finish reasons — consumers like the agent
					// loop's truncation detection check for 'length'
					if (r?.incomplete_details?.reason)
						finishReason = r.incomplete_details.reason === 'max_output_tokens' ? 'length' : r.incomplete_details.reason;
					else if (r?.status)
						finishReason = r.status === 'completed' ? 'stop' : r.status;
					const u = r?.usage;
					if (u) {
						const reasoning_tokens = u.output_tokens_details?.reasoning_tokens || 0;
						usageData = {
							prompt_tokens: u.input_tokens || 0,
							message_tokens: (u.output_tokens || 0) - reasoning_tokens,
							reasoning_tokens,
							prompt_cost: u.cost_details?.upstream_inference_prompt_cost || 0,
							message_cost: u.cost_details?.upstream_inference_completions_cost || u.cost || 0,
							cached_tokens: u.input_tokens_details?.cached_tokens
						};
					}
					return;
				}
				case 'response.failed': {
					const err = parsed.response?.error;
					if (err?.message) onError?.(err.message);
					return;
				}
			}
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				while (true) {
					const lineEnd = buffer.indexOf('\n');
					if (lineEnd === -1) break;

					const line = buffer.slice(0, lineEnd).trim();
					buffer = buffer.slice(lineEnd + 1);

					// Neuralwatt sends cost info as an SSE comment line: ": cost {...}"
					if (provider === 'neuralwatt' && line.startsWith(': cost ')) {
						try {
							neuralwattCost = JSON.parse(line.slice(7)).request_cost_usd || 0;
						} catch (e) { /* ignore */ }
						continue;
					}

					if (line.startsWith('data: ')) {
						const data = line.slice(6);
						// Don't break: providers may emit trailing lines (e.g. neuralwatt's cost comment) after [DONE]
						if (data === '[DONE]') continue;

						try {
							const parsed = JSON.parse(data);
							const err = parsed.error;
							
							if (err) {
								onError?.(err.message);
							} else {
								// Capture the response ID from the first chunk
								if (!responseId && parsed.id) {
									responseId = parsed.id;
									onId?.(responseId!);
								}
								
								const choice = apiType === 'responses' ? handleResponsesEvent(parsed) : parsed.choices?.[0];
								const content = choice?.delta?.content;
								const reasoning = choice?.delta?.reasoning
									|| choice?.delta?.reasoning_content;
								const deltaToolCalls = choice?.delta?.tool_calls;
								if (choice?.finish_reason) finishReason = choice.finish_reason;
								
								if (content) {
									if (firstTokenTime === null)
										firstTokenTime = performance.now();

									// While contentBuf is not null, we're still checking if content starts with a thinking tag
									if (contentBuf !== null) {
										contentBuf += content;
										const trimmed = contentBuf.trimStart();
										const tagMatch = trimmed.match(/^<(think|thinking|reason|reasoning)>/i);
										if (tagMatch) {
											contentThinkingCloseTag = `</${tagMatch[1].toLowerCase()}>`;
											setInfo?.('Thinking found in content and converted');
											if (reasoningStartTime === null)
												reasoningStartTime = firstTokenTime ?? performance.now();
											const rest = trimmed.slice(tagMatch[0].length);
											if (rest) emitReasoning(rest);
											contentBuf = null;
											continue;
										}
										// Determine if the current prefix could still grow into a thinking tag
										const thinkingTags = ['<think>', '<thinking>', '<reason>', '<reasoning>'];
										const lower = trimmed.toLowerCase();
										const couldBecomeTag = trimmed.length === 0
											|| thinkingTags.some(t => t.startsWith(lower));
										if (!couldBecomeTag) {
											// Not a thinking tag — flush as normal content
											if (messageStartTime === null)
												messageStartTime = performance.now();
											emitContent(contentBuf);
											contentBuf = null;
											continue;
										}
										continue; // still only whitespace / partial tag
									}

									// If we're inside content-thinking, redirect to reasoning until close tag
									if (contentThinkingCloseTag) {
										thinkBuf += content;
										if (processThinkBuf()) continue;
										// Flush everything except the tail that could be a partial close tag
										const keep = contentThinkingCloseTag.length - 1;
										const flushLen = thinkBuf.length - keep;
										if (flushLen > 0) {
											emitReasoning(thinkBuf.slice(0, flushLen));
											thinkBuf = thinkBuf.slice(flushLen);
										}
										continue;
									}
									
									if (messageStartTime === null)
										messageStartTime = performance.now();
									
									if (reasoningStartTime !== null) 
										reasoningEndTime = performance.now();

									emitContent(content);
								}
								
								if (reasoning) {
									if (firstTokenTime === null) {
										firstTokenTime = performance.now();
										reasoningStartTime = firstTokenTime;
									}
									if (reasoningStartTime === null) {
										reasoningStartTime = performance.now();
									}
									emitReasoning(reasoning);
								}
								
								// Capture thinking_signature from anth_local provider
								const signature = choice?.delta?.thinking_signature;
								if (signature) {
									thinkingSignature = signature;
								}
								
								if (deltaToolCalls && Array.isArray(deltaToolCalls)) {
									if (firstTokenTime === null) {
										firstTokenTime = performance.now();
										messageStartTime = firstTokenTime;
									}
									for (const deltaToolCall of deltaToolCalls) {
										const index = deltaToolCall.index;

										if (!toolCallBuffers.has(index))
											toolCallBuffers.set(index, { arguments: '' });

										const buffer = toolCallBuffers.get(index)!;

										if (deltaToolCall.id)
											buffer.id = deltaToolCall.id;

										if (deltaToolCall.function?.name)
											buffer.name = deltaToolCall.function.name;

										if (typeof deltaToolCall.function?.arguments === 'string')
											buffer.arguments += deltaToolCall.function.arguments;

										// If we have all required fields, create a complete tool call
										if (typeof buffer.arguments === 'string' && buffer.arguments.length > 0) {
											const toolCall = createToolCallFromBuffer(buffer);
											if (toolCall) {
												// Check if this tool call was already added
												const existingIndex = toolCalls.findIndex(tc => tc.id === toolCall.id);

												if (existingIndex === -1) toolCalls.push(toolCall);
												else toolCalls[existingIndex] = toolCall;
											}
										}
									}
								}


								// Providers that report no reasoning split usually fold it into completion_tokens.
								if (parsed.usage) {
									const u = parsed.usage;
									const reasoning_tokens = u.completion_tokens_details?.reasoning_tokens || 0;
									// OpenRouter splits cost per phase; everything else reports a single total (if anything)
									const prompt_cost = u.cost_details?.upstream_inference_prompt_cost || 0;
									const completions_cost = u.cost_details?.upstream_inference_completions_cost || 0;

									usageData = {
										prompt_tokens: u.prompt_tokens || 0,
										message_tokens: (u.completion_tokens || 0) - reasoning_tokens,
										reasoning_tokens,
										prompt_cost,
										message_cost: prompt_cost + completions_cost > 0 ? completions_cost : (u.cost || 0),
										cached_tokens: u.prompt_tokens_details?.cached_tokens
									};
								}
							}
						} catch (e) {
							// Ignore invalid JSON
						}
					}
				}
				if (spiralDetected) break;
			}
		} finally {
			try {
				await reader.cancel();
			} catch (cancelError: any) {
				// Don't re-throw cancel errors as they're often expected during abort
			}
		}

		// Stream ended inside a content-level thinking block (tag missing or truncated):
		// emit everything still buffered rather than dropping it
		if (contentThinkingCloseTag) {
			processThinkBuf();
			if (thinkBuf) emitReasoning(thinkBuf);
		} else if (contentBuf !== null && contentBuf.trim()) {
			if (messageStartTime === null)
				messageStartTime = performance.now();
			emitContent(contentBuf);
		}
		contentBuf = null;
		thinkBuf = '';

		if (neuralwattCost !== undefined) {
			if (usageData) usageData.message_cost = neuralwattCost;
			else usageData = {
				prompt_tokens: 0, message_tokens: 0, reasoning_tokens: 0,
				prompt_cost: 0, message_cost: neuralwattCost
			};
		}

		// Flush any tool calls still buffered: providers vary on finish_reason, and a call with
		// no arguments never satisfies the in-loop completion check
		for (const [_, buf] of toolCallBuffers) {
			const id = buf.id?.replace(/[^a-zA-Z0-9_-]/g, '_');
			if (!id || toolCalls.some(tc => tc.id === id)) continue;
			const toolCall = createToolCallFromBuffer(buf);
			if (toolCall) toolCalls.push(toolCall);
			else console.warn("Failed to parse tool call arguments on flush:", buf);
		}

		const timing = buildTiming();

		if (spiralDetected) {
			setInfo?.('Stopped early: repetition loop detected');
			finishReason = 'repetition';
		}

		return { success: true, id: responseId, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, timing, usage: usageData, thinking_signature: thinkingSignature, reasoning_enc: reasoningEnc, finishReason };

	} catch (err: any) {
		// Tauri's http plugin rejects with plain strings, so never assume an Error instance
		const message = typeof err === 'string' ? err : (err?.message || String(err));
		if (err?.name === 'AbortError' || signal.aborted) {
			console.log('canceled');
			// Keep the stats we measured ourselves — the partial response is kept too
			return { success: false, error: 'aborted', timing: buildTiming(), usage: usageData };
		} else {
			console.error("Error in streaming:", err);
			// Check for attached errorData first, then fall back to error structure
			const rawError = err?.errorData?.error?.metadata?.raw ||
											err?.errorData?.metadata?.raw ||
											'';
			if (rawError) {
				try {
					const detailedMessage = JSON.parse(rawError).message || rawError;
					return { success: false, error: `${message}: ${detailedMessage}` };
				} catch {
					return { success: false, error: `${message}: ${rawError}` };
				}
			}

			return { success: false, error: message };
		}
	}
}

function ignore(model: string): string[] | undefined {
	if (/deepseek.+v3/.test(model)) return ["novita/fp8", "hyperbolic/fp8", "gmicloud/fp8"];

	if (/kimi/.test(model)) return ["deepinfra/fp4", "gmicloud/int4"];

	if (/glm-4.5/.test(model)) return ["mancer"];
	
	// if (/step-3.5/.test(model)) return ["siliconflow/fp8", "deepinfra/fp8", "parasail/fp8"];

	// if(/3.5-sonnet/.test(model)) return ["amazon-bedrock"];
}