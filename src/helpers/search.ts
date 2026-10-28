/**
 * Search helpers shared by in-chat search (Ctrl+F, in-memory) and global
 * search (FTS5 in db.ts, Tauri only).
 *
 * Everything here is pure — no DOM, no db — so both call sites and the tests
 * can use it directly.
 */

import type { ChatMessage } from './types';
import { getToolTexts } from './messages';

/** Chars of context kept on each side of a match in a snippet. */
const SNIPPET_PAD = 100;

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, c => (
		c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
	));
}

/**
 * Build an HTML snippet around a match: ±SNIPPET_PAD chars, ellipsised at the
 * edges, HTML-escaped, with the matched run wrapped in <b>.
 * The result goes into innerHTML, so escaping happens *before* the <b> is added.
 */
export function buildSnippet(text: string, matchStart: number, matchLength: number): string {
	const start = Math.max(0, matchStart - SNIPPET_PAD);
	const end = Math.min(text.length, matchStart + matchLength + SNIPPET_PAD);
	const before = escapeHtml(text.slice(start, matchStart));
	const match = escapeHtml(text.slice(matchStart, matchStart + matchLength));
	const after = escapeHtml(text.slice(matchStart + matchLength, end));
	return (start > 0 ? '…' : '') + before + '<b>' + match + '</b>' + after + (end < text.length ? '…' : '');
}

/** Opening slice of a message, for hits we can't locate a literal offset for. */
export function headSnippet(text: string): string {
	const head = text.slice(0, SNIPPET_PAD * 2);
	return escapeHtml(head) + (text.length > head.length ? '…' : '');
}

/** Stored row indices can lag displayed ones (gaps are only repaired on load); resolve jumps by identity. */
export function findSearchMessageIndex(messages: ChatMessage[], dbId: number): number {
	return messages.findIndex(msg => msg._dbId === dbId);
}

export interface LoadedMatch {
	/** Index into the messages array — what scrollToMessage takes. */
	idx: number;
	/** Stable db row id, when the message has been persisted. */
	dbId?: number | undefined;
	snippet: string;
	/** Set when the match is in a version other than the active one. */
	versionIndex?: number | undefined;
}

/**
 * Scan loaded messages for a case-insensitive substring.
 *
 * By default only the active version of each message is searched (what the user
 * actually sees). With `allVersions`, every version is scanned and non-active
 * hits carry `versionIndex` so the UI can label them — navigation never switches
 * the active version, since that would change what gets sent to the API.
 */
export function searchLoadedMessages(messages: ChatMessage[], query: string, allVersions = false): LoadedMatch[] {
	if (!query) return [];
	const pattern = createSearchPattern(query);

	const results: LoadedMatch[] = [];
	for (let idx = 0; idx < messages.length; idx++) {
		const msg = messages[idx];
		const active = msg.currentVersionIndex || 0;

		// Active version first, so a message always reports its visible match.
		const hit = findInVersion(msg, active, pattern);
		if (hit) {
			results.push({ idx, dbId: msg._dbId, snippet: hit });
			continue;
		}
		if (!allVersions) continue;

		for (let v = 0; v < msg.content.length; v++) {
			if (v === active) continue;
			const old = findInVersion(msg, v, pattern);
			if (old) {
				results.push({ idx, dbId: msg._dbId, snippet: old, versionIndex: v });
				break;
			}
		}
	}
	return results;
}

/** First hit in a version's content, thinking, then tool calls and results. */
function findInVersion(msg: ChatMessage, version: number, pattern: RegExp): string | null {
	for (const text of [msg.content[version], msg.thinking?.[version], ...getToolTexts(msg, version)]) {
		const hit = findIn(text, pattern);
		if (hit) return hit;
	}
	return null;
}

/** Whether the active version's tool calls or results contain the query. */
export function toolsMatch(msg: ChatMessage, query: string): boolean {
	if (!query) return false;
	const pattern = createSearchPattern(query);
	return getToolTexts(msg).some(text => pattern.test(text));
}

