import { isGpt56OrLater } from './types';
import type { ChatMessage, ContentPart, Message, PreserveReasoning, Provider, Role, ToolCall, ToolResult } from './types';
import { getMessageContent, getMessageThinking, getMessageThinkingSignature } from './messages';
import { getMessageFiles, getMessageImages } from './attachments';
import { fileBlock } from './fileContent';
import { resolveContent, runItem, RUN_TOOL } from './tools';

export interface PromptMessage {
	role: Role;
	content: string;
	position: number;
	/** Display label, only used by the message-list overlay. */
	name?: string;
}

/** How many trailing messages keep their reasoning under 'clipped'. */
export const CLIPPED_REASONING_MESSAGES = 5;

/** First message index whose reasoning is sent, for a post-cut message list. */
export function reasoningFromIndex(mode: PreserveReasoning | undefined, count: number): number {
	if (mode === 'off') return count; // undefined defaults to interleaved
	return mode === 'clipped' ? Math.max(0, count - CLIPPED_REASONING_MESSAGES) : 0;
}

export interface BuildRequestOptions {
	preserveReasoning?: PreserveReasoning | undefined;
	provider: Provider;
	reasoningPrefill?: { enabled: boolean; content: string } | undefined;
	prompts: PromptMessage[];
	cache: 'none' | 'smart';
	cacheLength: '5m' | '1h';
	model: string;
}

/**
 * Convert ChatMessage[] to API Message[], injecting prompts, reasoning, prefill and cache control.
 */
export function buildRequestMessages(chatMessages: ChatMessage[], opts: BuildRequestOptions): Message[] {
	const reasoningFrom = reasoningFromIndex(opts.preserveReasoning, chatMessages.length);

	const perMessage: Message[][] = chatMessages.map((msg, mi) => {
		const mmsg: Message = {
			role: msg.role,
			content: messageContent(msg),
		};

		if (mi >= reasoningFrom) {
			const think = getMessageThinking(msg);
			if (think && think.trim().length > 0) {
				if (opts.provider === 'anth_local') {
					const sig = getMessageThinkingSignature(msg);
					if (sig) {
						mmsg.thinking = think;
						mmsg.thinking_signature = sig;
					}
				} else if (opts.provider === 'or') {
					(mmsg as any).reasoning = think;
				} else {
					(mmsg as any).reasoning_content = think;
				}
			}
			// Responses API reasoning items round-trip only on OpenAI's GPT models;
			// elsewhere the field is dead weight, or a 400 on strict schemas
			if (/(?:^|[/:])gpt-/i.test(opts.model)) {
				const enc = msg.reasoning_enc?.[msg.currentVersionIndex || 0];
				if (enc?.length) mmsg.reasoning_enc = enc;
			}
		}

		const strictVersion = msg.currentVersionIndex;
		const vi = msg.currentVersionIndex || 0;
		const toolCalls = strictVersion !== undefined ? msg.tool_calls?.[strictVersion] : undefined;
		if (toolCalls) (mmsg as any).tool_calls = apiToolCalls(toolCalls);
		if (msg.tool_call_id && strictVersion !== undefined) (mmsg as any).tool_call_id = msg.tool_call_id[strictVersion];

		return [mmsg, ...toolMessages(msg.tool_calls?.[vi] ?? [], msg.tool_results?.[vi] ?? [])];
	});
	const rqstMsgs = perMessage.flat();

	// Add reasoning prefill if enabled and there's content, and last message isn't already assistant
	const rp = opts.reasoningPrefill;
	const prefilled = !!rp?.enabled && rp.content.trim() !== '' && rqstMsgs[rqstMsgs.length - 1]?.role !== 'assistant';
	if (prefilled) rqstMsgs.push({ role: 'assistant', content: rp!.content });

	// Insert prompts at their configured positions. Positions count stored
	// messages only: tool results are invisible to the count, and inserting at
	// a message's anchor (its first API message) can't split a tool block.
	const anchors: number[] = [];
	for (let i = 0, k = 0; i < chatMessages.length; i++) {
		anchors.push(k);
		k += perMessage[i].length;
	}

	const insertIndex = (position: number) => {
		const li = position < 0
			? Math.max(0, chatMessages.length + position + 1)
			: Math.min(position, chatMessages.length);
		// the prefill must stay last
		return li < chatMessages.length ? anchors[li] : rqstMsgs.length - (prefilled ? 1 : 0);
	};

	const validPrompts = opts.prompts.filter(p => p.content.trim() !== '');
	const sortedPrompts = validPrompts
		.map(p => ({ p, at: insertIndex(p.position) }))
		.toSorted((a, b) => (b.at - a.at) || (validPrompts.indexOf(b.p) - validPrompts.indexOf(a.p)));

	let firstNegativePrompt: Message | undefined;
	for (const { p, at } of sortedPrompts) {
		const message: Message = { role: p.role, content: p.content };
		rqstMsgs.splice(at, 0, message);
		if (p.position < 0) firstNegativePrompt = message;
	}

	// End-relative prompts move as the chat grows; cached prefixes must stop before them.
	const cacheBoundary = firstNegativePrompt ? rqstMsgs.indexOf(firstNegativePrompt) : rqstMsgs.length;
	const cacheIndexes = new Set<number>();
	if (cacheBoundary > 0 && rqstMsgs[0]?.role === 'system') cacheIndexes.add(0);
	const mid = Math.floor(rqstMsgs.length / 2);
	if (rqstMsgs.length >= 40 && mid > 0 && mid < cacheBoundary) cacheIndexes.add(mid);
	const nearEnd = Math.min(rqstMsgs.length - 5, cacheBoundary - 1);
	if (rqstMsgs.length > 5 && nearEnd >= 0) cacheIndexes.add(nearEnd);

	const isAnthProvider = opts.provider === 'or' || opts.provider === 'anth_local' || opts.provider === 'nano';
	const isClaudeModel = /claude|sonnet|opus|fable|mythos|haiku/i.test(opts.model);
	const isGptCacheModel = isGpt56OrLater(opts.model);
	if (opts.cache !== 'none' && isGptCacheModel) {
		const breakpoint = { mode: 'explicit' };
		for (const index of cacheIndexes) markBreakpoint(rqstMsgs[index], breakpoint);
	} else if (isAnthProvider && opts.cache !== 'none' && isClaudeModel) {
		const cc = opts.cacheLength === '1h'
			? { type: 'ephemeral', ttl: '1h' }
			: { type: 'ephemeral', ttl: '5m' };

		for (const index of cacheIndexes) markCached(rqstMsgs[index], cc);
	}

	return rqstMsgs;
}

