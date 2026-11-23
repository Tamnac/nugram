/**
 * What run_js's `chat()` returns: the conversation as plain data, current
 * versions only. Messages before the cut or folded aren't in the model's context,
 * so they are only included on request, and marked. `index` is the message's place
 * in the whole chat, which `fold` takes. It differs from the array position once
 * messages are hidden, so code must use `index`.
 */
import type { Role, ToolResult } from '../types';
import type { ChatSnapshot } from '../tools/types';
import { hiddenRanges } from '../folds';
import { getMessageContent, getMessageThinking, getMessageToolCalls, getMessageToolResults } from '../messages';
import { resolveContent, RUN_JS_TOOL } from '../tools/registry';
import type { RunJsLogEntry } from '../tools/runJs';

export interface ChatViewCall {
	name: string;
	args: unknown;
	text?: string;
	/** run_js only: the calls the snippet made. */
	calls?: ChatViewCall[];
}

export interface ChatViewMessage {
	index: number;
	role: Role;
	text: string;
	thinking?: string;
	calls?: ChatViewCall[];
	hidden?: true;
}

const isSettled = (result?: ToolResult) =>
	!!result && (result.content !== undefined || (result.data !== undefined && !result.data.running));

function nestedCalls(result?: ToolResult): ChatViewCall[] {
	const log: RunJsLogEntry[] = Array.isArray(result?.data?.log) ? result.data.log : [];
	return log.flatMap(entry => 'call' in entry
		? [{ name: entry.call.function.name, args: entry.call.function.arguments, ...(isSettled(entry.result) && { text: resolveContent(entry.result!) }) }]
		: []);
}

export function chatView({ messages, cut, folds }: ChatSnapshot, opts: { hidden?: boolean } = {}): ChatViewMessage[] {
	const hidden = new Set<number>();
	for (const [s, e] of hiddenRanges(messages.length, cut, folds)) for (let i = s; i < e; i++) hidden.add(i);
	return messages.flatMap((msg, index) => {
		if (!opts.hidden && hidden.has(index)) return [];
		const thinking = getMessageThinking(msg);
		const results = getMessageToolResults(msg) ?? [];
		const calls = getMessageToolCalls(msg)?.map(call => {
			const result = results.find(r => r.tool_call_id === call.id);
			const nested = call.function.name === RUN_JS_TOOL ? nestedCalls(result) : [];
			return {
				name: call.function.name,
				args: call.function.arguments,
				...(isSettled(result) && { text: resolveContent(result!) }),
				...(nested.length && { calls: nested }),
			};
		});
		return [{
			index,
			role: msg.role,
			text: getMessageContent(msg),
			...(thinking && { thinking }),
			...(calls?.length && { calls }),
			...(hidden.has(index) && { hidden: true as const }),
		}];
	});
}
