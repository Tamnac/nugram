/**
 * Auto-compaction: in loop mode, when the estimated context passes a token threshold, the session adds a user-editable prompt and the model answers it as in any other turn (tools included, so it can re-read files itself). The summary is checked and the cut moves to COMPACT_LOOKBACK messages before it.
 * Pure functions only; the flow is in session.ts (maybeAutoCompact).
 */

import type { ChatMessage, PreserveReasoning } from './types';
import { estTokensFromLength, estImageChars } from './tokens';
import { messageChars } from './messages';
import { reasoningFromIndex } from './buildRequest';
import { imageDims } from './attachments';

export interface CompactSettings {
	/** Estimated context tokens at which auto-compaction triggers. */
	tokens: number;
	/** User message sent to elicit the compaction summary (@@macros expanded). */
	prompt: string;
}

/** Number of messages before the compaction summary that stay in context, so the model still sees the latest exchanges. */
export const COMPACT_LOOKBACK = 4;

export const DEFAULT_COMPACT_PROMPT = `[Automated Request] This session's context has grown too large and must be compacted before work continues.

Write a comprehensive summary of the session so far — it will permanently replace the earlier conversation. Include:
- the user's goals, requirements and explicit preferences
- decisions made and their rationale
- the current state of the work: files created or modified and their relevant contents/structure
- errors encountered and how they were resolved
- the immediate next steps

Be dense and specific; anything you omit is lost.

In this message, re-read the file sections you strictly need to continue the work (files being edited or needed to understand the current state). Keep this short: every file adds to the context. Relevant but not immediately needed files can just be listed by name in the summary.`;

export const DEFAULT_COMPACT_SETTINGS: CompactSettings = { tokens: 150_000, prompt: DEFAULT_COMPACT_PROMPT };

/** Compaction hides the earlier messages, so a shorter summary counts as a failure. */
export const MIN_SUMMARY_CHARS = 200;

export function isAdequateSummary(text: string): boolean {
	return text.trim().length >= MIN_SUMMARY_CHARS;
}

/**
 * Estimated tokens of a post-cut message slice. Based on the last provider-reported usage.
 * Can overestimate if the cut moved after that request.
 */
export function estimateContextTokens(messages: ChatMessage[], model: string, opts?: {
	reasoning?: PreserveReasoning | undefined;
	/** Chars of prompt injections and tool definitions; only used when no message has provider-reported usage. */
	extraChars?: number;
}): number {
	const imageChars = (refs: string[] | undefined) =>
		(refs ?? []).reduce((sum, ref) => sum + estImageChars(imageDims(ref), model), 0);
	const reasoningFrom = reasoningFromIndex(opts?.reasoning, messages.length);
	const charsOf = (m: ChatMessage, i: number) => messageChars(m, { reasoning: i >= reasoningFrom, imageChars });

	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== 'assistant') continue;
		const usage = m.usage?.[m.currentVersionIndex || 0];
		if (!usage?.prompt_tokens) continue;
		let chars = 0;
		for (let j = i + 1; j < messages.length; j++) chars += charsOf(messages[j], j);
		return usage.prompt_tokens + estTokensFromLength(chars, model);
	}

	let chars = opts?.extraChars ?? 0;
	for (let i = 0; i < messages.length; i++) chars += charsOf(messages[i], i);
	return estTokensFromLength(chars, model);
}
