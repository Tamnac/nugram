/**
 * Tests for the pure search helpers (src/helpers/search.ts).
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { escapeHtml, buildSnippet, headSnippet, findSearchMessageIndex, searchLoadedMessages, createSearchPattern, normalizedSearchMatches, ftsTerms, ftsQuery, parseFacets } from '../src/helpers/search';
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

describe('findSearchMessageIndex', () => {
	test('resolves the current array index by stable database id', () => {
		const messages = [msg('user', 'unsaved'), msg('user', 'target', { _dbId: 42 })];
		expect(findSearchMessageIndex(messages, 42)).toBe(1);
		messages.shift();
		expect(findSearchMessageIndex(messages, 42)).toBe(0);
	});

	test('returns -1 for a deleted or missing search target', () => {
		expect(findSearchMessageIndex([msg('user', 'other', { _dbId: 43 })], 42)).toBe(-1);
		expect(findSearchMessageIndex([], 42)).toBe(-1);
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

	test('returns [] for empty or unmatched queries', () => {
		expect(searchLoadedMessages(messages, '')).toEqual([]);
		expect(searchLoadedMessages(messages, '   ')).toEqual([]);
		expect(searchLoadedMessages(messages, 'zebra')).toEqual([]);
	});

	test('preserves leading and trailing spaces', () => {
		const words = [msg('user', 'a cat naps'), msg('user', 'a caterpillar naps'), msg('user', 'cat naps'), msg('user', 'a cat')];
		expect(searchLoadedMessages(words, ' cat ').map(hit => hit.idx)).toEqual([0]);
		expect(searchLoadedMessages(words, 'cat ').map(hit => hit.idx)).toEqual([0, 2]);
		expect(searchLoadedMessages(words, ' cat').map(hit => hit.idx)).toEqual([0, 1, 3]);
	});

	test('can search whitespace-only queries', () => {
		const spaced = [msg('user', 'one  two'), msg('user', 'one two')];
		expect(searchLoadedMessages(spaced, '  ').map(hit => hit.idx)).toEqual([0]);
		expect(searchLoadedMessages(spaced, ' ').map(hit => hit.idx)).toEqual([0, 1]);
	});

	test('treats regex punctuation literally', () => {
		expect(searchLoadedMessages([msg('user', 'literal [a.*] and other text')], '[a.*]')[0].snippet)
			.toContain('<b>[a.*]</b>');
	});

	test('snippet offsets remain correct after case-insensitive Unicode matching', () => {
		expect(searchLoadedMessages([msg('user', 'İ needle')], 'needle')[0].snippet)
			.toBe('İ <b>needle</b>');
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

describe('createSearchPattern', () => {
	test('finds all literal occurrences with their original offsets', () => {
		const matches = [...'Hello **WORLD**; hello **world**'.matchAll(createSearchPattern('hello **world**'))];
		expect(matches.map(match => [match.index, match[0]])).toEqual([
			[0, 'Hello **WORLD**'], [17, 'hello **world**'],
		]);
	});

	test('escapes every regex metacharacter', () => {
		const query = '.*+?^${}()|[]\\';
		expect(createSearchPattern(query).exec(`before ${query} after`)?.[0]).toBe(query);
	});
});

describe('normalizedSearchMatches', () => {
	test('ignores markdown punctuation and maps back to rendered offsets', () => {
		expect(normalizedSearchMatches('Hello, world! Hello world.', '**hello** _world_')).toEqual([
			{ start: 0, end: 12 }, { start: 14, end: 25 },
		]);
	});

	test('removes spaces but preserves them inside the highlighted span', () => {
		expect(normalizedSearchMatches('a cat naps', '**catnaps**')).toEqual([{ start: 2, end: 10 }]);
	});

	test('supports Unicode letters, numbers and surrogate-pair offsets', () => {
		expect(normalizedSearchMatches('😀 中文—１２!', '**中文１２**')).toEqual([{ start: 3, end: 8 }]);
		expect(normalizedSearchMatches('x 𐐀—𐐁 y', '**𐐨𐐩**')).toEqual([{ start: 2, end: 7 }]);
	});

	test('has no fallback for queries without letters or numbers', () => {
		expect(normalizedSearchMatches('hello', ' ** ')).toEqual([]);
		expect(normalizedSearchMatches('hello', '')).toEqual([]);
	});

	test('does not change literal search results', () => {
		expect(searchLoadedMessages([msg('user', 'hello world')], '**hello**')).toEqual([]);
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

describe('parseFacets', () => {
	test('splits leading facets from free text', () => {
		expect(parseFacets('folder:/work tag:story hello world')).toEqual({
			folderTerm: '/work', excludeFolders: [], tags: ['story'], excludeTags: [], text: 'hello world',
		});
	});

	test('supports quoted values and multiple tags', () => {
		expect(parseFacets('tag:"star trek" tag:wip -tag:dropped rest')).toEqual({
			folderTerm: null, excludeFolders: [], tags: ['star trek', 'wip'], excludeTags: ['dropped'], text: 'rest',
		});
	});

	test('reads # as a tag alias, with - excluding and quotes working', () => {
		expect(parseFacets('#wip #"star trek" -#dropped rest')).toEqual({
			folderTerm: null, excludeFolders: [], tags: ['wip', 'star trek'], excludeTags: ['dropped'], text: 'rest',
		});
	});

	test('-folder excludes folders alongside the folder term', () => {
		expect(parseFacets('folder:work -folder:"my archive" rest')).toEqual({
			folderTerm: 'work', excludeFolders: ['my archive'], tags: [], excludeTags: [], text: 'rest',
		});
		expect(parseFacets('-folder:archive needle')).toEqual({
			folderTerm: null, excludeFolders: ['archive'], tags: [], excludeTags: [], text: 'needle',
		});
	});

	test('keeps blank facet values (facet still being typed)', () => {
		expect(parseFacets('tag:')).toEqual({ folderTerm: null, excludeFolders: [], tags: [''], excludeTags: [], text: '' });
		expect(parseFacets('#')).toEqual({ folderTerm: null, excludeFolders: [], tags: [''], excludeTags: [], text: '' });
		expect(parseFacets('folder:"" ')).toEqual({ folderTerm: '', excludeFolders: [], tags: [], excludeTags: [], text: '' });
	});

	test('matches folders and tags case-insensitively, in any order', () => {
		expect(parseFacets('TAG:x FOLDER:y z')).toEqual({
			folderTerm: 'y', excludeFolders: [], tags: ['x'], excludeTags: [], text: 'z',
		});
	});

	test('plain text and lone colons stay free text', () => {
		expect(parseFacets('tags: are not folders')).toEqual({
			folderTerm: null, excludeFolders: [], tags: [], excludeTags: [], text: 'tags: are not folders',
		});
		expect(parseFacets('-tag without colon')).toEqual({
			folderTerm: null, excludeFolders: [], tags: [], excludeTags: [], text: '-tag without colon',
		});
	});

	test('a facet-looking word later in the query stays free text', () => {
		expect(parseFacets('see tag:later')).toEqual({
			folderTerm: null, excludeFolders: [], tags: [], excludeTags: [], text: 'see tag:later',
		});
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

describe('searchLoadedMessages tool text', () => {
	const call = { id: 'c1', type: 'function' as const, function: { name: 'shell', arguments: { command: 'ls\ncat notes.txt' } } };
	const withTools = msg('assistant', '', {
		tool_calls: [[call]],
		tool_results: [[{ tool_call_id: 'c1', name: 'shell', content: 'found zebra stripes' }]],
	});

	test('matches tool call arguments, across lines', () => {
		expect(searchLoadedMessages([withTools], 'notes.txt')).toHaveLength(1);
	});

	test('matches tool results', () => {
		const hits = searchLoadedMessages([withTools], 'zebra');
		expect(hits).toHaveLength(1);
		expect(hits[0].snippet).toContain('<b>zebra</b>');
	});

	test('only the active version counts unless all versions are searched', () => {
		const other = msg('assistant', ['a', 'b'], {
			currentVersionIndex: 0,
			tool_results: [[], [{ tool_call_id: 'x', name: 'shell', content: 'hidden needle' }]],
		});
		expect(searchLoadedMessages([other], 'needle')).toHaveLength(0);
		expect(searchLoadedMessages([other], 'needle', true)[0].versionIndex).toBe(1);
	});
});
