import type { ChatMessage, ChatMeta, MessageTiming, ToolCall, ToolResult } from './types';
import { executionSteps, isPending, resolveContent, RUN_JS_TOOL } from './tools';
import type { UsageData } from './streaming';
import { estTokensFromLength } from './tokens';

export interface ScopedStats {
	totalCost: number;
	pricedRequests: number;
	tokenRequests: number;
	promptTokens: number;
	messageTokens: number;
	reasoningTokens: number;
	/** Cached tokens, summed over responses that report cache data */
	cachedTokens: number;
	/** Prompt tokens of cache-reporting responses only (hit-rate denominator) */
	cachePromptTokens: number;
	cacheRequests: number;
}

export interface ChatStats {
	/** Totals across every version of every message */
	all: ScopedStats;
	/** Totals for only the currently-active version of each message */
	current: ScopedStats;
	totalRequests: number;
	totalMessages: number;
	totalVersions: number;
	models: string[];
}

function emptyScope(): ScopedStats {
	return { totalCost: 0, pricedRequests: 0, tokenRequests: 0, promptTokens: 0, messageTokens: 0, reasoningTokens: 0, cachedTokens: 0, cachePromptTokens: 0, cacheRequests: 0 };
}

function addUsage(scope: ScopedStats, usage: UsageData) {
	const p = usage.prompt_tokens || 0;
	const m = usage.message_tokens || 0;
	const r = usage.reasoning_tokens || 0;
	scope.promptTokens += p;
	scope.messageTokens += m;
	scope.reasoningTokens += r;
	if (p + m + r > 0) scope.tokenRequests++;
	if (usage.cached_tokens !== undefined) {
		scope.cachedTokens += usage.cached_tokens;
		scope.cachePromptTokens += p;
		scope.cacheRequests++;
	}
	const cost = (usage.prompt_cost || 0) + (usage.message_cost || 0);
	scope.totalCost += cost;
	if (cost > 0) scope.pricedRequests++;
}

export function computeChatStats(messages: ChatMessage[]): ChatStats {
	const all = emptyScope();
	const current = emptyScope();
	let totalRequests = 0;
	let totalMessages = 0;
	let totalVersions = 0;
	const modelSet = new Set<string>();

	for (const msg of messages) {
		const versions = getMessageVersionCount(msg);
		totalMessages++;
		totalVersions += versions;

		if (msg.role === 'assistant') {
			totalRequests++;
			const vi = msg.currentVersionIndex || 0;
			if (msg.usage) {
				for (let i = 0; i < msg.usage.length; i++) {
					const usage = msg.usage[i];
					if (!usage) continue;
					addUsage(all, usage);
					if (i === vi) addUsage(current, usage);
				}
			}
		}

		if (msg.models) {
			for (const m of msg.models) if (m) modelSet.add(m);
		}
	}

	return {
		all,
		current,
		totalRequests,
		totalMessages,
		totalVersions,
		models: Array.from(modelSet).sort(),
	};
}

export function getMessageContent(message: ChatMessage): string {
	const index = message.currentVersionIndex || 0;
	return message.content[index] || '';
}

export function getMessageThinking(message: ChatMessage): string | undefined {
	if (!message.thinking) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.thinking[index]?.trimStart();
}

export function getMessageThinkingSignature(message: ChatMessage): string | undefined {
	if (!message.thinking_signature) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.thinking_signature[index];
}

export function getMessageToolCalls(message: ChatMessage): ToolCall[] | undefined {
	if (!message.tool_calls) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.tool_calls[index];
}

export function getMessageToolResults(message: ChatMessage): ToolResult[] | undefined {
	if (!message.tool_results) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.tool_results[index];
}

function argumentText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') return Object.values(value).map(argumentText).join('\n');
	return value === undefined || value === null ? '' : String(value);
}

/** Searchable text of one version's tool calls (argument values) and results, as shown in the tool block. */
export function getToolTexts(message: ChatMessage, version = message.currentVersionIndex || 0): string[] {
	return [
		...(message.tool_calls?.[version] ?? []).map(call => argumentText(call.function.arguments)),
		...(message.tool_results?.[version] ?? []).map(resolveContent),
	];
}

export function getMessageVersionCount(message: ChatMessage): number {
	return message.content.length;
}

/**
 * Char-count of one message's current version as sent: content, tool calls/results, file snapshots, images, reasoning. Reasoning varies by
 * provider/mode, so full as an upper bound, +5 overhead for chat template.
 */
export function messageChars(msg: ChatMessage, opts?: {
	reasoning?: boolean | undefined;
	imageChars?: ((refs: string[] | undefined) => number) | undefined;
}): number {
	const vi = msg.currentVersionIndex || 0;
	let len = (msg.content?.[vi] ?? '').length + 5;
	
	for (const tc of msg.tool_calls?.[vi] ?? [])
		len += tc.function.name.length + JSON.stringify(tc.function.arguments).length;

	for (const tr of msg.tool_results?.[vi] ?? [])
		len += tr.name.length + resolveContent(tr).length + (opts?.imageChars?.(tr.data?.images) ?? 0);

	if (opts?.reasoning) 
		len += msg.thinking?.[vi]?.length ?? 0;

	len += opts?.imageChars?.(msg.images?.[vi]) ?? 0;

	for (const file of msg.files?.[vi] ?? []) 
		len += file.chars;

	return len;
}