/** Literal, case-insensitive matching shared by search and rendered-text highlights. */
export function createSearchPattern(query: string): RegExp {
	return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

/** Ignore punctuation/whitespace, retaining offsets into the original rendered text. */
export function normalizedSearchMatches(text: string, query: string): { start: number; end: number }[] {
	const needle = query.replace(/[^\p{L}\p{N}]/gu, '');
	if (!needle) return [];
	let normalized = '';
	const offsets: number[] = [];
	for (const match of text.matchAll(/[\p{L}\p{N}]/gu)) {
		normalized += match[0];
		for (let i = 0; i < match[0].length; i++) offsets.push(match.index + i);
	}
	return Array.from(normalized.matchAll(createSearchPattern(needle)), match => ({
		start: offsets[match.index],
		end: offsets[match.index + match[0].length - 1] + 1,
	}));
}

function findIn(text: string | undefined, pattern: RegExp): string | null {
	if (!text) return null;
	pattern.lastIndex = 0;
	const match = pattern.exec(text);
	return match ? buildSnippet(text, match.index, match[0].length) : null;
}

/**
 * Split raw user input into search tokens, mirroring FTS5's unicode61
 * tokenizer: anything that isn't a letter, digit or underscore is a separator.
 *
 * Callers use this for both the MATCH expression and for locating matches in
 * the text afterwards, so the two can't disagree about what a term is.
 */
export function ftsTerms(raw: string): string[] {
	return raw.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/**
 * Turn raw user input into a safe FTS5 MATCH expression.
 *
 * Raw text throws on `"`, `-`, bare `NEAR`, unbalanced quotes and more, so each
 * term is wrapped in double quotes to make it a literal string. Tokenizing
 * first means the terms are already free of quotes and operators. The last term
 * gets a `*` so results appear while a word is still being typed.
 *
 * Returns '' when there's nothing searchable — callers should skip the query.
 */
export function ftsQuery(raw: string): string {
	const terms = ftsTerms(raw);
	if (terms.length === 0) return '';
	return terms.map((t, i) => `"${t}"` + (i === terms.length - 1 ? '*' : '')).join(' ');
}

// ── Search-box facet parsing (sidebar chat search) ─────────────────────

/** Facets consumed off the front of a chat-search query.
 *
 *  `folder:name rest` scopes to one folder term; `tag:a tag:"b c"` requires
 *  every listed tag; `-tag:x` / `-folder:x` exclude one. `#a` is a tag alias.
 *  Blank values (``tag:`` still being typed into) are kept — the UI reads them
 *  as "facet open, show options" and ignores them when scoping. Everything
 *  after the leading facet run is the free-text query.
 */
export interface Facets {
	folderTerm: string | null;
	excludeFolders: string[];
	tags: string[];
	excludeTags: string[];
	text: string;
}

// `$minus` common to all kinds, `$kind`: `tag:` / `folder:` (both case-insensitive)
// or `#` (tag alias), then a quoted or bare value.
const FACET_RE = /^\s*(-?)(?:(tag|folder):|#)(?:"([^"]*)"|(\S*))\s*/i;

export function parseFacets(query: string): Facets {
	let rest = query;
	let folderTerm: string | null = null;
	const excludeFolders: string[] = [];
	const tags: string[] = [];
	const excludeTags: string[] = [];
	for (;;) {
		const m = FACET_RE.exec(rest);
		if (!m) break;
		const value = m[3] ?? m[4] ?? '';
		const exclude = m[1] === '-';
		// `#` is an alias for `tag:`
		const kind = m[2] === undefined ? 'tag' : m[2].toLowerCase();
		if (kind === 'folder') exclude ? excludeFolders.push(value) : (folderTerm = value);
		else exclude ? excludeTags.push(value) : tags.push(value);
		rest = rest.slice(m[0].length);
	}
	return { folderTerm, excludeFolders, tags, excludeTags, text: rest.trim() };
}
