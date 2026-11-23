import { isTauri } from '../platform';
import { thinkingParser, handleLinkClick } from '../markdown';
import type { ToolModule } from './types';

const DESCRIPTION = [
	'Fold (aka compact/summarize) a span of this conversation out of your context, leaving a summary. Use it when an episode is done (a debugging or build loop, a todo step, a tangent) and its details are no longer needed word for word.',
	'Find the span with run_js `chat()`: use the `index` of each message, never its position in the returned array. Positions shift once messages are hidden (cut or folded); indices do not. Fold from where the episode started to its end.',
	'Write the note so you can continue without the folded messages: what you did, where (files, links), what changed, information, constraints and caveats that still apply, decisions, problems solved, exact strings you will need, and how to continue. The note is not returned to you: you only see the string you wrote in the run_js code, so write it inline instead of in a variable.',
	'Folded messages can be found with `chat({ hidden: true })` if needed.',
].join(' ');

export const foldTool: ToolModule = {
	returns: '{ from: number, to: number }',
	definition: {
		type: 'function',
		function: {
			name: 'fold',
			description: DESCRIPTION,
			parameters: {
				type: 'object',
				properties: {
					from: { type: ['integer', 'object'], description: 'Index of the first message to fold, or the message object from `chat()`' },
					note: { type: 'string', description: 'What replaces the span in your context' },
					to: { type: ['integer', 'object'], description: 'Index (or message object) of the last message to fold. Default: the message before this one' },
				},
				required: ['from', 'note'],
			},
		},
	},

	available: isTauri,
	requires: ['run_js'],

	async execute(call, ctx) {
		if (!ctx.fold) return { ok: false, error: 'fold is not available here (desktop only, and not in sub-agents)' };
		const fold = ctx.fold(call.id, (call.function.arguments ?? {}) as Record<string, unknown>);
		if ('error' in fold) return { ok: false, error: fold.error };
		return { from: fold.start, to: fold.end - 1 };
	},

	format: data => `Folded messages ${data.from}–${data.to}. They are no longer in your context and your note replaces them; \`chat({ hidden: true })\` still returns them.`,

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>fold <code>{args.from ?? '?'}–{args.to ?? '…'}</code></span>;
	},

	Args: props => {
		const args = props.call.function.arguments as any;
		return typeof args.note === 'string'
			? <div class='toolArgEdit'><div class='toolArgContent' innerHTML={thinkingParser.render(args.note)} onClick={handleLinkClick} /></div>
			: null;
	},
};
