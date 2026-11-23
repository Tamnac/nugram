/**
 * Folds: spans after the cut that the model replaced with a note (the `fold` tool).
 * They are stored in chat state next to the cut, and the folded messages stay in the
 * chat, so unfolding only removes the fold entry. `sentIndices` decides what a request contains.
 * Design: mds/folding.md
 */
import type { ChatMessage, Fold } from './types';

/** First sent index: the cut when it falls inside the chat, else 0. */
export const cutStart = (cut: number, length: number) => cut > 0 && cut < length ? cut : 0;

/**
 * Disjoint, sorted `[start, end)` ranges left out of requests: everything before the cut,
 * and folded spans. A fold only applies to requests after its call, so only folds whose
 * `at` is below `foldsBefore` are included.
 */
export function hiddenRanges(length: number, cut: number, folds: readonly Fold[] = [], foldsBefore = length): [number, number][] {
	const ranges: [number, number][] = [];
	const start = cutStart(cut, length);
	if (start > 0) ranges.push([0, start]);
	for (const f of folds.filter(f => f.at < foldsBefore).sort((a, b) => a.start - b.start)) {
		const s = Math.max(f.start, 0), e = Math.min(f.end, length);
		if (s >= e) continue;
		const last = ranges.at(-1);
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else ranges.push([s, e]);
	}
	return ranges;
}

/** Indices of the messages before `end` that requests include, in order. */
export function sentIndices(length: number, cut: number, folds?: readonly Fold[], end = length): number[] {
	const out: number[] = [];
	let i = 0;
	for (const [s, e] of hiddenRanges(length, cut, folds, end)) {
		for (; i < Math.min(s, end); i++) out.push(i);
		i = Math.max(i, e);
	}
	for (; i < end; i++) out.push(i);
	return out;
}

export const sentMessages = <T>(messages: T[], cut: number, folds?: readonly Fold[], end = messages.length): T[] =>
	sentIndices(messages.length, cut, folds, end).map(i => messages[i]!);

/** Returns cut and folds after inserting (delta =  1) or deleting (delta = -1) the message at `index`.
 * Inserting at a boundary does it outside the fold.
 * Deleting the message that created a fold deletes the fold too. Zero length folds are also deleted.
 */
export function spliceIndices(cut: number, folds: readonly Fold[], index: number, delta: 1 | -1): { cut: number; folds: Fold[] } {
	const shift = (x: number, inclusive = false) => index < x || (delta > 0 && inclusive && index === x) ? x + delta : x;
	return {
		cut: cut > 0 ? shift(cut) : cut,
		folds: folds.flatMap(f => {
			const start = shift(f.start, true), end = shift(f.end);
			if (start >= end || (delta < 0 && index === f.at)) return [];
			return [{ ...f, start, end, at: shift(f.at, true) }];
		}),
	};
}

/** Folds re-indexed for a copy of messages `[from, to)`, keeping those whose span and fold call are both inside. */
export function foldsWithin(folds: readonly Fold[], from: number, to: number): Fold[] {
	return folds
		.filter(f => f.start >= from && f.at < to)
		.map(f => ({ ...f, start: f.start - from, end: f.end - from, at: f.at - from }));
}

export interface FoldDisplay {
	/** Open folds starting at this message, outermost first: each gets a header above it. */
	headers: Fold[];
	/** A closed fold starting here: the message shows as its collapsed row. */
	collapsed?: Fold | undefined;
	/** Inside a closed fold that starts earlier: the message is not shown. */
	hidden: boolean;
	/** Inside any fold, open or not. */
	folded: boolean;
}

export function foldDisplay(folds: readonly Fold[], isOpen: (id: string) => boolean, i: number): FoldDisplay {
	const containing = folds.filter(f => f.start <= i && i < f.end).sort((a, b) => (a.start - b.start) || (b.end - a.end));
	const headers: Fold[] = [];
	for (const f of containing) {
		if (!isOpen(f.id)) return { headers, collapsed: f.start === i ? f : undefined, hidden: f.start !== i, folded: true };
		if (f.start === i) headers.push(f);
	}
	return { headers, hidden: false, folded: containing.length > 0 };
}

