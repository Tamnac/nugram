/**
 * Auto-compaction: in loop mode, past a threshold, model summarizes the session (user-editable prompt) and lists files to auto-read. The session makes matching read_file calls, moves the cut to just before the summary, and resumes the loop.
 *  Pure functions only; the flow is in session.ts (maybeAutoCompact).
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

/** Messages kept before the compaction summary, so the model retains the session's trajectory. */
export const COMPACT_LOOKBACK = 4;

export const COMPACT_CONTINUE_NOTICE = '[Automated Response] Context compacted, Continue as before.';

export const DEFAULT_COMPACT_PROMPT = `[Automated Request] This session's context has grown too large and must be compacted before work continues.

Write a comprehensive summary of the session so far — it will permanently replace the earlier conversation. Include:
- the user's goals, requirements and explicit preferences
- decisions made and their rationale
- the current state of the work: files created or modified and their relevant contents/structure
- errors encountered and how they were resolved
- the immediate next steps

Be dense and specific; anything you omit is lost.`;

/** Fixed format spec appended after the user-editable prompt — the auto-reads depend on it. */
export const READ_FILES_SPEC = `After the end, output a code block listing files that must be re-read to seamlessly continue work. Usually files critical to current understanding or being edited. Will automatically be re-read. This section may overlap with previous. Format: one per line, optionally followed by \` | start:end\` for a line range:

\`\`\`read-files
src/file1.ts | 100:250
docs/main/sessions.md
\`\`\`
`;

/** The user-visible prompt plus the fixed structured-output spec (not user-editable). */
export function fullCompactPrompt(prompt: string): string {
	return `${prompt.trimEnd()}\n\n${READ_FILES_SPEC}`;
}

export const DEFAULT_COMPACT_SETTINGS: CompactSettings = { tokens: 150_000, prompt: DEFAULT_COMPACT_PROMPT };

/** A destructive compaction needs a substantive handoff; greeting-length output means something broke. */
export const MIN_SUMMARY_CHARS = 200;

export function isAdequateSummary(text: string): boolean {
	return text.trim().length >= MIN_SUMMARY_CHARS;
}

export interface ReadSpec {
	path: string;
	range?: string;
}

const FENCE_RE = /```read[-_]files\s*\n([\s\S]*?)```/gi;
const TAG_RE = /<read[-_]files>([\s\S]*?)<\/read[-_]files>/i;
// Split on the LAST pipe: paths may legitimately contain one, the range never does.
const splitLine = (line: string): ReadSpec => {
	const pipe = line.lastIndexOf('|');
	if (pipe === -1) return { path: line };
	const range = line.slice(pipe + 1).trim();
	return range ? { path: line.slice(0, pipe).trim(), range } : { path: line.slice(0, pipe).trim() };
};

/** Extract the read-files block of a compaction response into read_file args. */
export function parseReadFiles(text: string): ReadSpec[] {
	// Last block
	const body = [...text.matchAll(FENCE_RE)].at(-1)?.[1] ?? TAG_RE.exec(text)?.[1];
	if (!body) return [];
	const specs: ReadSpec[] = [];
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const spec = splitLine(line.replace(/^["']|["']$/g, '')); // strip surrounding quotes
		// Syntactic junk
		if (!spec.path || spec.path.includes('://') || /[*?[\]]/.test(spec.path)) continue;
		if (spec.range && !/^-?\d*:-?\d*$/.test(spec.range)) delete spec.range;
		if (specs.some(s => s.path === spec.path && s.range === spec.range)) continue;
		specs.push(spec);
	}
	return specs;
}

/**
 * Estimated tokens of a post-cut message slice. Built from the last provider-reported usage. 
 * Can overestimate if the cut moved after that request.
 */
export function estimateContextTokens(messages: ChatMessage[], model: string, opts?: {
	reasoning?: PreserveReasoning | undefined;
	/** Prompt injections + tool defs, only needed when no exact base is found. */
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
