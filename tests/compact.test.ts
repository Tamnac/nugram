import { test, expect, describe } from 'bun:test';

// localStorage polyfill for bun test environment (tools barrel touches it at import time)
const kvStore = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => kvStore.get(k) ?? null,
	setItem: (k: string, v: string) => kvStore.set(k, v),
	removeItem: (k: string) => kvStore.delete(k),
	clear: () => kvStore.clear(),
};

const { parseReadFiles, estimateContextTokens, fullCompactPrompt, isAdequateSummary, DEFAULT_COMPACT_SETTINGS } = await import('../src/helpers/compact');
import { estTokens, estTokensFromLength } from '../src/helpers/tokens';
import type { ChatMessage } from '../src/helpers/types';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({ role: 'user', content: [''], currentVersionIndex: 0, ...over });

describe('parseReadFiles', () => {
	test('parses fenced block with paths and ranges', () => {
		const text = 'Summary here.\n\n```read-files\nsrc/App.tsx | 100:250\nsrc/helpers/session.ts\n```\n';
		expect(parseReadFiles(text)).toEqual([
			{ path: 'src/App.tsx', range: '100:250' },
			{ path: 'src/helpers/session.ts' },
		]);
	});

	test('falls back to tag block', () => {
		expect(parseReadFiles('<read-files>\nfoo.ts\n</read-files>')).toEqual([{ path: 'foo.ts' }]);
	});

	test('last tagged block wins, underscore and casing tolerated', () => {
		const text = 'Example:\n```read-files\nexample.ts\n```\nActual:\n```Read_Files\nreal.ts\n```';
		expect(parseReadFiles(text)).toEqual([{ path: 'real.ts' }]);
	});

	test('tolerates underscore tag spelling', () => {
		expect(parseReadFiles('<read_files>\nfoo.ts\n</read_files>')).toEqual([{ path: 'foo.ts' }]);
	});

	test('missing block yields nothing', () => {
		expect(parseReadFiles('just a summary')).toEqual([]);
	});

	test('skips blanks and comments, tolerates spaces around the pipe', () => {
		const text = '```read-files\n\n# comment\nfoo.ts|5:\n  bar.ts  \n```';
		expect(parseReadFiles(text)).toEqual([{ path: 'foo.ts', range: '5:' }, { path: 'bar.ts' }]);
	});

	test('pipe-less absolute windows path stays whole', () => {
		expect(parseReadFiles('```read-files\nD:\\src\\a.ts\n```')).toEqual([{ path: 'D:\\src\\a.ts' }]);
	});

	test('drops URLs, globs and quoted paths; dedupes repeats', () => {
		const text = '```read-files\nhttps://example.com/x.txt\n"quoted.ts"\nsrc/*.ts\nfoo.ts\nfoo.ts\nfoo.ts | 1:5\n```';
		expect(parseReadFiles(text)).toEqual([
			{ path: 'quoted.ts' },
			{ path: 'foo.ts' },
			{ path: 'foo.ts', range: '1:5' },
		]);
	});

	test('lines without a path are dropped', () => {
		expect(parseReadFiles('```read-files\n | 5:10\nfoo.ts\n```')).toEqual([{ path: 'foo.ts' }]);
	});

	test('splits on the last pipe, junk range falls back to whole file', () => {
		const text = '```read-files\na | b | 5:10\nfoo.ts | the relevant part\nbar.ts | \n```';
		expect(parseReadFiles(text)).toEqual([
			{ path: 'a | b', range: '5:10' },
			{ path: 'foo.ts' },
			{ path: 'bar.ts' },
		]);
	});
});

describe('fullCompactPrompt', () => {
	test('user prompt stays editable, spec round-trips through the parser', () => {
		const p = fullCompactPrompt('Summarize the work.');
		expect(p.startsWith('Summarize the work.')).toBe(true);
		// The shipped default prompt + spec must always parse a read-files block
		expect(parseReadFiles(fullCompactPrompt(DEFAULT_COMPACT_SETTINGS.prompt)).length).toBeGreaterThan(0);
	});
});

describe('isAdequateSummary', () => {
	test('rejects empty and trivial output', () => {
		expect(isAdequateSummary('')).toBe(false);
		expect(isAdequateSummary('   \n ')).toBe(false);
		expect(isAdequateSummary('hello')).toBe(false);
	});

	test('accepts a substantive summary', () => {
		expect(isAdequateSummary('x'.repeat(200))).toBe(true);
	});
});

describe('estimateContextTokens', () => {
	test('empty chat is zero', () => {
		expect(estimateContextTokens([], 'mystery-model')).toBe(0);
	});

	test('counts only the current version of content', () => {
		const m = msg({ content: ['old version', 'x'.repeat(400)], currentVersionIndex: 1 });
		// 400 chars + 5 per-message overhead (messageChars)
		expect(estimateContextTokens([m], 'mystery-model')).toBe(estTokensFromLength(405, 'mystery-model'));
	});

	test('includes reasoning unless off', () => {
		const m = msg({ content: ['hello'], thinking: ['t'.repeat(380)] });
		const without = estimateContextTokens([m], 'mystery-model', { reasoning: 'off' });
		const byDefault = estimateContextTokens([m], 'mystery-model');
		expect(byDefault).toBeGreaterThan(without);
	});

	test('clipped reasoning counts only the last 5 messages', () => {
		const msgs = Array.from({ length: 8 }, () => msg({ content: ['hello'], thinking: ['t'.repeat(400)] }));
		const baseChars = 8 * ('hello'.length + 5);
		expect(estimateContextTokens(msgs, 'mystery-model', { reasoning: 'clipped' }))
			.toBe(estTokensFromLength(baseChars + 5 * 400, 'mystery-model'));
		expect(estimateContextTokens(msgs, 'mystery-model', { reasoning: 'full' }))
			.toBe(estTokensFromLength(baseChars + 8 * 400, 'mystery-model'));
	});

	test('prefers provider-reported prompt_tokens, estimating only the tail', () => {
		const a = msg({
			role: 'assistant', content: ['answer'],
			usage: [{ prompt_tokens: 5000, message_tokens: 0, reasoning_tokens: 0, prompt_cost: 0, message_cost: 0 }],
		});
		const u = msg({ content: ['x'.repeat(380)] });
		// tail = user message: 380 chars + 5 overhead (messageChars)
		expect(estimateContextTokens([a, u], 'mystery-model')).toBe(5000 + estTokensFromLength(385, 'mystery-model'));
	});

	test('exact base from a stale-cut message only counts messages after it', () => {
		const big = msg({ content: ['y'.repeat(38000)] });
		const a = msg({
			role: 'assistant', content: ['answer'],
			usage: [{ prompt_tokens: 5000, message_tokens: 0, reasoning_tokens: 0, prompt_cost: 0, message_cost: 0 }],
		});
		// `big` sits before the usage-carrying message (e.g. pre-cut in the slice) and is not counted
		expect(estimateContextTokens([big, a], 'mystery-model')).toBe(5000);
	});

	test('counts tool results and file snapshots', () => {
		const plain = estimateContextTokens([msg({ content: ['hello'] })], 'mystery-model');
		const withTools = estimateContextTokens([msg({
			content: ['hello'],
			tool_calls: [[{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: { path: 'x' } } }]],
			tool_results: [[{ tool_call_id: 'c1', name: 'read_file', content: 'y'.repeat(2000) }]],
			files: [[{ id: 'f', path: 'a.ts', chars: 1000 }]],
		})], 'mystery-model');
		expect(withTools).toBeGreaterThan(plain + estTokens('y'.repeat(1500), 'mystery-model'));
	});
});