/** The closed folds not inside another closed fold, sorted: each shows as one row and hides the rest of its span. */
export function collapsedFolds(folds: readonly Fold[], isOpen: (id: string) => boolean): Fold[] {
	const out: Fold[] = [];
	for (const f of folds.filter(f => !isOpen(f.id)).sort((a, b) => (a.start - b.start) || (b.end - a.end))) {
		const last = out.at(-1);
		if (!last || f.start >= last.end) out.push(f);
	}
	return out;
}

/** Id of the fold that stands for the messages before the cut in the message list. */
export const CUT_FOLD_ID = 'cut';

/**
 * Folds as the message list shows them: the cut as a fold over the messages before it except
 * the first, which stays visible, and folds that reach across the cut trimmed to start at it
 * (closed folds must not overlap partially).
 */
export function displayFolds(cut: number, length: number, folds: readonly Fold[]): Fold[] {
	const start = cutStart(cut, length);
	if (start < 2) return [...folds];
	return [
		{ id: CUT_FOLD_ID, start: 1, end: start, at: -1, note: '' },
		...folds.map(f => f.start < start && f.end > start ? { ...f, start } : f),
	];
}

/** A message index, or a message object from `chat()` (its `index`). */
const indexOf = (v: unknown) => typeof v === 'object' && v !== null && 'index' in v ? (v as { index: unknown }).index : v;

/**
 * Validates a fold call against the chat as it was when the call was made (`messages`
 * ends with the message containing the call) and returns the new fold or an error. `to`
 * defaults to the message before that one. A new fold may contain earlier folds entirely
 * but not partially, and may include an earlier fold's call only if it also includes that fold's span.
 */
export function planFold(snapshot: { messages: ChatMessage[]; cut: number; folds?: Fold[] | undefined }, id: string, args: { from?: unknown; to?: unknown; note?: unknown }): Fold | { error: string } {
	const { messages } = snapshot;
	const at = messages.length - 1;
	const note = typeof args.note === 'string' ? args.note.trim() : '';
	if (!note) return { error: 'fold: `note` is required, it is what stays in your context' };
	const from = indexOf(args.from), to = args.to === undefined ? at - 1 : indexOf(args.to);
	if (!Number.isInteger(from) || !Number.isInteger(to)) return { error: 'fold: `from` and `to` must be message `index` values from `chat()`, not positions in its array' };
	const start = cutStart(snapshot.cut, messages.length);
	if ((from as number) < start) return { error: `fold: from ${from} is before your context starts (index ${start})` };
	if ((to as number) >= at) return { error: `fold: to ${to} must be before the message making this call (index ${at})` };
	if ((from as number) > (to as number)) return { error: `fold: from ${from} is after to ${to}` };
	const first = from as number, last = to as number;
	if (messages[first]!.role === 'tool' || messages[last + 1]?.role === 'tool')
		return { error: 'fold: the span would separate a tool call from its result' };

	for (const f of snapshot.folds ?? []) {
		if (first <= f.at && f.at <= last && f.start < first)
			return { error: `fold: message ${f.at} made the fold of ${f.start}–${f.end - 1}; start at ${f.start} to include that fold, or end before ${f.at}` };
		if (f.end <= first || f.start > last) continue;
		if (first <= f.start && f.end - 1 <= last) continue;
		return first >= f.start && last < f.end
			? { error: `fold: messages ${first}–${last} are already folded (${f.start}–${f.end - 1})` }
			: { error: `fold: the span partially overlaps the fold of ${f.start}–${f.end - 1}; include all of it or none` };
	}

	for (let i = first; i <= last; i++) {
		const m = messages[i]!;
		if (m.tool_results?.[m.currentVersionIndex || 0]?.some(r => (r.data === undefined && r.content === undefined) || r.data?.running))
			return { error: `fold: message ${i} has a tool call still running` };
	}
	return { id, start: first, end: last + 1, at, note };
}
