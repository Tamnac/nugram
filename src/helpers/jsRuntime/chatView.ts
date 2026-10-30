/**
 * What run_js's `chat()` returns: the conversation as plain data, current
 * versions only. Messages before the cut aren't in the model's context (to it,
 * the chat starts at the cut), so they are only included on request, and marked.
 */
import type { ChatMessage, Role } from '../types';
import { getMessageContent, getMessageThinking, getMessageToolCalls, getMessageToolResults } from '../messages';
import { resolveContent } from '../tools/registry';

export interface ChatViewMessage {
	role: Role;
	text: string;
	thinking?: string;
	calls?: { name: string; args: unknown; text?: string }[];
	hidden?: true;
}

export function chatView(messages: ChatMessage[], cut: number, opts: { hidden?: boolean } = {}): ChatViewMessage[] {
	const start = opts.hidden ? 0 : cut;
	return messages.slice(start).map((msg, i) => {
		const thinking = getMessageThinking(msg);
		const results = getMessageToolResults(msg) ?? [];
		const calls = getMessageToolCalls(msg)?.map(call => {
			const result = results.find(r => r.tool_call_id === call.id);
			const settled = result && (result.content !== undefined || (result.data !== undefined && !result.data.running));
			return { name: call.function.name, args: call.function.arguments, ...(settled && { text: resolveContent(result) }) };
		});
		return {
			role: msg.role,
			text: getMessageContent(msg),
			...(thinking && { thinking }),
			...(calls?.length && { calls }),
			...(start + i < cut && { hidden: true as const }),
		};
	});
}