/**
 * Stored calls as API tool calls, arguments as strings. Calls expanded from a
 * `run` call are re-nested into it at the position of its first item; the
 * rebuilt arguments are a pure function of stored data, so they're stable
 * across requests. Built explicitly so UI-only fields (e.g. _matchedLines)
 * never leak to the API.
 */
function apiToolCalls(calls: ToolCall[]) {
	const out: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
	const seen = new Set<string>();
	for (const tc of calls) {
		if (tc.parent === undefined) {
			out.push({ id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) } });
		} else if (!seen.has(tc.parent)) {
			seen.add(tc.parent);
			const items = calls.filter(c => c.parent === tc.parent).map(runItem);
			out.push({ id: tc.parent, type: 'function', function: { name: RUN_TOOL, arguments: JSON.stringify({ calls: items }) } });
		}
	}
	return out;
}

/**
 * One tool message per result, except results of a nested `run`: those merge
 * into one message for the `run` call, each under an `[i] tool` header.
 */
function toolMessages(calls: ToolCall[], results: ToolResult[]): Message[] {
	const parentOf = new Map(calls.map(c => [c.id, c.parent]));
	const out: Message[] = [];
	const seen = new Set<string>();
	for (const tr of results) {
		const parent = parentOf.get(tr.tool_call_id);
		if (parent === undefined) {
			out.push({ role: 'tool', content: withImages(resolveContent(tr), tr.data?.images), tool_call_id: tr.tool_call_id, name: tr.name });
			continue;
		}
		if (seen.has(parent)) continue;
		seen.add(parent);
		const entries = calls.filter(c => c.parent === parent).map((c, i) => {
			const r = results.find(r => r.tool_call_id === c.id);
			return { label: `[${i}] ${c.function.name}`, text: r ? resolveContent(r) : '', images: r?.data?.images as string[] | undefined };
		});
		out.push({ role: 'tool', content: groupContent(entries), tool_call_id: parent, name: RUN_TOOL });
	}
	return out;
}

function groupContent(entries: { label: string; text: string; images: string[] | undefined }[]): string | ContentPart[] {
	const text = entries.map(e => `${e.label}\n${e.text}`).join('\n\n');
	if (!entries.some(e => e.images?.length)) return text;

	const parts: ContentPart[] = [{ type: 'text', text }];
	for (const e of entries) {
		e.images?.forEach((url, i) => {
			parts.push({ type: 'text', text: e.images!.length > 1 ? `${e.label} image ${i + 1}:` : `${e.label}:` });
			parts.push({ type: 'image_url', image_url: { url } });
		});
	}
	return parts;
}

/**
 * Text plus the attachments of the current version. File snapshots lead as `<file>`
 * blocks; images come after the text — providers parse the multi-part content in order
 * and recommend leading with the prompt.
 */
function messageContent(msg: ChatMessage): string | ContentPart[] {
	const blocks = getMessageFiles(msg)?.map(file => fileBlock(file)) ?? [];
	const text = [...blocks, getMessageContent(msg)].filter(Boolean).join('\n\n');
	return withImages(text, getMessageImages(msg));
}

function withImages(text: string, images: string[] | undefined): string | ContentPart[] {
	if (!images?.length) return text;

	const parts: ContentPart[] = text ? [{ type: 'text', text }] : [];
	images.forEach((url, i) => {
		// Labels let the model refer to images by name (recommended for multi-image requests);
		if (images.length > 1) parts.push({ type: 'text', text: `Image ${i + 1}:` });
		parts.push({ type: 'image_url', image_url: { url } });
	});
	return parts;
}

/** Mark a message as an Anthropic cache breakpoint, on its last content block. */
function markCached(msg: Message | undefined, cc: object): void {
	if (!msg) return;
	if (typeof msg.content === 'string') {
		msg.content = [{ type: 'text', text: msg.content, cache_control: cc }] as any;
		return;
	}
	const last = msg.content[msg.content.length - 1];
	if (last) (last as any).cache_control = cc;
}

/** Mark a message as an OpenAI cache breakpoint, on its last content block. */
function markBreakpoint(msg: Message | undefined, breakpoint: object): void {
	if (!msg) return;
	if (typeof msg.content === 'string') {
		msg.content = [{ type: 'text', text: msg.content, prompt_cache_breakpoint: breakpoint }] as any;
		return;
	}
	const text = [...msg.content].reverse().find(part => part.type === 'text');
	if (text) (text as any).prompt_cache_breakpoint = breakpoint;
}
