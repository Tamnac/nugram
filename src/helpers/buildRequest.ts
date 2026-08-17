import type { ChatMessage, ContentPart, Message, Provider, Role } from './types';
import { getMessageContent, getMessageThinking, getMessageThinkingSignature } from './messages';
import { getMessageFiles, getMessageImages } from './attachments';
import { fileBlock } from './fileContent';
import { resolveContent } from './tools';

export interface PromptMessage {
	role: Role;
	content: string;
	position: number;
}

export interface BuildRequestOptions {
	preserveReasoning?: 'off' | 'interleaved' | 'full' | undefined;
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
	const rqstMsgs: Message[] = chatMessages.flatMap(msg => {
		const mmsg: Message = {
			role: msg.role,
			content: messageContent(msg),
		};

		const pr = opts.preserveReasoning;
		if (pr && pr !== 'off') {
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
		}

		const strictVersion = msg.currentVersionIndex;
		// dumbasses need args to be strings
		if (msg.tool_calls && strictVersion !== undefined && msg.tool_calls[strictVersion]) {
			const toolCalls = msg.tool_calls[msg.currentVersionIndex || 0];
			// Build explicitly so UI-only fields (e.g. _matchedLines) never leak to the API
			(mmsg as any).tool_calls = toolCalls.map(tc => ({
				id: tc.id,
				type: tc.type,
				function: {
					name: tc.function.name,
					arguments: JSON.stringify(tc.function.arguments)
				}
			}));
		}
		if (msg.tool_call_id && strictVersion !== undefined) (mmsg as any).tool_call_id = msg.tool_call_id[strictVersion];

		const apiMessages: Message[] = [mmsg];

		// Inject tool results for the current version
		const vi = msg.currentVersionIndex || 0;
		if (msg.tool_results?.[vi]) {
			for (const tr of msg.tool_results[vi]) {
				apiMessages.push({
					role: 'tool',
					content: withImages(resolveContent(tr), tr.data?.images),
					tool_call_id: tr.tool_call_id,
					name: tr.name
				});
			}
		}

		return apiMessages;
	});

	// Add reasoning prefill if enabled and there's content, and last message isn't already assistant
	if (opts.reasoningPrefill?.enabled && opts.reasoningPrefill.content.trim() !== '' &&
		rqstMsgs[rqstMsgs.length - 1]?.role !== 'assistant') {
		rqstMsgs.push({ role: 'assistant', content: opts.reasoningPrefill.content });
	}

	// Insert prompts at their configured positions
	const validPrompts = opts.prompts.filter(p => p.content.trim() !== '');
	const ng = (n: number) => n < 0 ? rqstMsgs.length + n : n;
	const sortedPrompts = validPrompts.toSorted((a, b) => {
		const diff = ng(b.position) - ng(a.position);
		if (diff !== 0) return diff;
		return validPrompts.indexOf(b) - validPrompts.indexOf(a);
	});

	for (const prompt of sortedPrompts) {
		let insertIndex = prompt.position < 0
			? Math.max(0, rqstMsgs.length + prompt.position + 1)
			: Math.min(prompt.position, rqstMsgs.length);

		// Don't insert inside an assistant(tool_calls) -> tool_result block;
		while (insertIndex > 0 && (rqstMsgs[insertIndex]?.role === 'tool' || (rqstMsgs[insertIndex] as any)?.tool_calls))
			insertIndex--;

		rqstMsgs.splice(insertIndex, 0, { role: prompt.role, content: prompt.content });
	}

	// Apply cache control for Anthropic-compatible providers
	const isAnthProvider = opts.provider === 'or' || opts.provider === 'anth_local' || opts.provider === 'nano';
	const isClaudeModel = /claude|sonnet|opus|fable|mythos|haiku/i.test(opts.model);
	if (isAnthProvider && opts.cache !== 'none' && isClaudeModel) {
		const cc = opts.cacheLength === '5m'
			? { type: 'ephemeral', ttl: '5m' }
			: { type: 'ephemeral', ttl: '1h' };

		if (rqstMsgs[0]?.role === 'system') markCached(rqstMsgs[0], cc);

		const mid = Math.floor(rqstMsgs.length / 2);
		if (rqstMsgs.length >= 40 && mid > 0) markCached(rqstMsgs[mid], cc);

		// anthropic's 'automatic' caching doesn't work as expected.
		// expected: will check for any prefix in last 20 blocks
		// actual: just sets a cache_control on last message that is cacheable (for regular text, literally last message). Change a message before that, and your cache goes, regardless of of whether is's < 20
		const nearEnd = rqstMsgs.length - 5;
		if (nearEnd > 0) markCached(rqstMsgs[nearEnd], cc);
	}

	return rqstMsgs;
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
	for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
	return parts;
}

/** Mark a message as a cache breakpoint, on its last content block. */
function markCached(msg: Message | undefined, cc: object): void {
	if (!msg) return;
	if (typeof msg.content === 'string') {
		msg.content = [{ type: 'text', text: msg.content, cache_control: cc }] as any;
		return;
	}
	const last = msg.content[msg.content.length - 1];
	if (last) (last as any).cache_control = cc;
}
