/**
 * Tests for the pure search helpers (src/helpers/search.ts).
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { escapeHtml, buildSnippet, headSnippet, searchLoadedMessages, ftsTerms, ftsQuery } from '../src/helpers/search';
import type { ChatMessage } from '../src/helpers/types';

function msg(role: string, content: string | string[], extra?: Partial<ChatMessage>): ChatMessage {
	return {
		role: role as ChatMessage['role'],
		content: Array.isArray(content) ? content : [content],
		currentVersionIndex: 0,
		...extra,
	};
}

describe('escapeHtml', () => {
	test('escapes all HTML-significant characters', () => {
		expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
	});

	test('leaves plain text untouched', () => {
		expect(escapeHtml('hello world')).toBe('hello world');
	});
});

describe('buildSnippet', () => {
	test('wraps the match in <b>', () => {
		expect(buildSnippet('the quick fox', 4, 5)).toBe('the <b>quick</b> fox');
	});

	test('ellipsises only the truncated side', () => {
		const text = 'x'.repeat(300) + 'needle';
		const snippet = buildSnippet(text, 300, 6);
		expect(snippet.startsWith('…')).toBe(true);
		expect(snippet.endsWith('</b>')).toBe(true); // match runs to end of text
	});

	test('escapes before wrapping, so markup in the text is inert', () => {
		const snippet = buildSnippet('<script>alert(1)</script>', 8, 5);
		expect(snippet).toBe('&lt;script&gt;<b>alert</b>(1)&lt;/script&gt;');
	});

	test('escapes the matched run itself', () => {
		expect(buildSnippet('a <b> c', 2, 3)).toBe('a <b>&lt;b&gt;</b> c');
	});
});

describe('headSnippet', () => {
	test('escapes and marks truncation', () => {
		expect(headSnippet('<b>hi')).toBe('&lt;b&gt;hi');
		expect(headSnippet('y'.repeat(500)).endsWith('…')).toBe(true);
	});
});

describe('searchLoadedMessages', () => {
	const messages = [
		msg('user', 'The quick brown fox'),
		msg('assistant', 'jumps over the lazy dog'),
		msg('user', 'nothing relevant'),
	];

	test('finds matches case-insensitively and reports array index', () => {
		const hits = searchLoadedMessages(messages, 'BROWN');
		expect(hits.length).toBe(1);
		expect(hits[0].idx).toBe(0);
		expect(hits[0].snippet).toContain('<b>brown</b>');
	});

	test('returns [] for blank or unmatched queries', () => {
		expect(searchLoadedMessages(messages, '')).toEqual([]);
		expect(searchLoadedMessages(messages, '   ')).toEqual([]);
		expect(searchLoadedMessages(messages, 'zebra')).toEqual([]);
	});

	test('searches thinking as well as content', () => {
		const withThinking = [msg('assistant', 'visible answer', { thinking: ['pondering zebras'] })];
		expect(searchLoadedMessages(withThinking, 'zebras').length).toBe(1);
	});

	test('only searches the active version by default', () => {
		const versioned = [msg('assistant', ['draft zebra', 'final text'], { currentVersionIndex: 1 })];
		expect(searchLoadedMessages(versioned, 'zebra')).toEqual([]);
		expect(searchLoadedMessages(versioned, 'final').length).toBe(1);
	});

	test('allVersions finds inactive versions and flags them', () => {
		const versioned = [msg('assistant', ['draft zebra', 'final text'], { currentVersionIndex: 1 })];
		const hits = searchLoadedMessages(versioned, 'zebra', true);
		expect(hits.length).toBe(1);
		expect(hits[0].versionIndex).toBe(0);
	});

	test('prefers the active version, reporting no versionIndex', () => {
		const versioned = [msg('assistant', ['old match', 'new match'], { currentVersionIndex: 1 })];
		const hits = searchLoadedMessages(versioned, 'match', true);
		expect(hits.length).toBe(1);
		expect(hits[0].versionIndex).toBeUndefined();
	});

	test('reports at most one hit per message', () => {
		const repeated = [msg('user', ['aaa', 'aaa', 'aaa'], { currentVersionIndex: 0 })];
		expect(searchLoadedMessages(repeated, 'aaa', true).length).toBe(1);
	});

	test('carries _dbId through for the scroll/jump contract', () => {
		const withId = [msg('user', 'findme', { _dbId: 42 })];
		expect(searchLoadedMessages(withId, 'findme')[0].dbId).toBe(42);
	});
});

describe('ftsTerms', () => {
	test('splits on non-word characters and lowercases', () => {
		expect(ftsTerms('Hello, world!')).toEqual(['hello', 'world']);
	});

	test('drops pure punctuation', () => {
		expect(ftsTerms('-- "" ((')).toEqual([]);
		expect(ftsTerms('')).toEqual([]);
	});

	test('keeps unicode letters and digits', () => {
		expect(ftsTerms('café 42 中文')).toEqual(['café', '42', '中文']);
	});
});

describe('ftsQuery', () => {
	test('quotes each term and prefix-matches the last', () => {
		expect(ftsQuery('foo bar')).toBe('"foo" "bar"*');
	});

	test('neutralises FTS operators and quotes', () => {
		// None of these may survive as syntax — they'd throw inside MATCH
		expect(ftsQuery('a"b')).toBe('"a" "b"*');
		expect(ftsQuery('-foo')).toBe('"foo"*');
		expect(ftsQuery('x OR y')).toBe('"x" "or" "y"*');
		expect(ftsQuery('NEAR(a b)')).toBe('"near" "a" "b"*');
	});

	test('returns empty string when nothing is searchable', () => {
		expect(ftsQuery('')).toBe('');
		expect(ftsQuery('  ')).toBe('');
		expect(ftsQuery('""')).toBe('');
	});
});
