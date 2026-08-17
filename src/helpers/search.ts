/**
 * Search helpers shared by in-chat search (Ctrl+F, in-memory) and global
 * search (FTS5 in db.ts, Tauri only).
 *
 * Everything here is pure — no DOM, no db — so both call sites and the tests
 * can use it directly.
 */

import type { ChatMessage } from './types';
import { getMessageContent, getMessageThinking } from './messages';

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
	const q = query.trim().toLowerCase();
	if (!q) return [];

	const results: LoadedMatch[] = [];
	for (let idx = 0; idx < messages.length; idx++) {
		const msg = messages[idx];
		const active = msg.currentVersionIndex || 0;

		// Active version first, so a message always reports its visible match.
		const hit = findIn(getMessageContent(msg), q) ?? findIn(getMessageThinking(msg), q);
		if (hit) {
			results.push({ idx, dbId: msg._dbId, snippet: hit });
			continue;
		}
		if (!allVersions) continue;

		for (let v = 0; v < msg.content.length; v++) {
			if (v === active) continue;
			const old = findIn(msg.content[v], q) ?? findIn(msg.thinking?.[v], q);
			if (old) {
				results.push({ idx, dbId: msg._dbId, snippet: old, versionIndex: v });
				break;
			}
		}
	}
	return results;
}

/** Locate a lowercased query in `text`, returning a snippet or null. */
function findIn(text: string | undefined, lowerQuery: string): string | null {
	if (!text) return null;
	const at = text.toLowerCase().indexOf(lowerQuery);
	return at === -1 ? null : buildSnippet(text, at, lowerQuery.length);
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