/**
 * Output tokens per second of the current version, over the streaming phase (first token to
 * end = reasoning + message time). Token source, in order: the provider's counts, the estimate
 * stored at stream end, an estimate from the stored text (messages from before it was stored).
 */
export function messageTps(msg: ChatMessage): number | undefined {
	const vi = msg.currentVersionIndex || 0;
	const timing = msg.timing?.[vi];
	const seconds = ((timing?.reasoning_time ?? 0) + (timing?.message_time ?? 0)) / 1000;
	if (seconds <= 0) return undefined;

	const usage = msg.usage?.[vi];
	let tokens = usage ? usage.message_tokens + usage.reasoning_tokens : 0;
	tokens ||= timing?.estimated_tokens ?? 0;
	if (tokens <= 0) {
		let chars = (msg.content[vi] ?? '').length + (msg.thinking?.[vi]?.length ?? 0);
		for (const tc of msg.tool_calls?.[vi] ?? [])
			chars += tc.function.name.length + JSON.stringify(tc.function.arguments).length;
		tokens = estTokensFromLength(chars, msg.models?.[vi] ?? '');
	}
	return tokens > 0 ? tokens / seconds : undefined;
}

export function insertAtIndex<T>(arr: T[] | undefined, index: number, value: T, defaultValue: T): T[] {
	const result: T[] = new Array(index + 1);
	for (let i = 0; i < index; i++)
		result[i] = arr?.[i] ?? defaultValue;
	result[index] = value;
	return result;
}

export function addMessageVersion(
	message: ChatMessage,
	updates: {
		content: string;
		thinking?: string;
		model?: string;
		provider?: string;
		id?: string;
		tool_call_id?: string;
		tool_calls?: ToolCall[];
		timing?: MessageTiming;
		usage?: UsageData;
	}
): ChatMessage {
	const idx = message.content.length;

	return {
		...message,
		content: [...message.content, updates.content],
		thinking: updates.thinking !== undefined ? insertAtIndex(message.thinking, idx, updates.thinking, '') : message.thinking,
		ids: updates.id !== undefined ? insertAtIndex(message.ids, idx, updates.id, '') : message.ids,
		models: updates.model !== undefined ? insertAtIndex(message.models, idx, updates.model.replace(/^accounts\/fireworks\/\w+\//, ''), '') : message.models,
		providers: updates.provider !== undefined ? insertAtIndex(message.providers, idx, updates.provider, '') : message.providers,
		tool_call_id: updates.tool_call_id !== undefined ? insertAtIndex(message.tool_call_id, idx, updates.tool_call_id, '') : message.tool_call_id,
		tool_calls: updates.tool_calls !== undefined ? insertAtIndex(message.tool_calls, idx, updates.tool_calls, []) : message.tool_calls,
		timing: insertAtIndex(message.timing, idx, { ...updates.timing, createdAt: Date.now() }, {}),
		usage: updates.usage !== undefined ? insertAtIndex(message.usage, idx, updates.usage, { prompt_tokens: 0, message_tokens: 0, reasoning_tokens: 0, prompt_cost: 0, message_cost: 0 }) : message.usage,
		currentVersionIndex: idx,
	};
}

/**
 * Settle tool calls an interrupted run left hanging (app closed mid-call or during
 * a permission prompt). Results are pre-allocated as placeholders before a call
 * runs, so an interrupted call is left with a pending (data- and content-less)
 * result, not a missing one.
 */
export function repairOrphanedToolCalls(msgs: ChatMessage[]): boolean {
	let repaired = false;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const msg = msgs[i];

		if (!msg.tool_calls) continue;

		for (let v = 0; v < msg.tool_calls.length; v++) {
			const calls = msg.tool_calls[v];

			if (!calls?.length) continue;

			// calls where a shell result exists but has no data/are pending
			const results = msg.tool_results?.[v] || [];
			const repairedResults = results.map(r => isPending(r) ? interruptedResult(r) : r);
			const resultIds = new Set(repairedResults.map(r => r.tool_call_id));

			// tools for which not even a shell exists
			for (const tc of calls) 
				if (!resultIds.has(tc.id)) 
					repairedResults.push(interruptedResult({ tool_call_id: tc.id, name: tc.function.name }));

			if (repairedResults.length === results.length 
				&& repairedResults.every((r, j) => r === results[j])) continue;

			if (!msg.tool_results) msg.tool_results = [];

			while (msg.tool_results.length <= v) msg.tool_results.push([]);

			msg.tool_results[v] = repairedResults;
			repaired = true;
		}
	}
	return repaired;
}

/** Turns an incomplete result into a failed call with a descriptive error */
function interruptedResult(result: ToolResult): ToolResult {
	return { ...result, data: { ok: false, error: 'Tool call failed: application closed unexpectedly' } };
}

/**
 * Snapshot id saved by the last run_js run in the visible history (current
 * versions, in execution order). The run_js Worker is rebuilt from it whenever
 * it differs from what the live Worker holds; see helpers/jsRuntime/host.ts.
 */
export function latestJsState(messages: ChatMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const vi = msg.currentVersionIndex || 0;
		const results = msg.tool_results?.[vi];
		if (!results?.length) continue;
		const order = executionSteps(msg.tool_calls?.[vi] ?? []).flat();
		for (let j = order.length - 1; j >= 0; j--) {
			if (order[j].function.name !== RUN_JS_TOOL) continue;
			const state = results.find(r => r.tool_call_id === order[j].id)?.data?.state;
			if (typeof state === 'string') return state;
		}
	}
	return undefined;
}
