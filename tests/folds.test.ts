/**
 * Folds (src/helpers/folds.ts): what requests leave out, index upkeep on edits,
 * the UI's view, fold-call validation, and a session run of the `fold` tool.
 *
 * Run: bun test
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';

// `fold` is desktop-only and `isTauri` is read at import time
const kvStore = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => kvStore.get(k) ?? null,
	setItem: (k: string, v: string) => kvStore.set(k, v),
	removeItem: (k: string) => kvStore.delete(k),
	clear: () => kvStore.clear(),
};
(globalThis as any).window = {
	__TAURI_INTERNALS__: { invoke: async () => null, transformCallback: (cb: any) => cb },
};
(globalThis as any).document = { querySelector: () => null, hidden: false };

const { hiddenRanges, sentIndices, spliceIndices, foldsWithin, foldDisplay, collapsedFolds, displayFolds, CUT_FOLD_ID, planFold } = await import('../src/helpers/folds');
const { _initForTesting, createChat, CORE_SCHEMA } = await import('../src/helpers/db');
const { createChatSession } = await import('../src/helpers/session');
const { localBackend } = await import('../src/helpers/backend');
const { toolModules, sentTools } = await import('../src/helpers/tools');
// When another test file loaded platform.ts first, `isTauri` is already false
toolModules.fold!.available = true;
import type { ChatMessage, Fold } from '../src/helpers/types';

const fold = (start: number, end: number, extra: Partial<Fold> = {}): Fold => ({ id: `f${start}-${end}`, start, end, at: end, note: 'n', ...extra });
const msg = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content: [text], currentVersionIndex: 0, ...extra });

describe('hiddenRanges / sentIndices', () => {
	test('the cut and folds merge into sorted ranges, nested folds included', () => {
		expect(hiddenRanges(10, 2, [fold(6, 8), fold(3, 5), fold(3, 4)])).toEqual([[0, 2], [3, 5], [6, 8]]);
		expect(hiddenRanges(10, 4, [fold(4, 6)])).toEqual([[0, 6]]);
		expect(hiddenRanges(3, 5, [])).toEqual([]);
	});

	test('sent indices skip hidden ranges and stop at `end`, where only folds called before it apply', () => {
		expect(sentIndices(8, 1, [fold(3, 5)])).toEqual([1, 2, 5, 6, 7]);
		expect(sentIndices(8, 1, [fold(3, 5)], 6)).toEqual([1, 2, 5]);
		expect(sentIndices(8, 1, [fold(3, 5)], 5)).toEqual([1, 2, 3, 4]);
		expect(sentIndices(4, -1)).toEqual([0, 1, 2, 3]);
	});
});

describe('spliceIndices', () => {
	test('inserting before or inside a fold shifts it; on a boundary the message stays sent', () => {
		const f = fold(3, 5, { at: 6 });
		expect(spliceIndices(2, [f], 0, 1)).toEqual({ cut: 3, folds: [{ ...f, start: 4, end: 6, at: 7 }] });
		expect(spliceIndices(2, [f], 3, 1).folds[0]).toMatchObject({ start: 4, end: 6 });
		expect(spliceIndices(2, [f], 4, 1).folds[0]).toMatchObject({ start: 3, end: 6 });
		expect(spliceIndices(2, [f], 5, 1).folds[0]).toMatchObject({ start: 3, end: 5, at: 7 });
	});

	test('deleting shrinks a fold, and drops it when empty or when its call goes', () => {
		const f = fold(3, 5, { at: 6 });
		expect(spliceIndices(-1, [f], 3, -1).folds).toEqual([{ ...f, start: 3, end: 4, at: 5 }]);
		expect(spliceIndices(-1, [fold(3, 4)], 3, -1).folds).toEqual([]);
		expect(spliceIndices(-1, [f], 6, -1).folds).toEqual([]);
		expect(spliceIndices(-1, [f], 1, -1).cut).toBe(-1);
	});
});

test('foldsWithin keeps folds whose span and call are copied, re-indexed', () => {
	const folds = [fold(1, 3, { at: 4 }), fold(5, 7, { at: 9 }), fold(2, 3)];
	expect(foldsWithin(folds, 0, 5)).toEqual([folds[0]!, folds[2]!]);
	expect(foldsWithin(folds, 1, 8)).toEqual([{ ...folds[0]!, start: 0, end: 2, at: 3 }, { ...folds[2]!, start: 1, end: 2, at: 2 }]);
});

test('foldDisplay: closed folds collapse to their first message, open ones get headers', () => {
	const outer = fold(2, 6), inner = fold(3, 5);
	const open = (ids: string[]) => (id: string) => ids.includes(id);
	expect(foldDisplay([outer, inner], open([]), 2)).toEqual({ headers: [], collapsed: outer, hidden: false, folded: true });
	expect(foldDisplay([outer, inner], open([]), 3)).toEqual({ headers: [], collapsed: undefined, hidden: true, folded: true });
	expect(foldDisplay([outer, inner], open([outer.id]), 3)).toEqual({ headers: [], collapsed: inner, hidden: false, folded: true });
	expect(foldDisplay([outer, inner], open([outer.id, inner.id]), 3)).toEqual({ headers: [inner], hidden: false, folded: true });
	expect(foldDisplay([outer], open([outer.id]), 2)).toEqual({ headers: [outer], hidden: false, folded: true });
	expect(foldDisplay([outer], open([]), 6)).toEqual({ headers: [], hidden: false, folded: false });
});

test('collapsedFolds: closed folds not inside another closed fold', () => {
	const outer = fold(2, 6), inner = fold(3, 5), later = fold(8, 9);
	const open = (ids: string[]) => (id: string) => ids.includes(id);
	expect(collapsedFolds([later, inner, outer], open([]))).toEqual([outer, later]);
	expect(collapsedFolds([later, inner, outer], open([outer.id]))).toEqual([inner, later]);
	expect(collapsedFolds([later, inner, outer], open([outer.id, inner.id, later.id]))).toEqual([]);
});

test('displayFolds: the cut becomes a fold after message 0, folds across it start at it', () => {
	const across = fold(2, 6), before = fold(1, 3), after = fold(5, 7);
	expect(displayFolds(-1, 10, [across])).toEqual([across]);
	expect(displayFolds(12, 10, [across])).toEqual([across]);
	expect(displayFolds(1, 10, [across])).toEqual([across]);
	expect(displayFolds(4, 10, [across, before, after])).toEqual([
		{ id: CUT_FOLD_ID, start: 1, end: 4, at: -1, note: '' },
		{ ...across, start: 4 }, before, after,
	]);
});

describe('planFold', () => {
	const messages = [
		msg('user', 'start'),
		msg('assistant', 'a'),
		msg('user', 'please also x'),
		msg('assistant', '', { tool_calls: [[{ id: 't', type: 'function', function: { name: 'shell', arguments: {} } }]], tool_results: [[{ tool_call_id: 't', name: 'shell', data: { ok: true } }]] }),
		msg('tool', 'legacy result'),
		msg('assistant', 'b'),
		msg('assistant', 'calling'),
	];
	const plan = (args: object, extra: { cut?: number; folds?: Fold[] } = {}) =>
		planFold({ messages, cut: extra.cut ?? -1, folds: extra.folds }, 'call', args);

	test('builds the fold, `to` defaulting to before the call', () => {
		expect(plan({ from: 1, note: ' done ' })).toEqual({ id: 'call', start: 1, end: 6, at: 6, note: 'done' });
		expect(plan({ from: { index: 1, role: 'assistant' }, to: { index: 5 }, note: 'n' })).toEqual({ id: 'call', start: 1, end: 6, at: 6, note: 'n' });
	});

	test('rejects bad spans', () => {
		const error = (args: object, extra?: { cut?: number; folds?: Fold[] }) => (plan(args, extra) as { error: string }).error;
		expect(error({ from: 1 })).toContain('`note` is required');
		expect(error({ from: '1', note: 'n' })).toContain('must be message `index` values');
		expect(error({ from: 1, note: 'n' }, { cut: 2 })).toContain('before your context starts');
		expect(error({ from: 1, to: 6, note: 'n' })).toContain('before the message making this call');
		expect(error({ from: 3, to: 2, note: 'n' })).toContain('is after');
		expect(error({ from: 1, to: 3, note: 'n' })).toContain('separate a tool call');
		expect(error({ from: 2, to: 5, note: 'n' }, { folds: [fold(1, 3, { at: 6 })] })).toContain('partially overlaps');
		expect(error({ from: 3, to: 5, note: 'n' }, { folds: [fold(1, 3)] })).toContain('start at 1 to include that fold');
		expect(error({ from: 2, to: 2, note: 'n' }, { folds: [fold(1, 3)] })).toContain('already folded');
		expect(plan({ from: 1, to: 5, note: 'n' }, { folds: [fold(1, 3)] })).toHaveProperty('start', 1);
	});

	test('refuses a span with a running tool', () => {
		const running = [msg('assistant', '', { tool_calls: [[{ id: 't', type: 'function', function: { name: 'shell', arguments: {} } }]], tool_results: [[{ tool_call_id: 't', name: 'shell' }]] }), msg('assistant', 'b'), msg('assistant', 'c')];
		expect(planFold({ messages: running, cut: -1 }, 'c', { from: 0, note: 'n' })).toEqual({ error: 'fold: message 0 has a tool call still running' });
	});
});

test('fold is offered only where run_js can run', () => {
	const names = (selected: Record<string, boolean>, mode: 'native' | 'js' = 'native') => sentTools(selected, localBackend, 'm', 'or', mode).map(t => t.function.name);
	expect(names({ fold: true })).toEqual([]);
	expect(names({ fold: true, run_js: true })).toContain('fold');
	expect(JSON.stringify(sentTools({ fold: true }, localBackend, 'm', 'or', 'js'))).toContain('fold(');
});

describe('fold in a session', () => {
	beforeAll(() => {
		const sqlite = new BunDatabase(':memory:');
		sqlite.exec(CORE_SCHEMA.join(';') + ';');
		_initForTesting({
			execute: async (query: string, params?: any[]) => {
				const stmt = sqlite.prepare(query.replace(/\$(\d+)/g, '?$1'));
				if (params?.length) stmt.run(...params); else stmt.run();
				const lastId = (sqlite.prepare('SELECT last_insert_rowid() AS id').get() as any).id;
				const changes = (sqlite.prepare('SELECT changes() AS c').get() as any).c;
				return { rowsAffected: Number(changes), lastInsertId: Number(lastId) };
			},
			select: async (query: string, params?: any[]) => {
				const stmt = sqlite.prepare(query.replace(/\$(\d+)/g, '?$1'));
				return (params?.length ? stmt.all(...params) : stmt.all()) as any[];
			},
		});
	});

	test('the folded span leaves the next request, and edits keep the fold on its messages', async () => {
		const chatId = await createChat('fold', undefined, undefined, false);
		let folds: Fold[] = [];
		let cut = -1;
		const requests: any[][] = [];
		let finished!: () => void;
		const done = new Promise<void>(r => finished = r);
		const session = createChatSession({
			chatId: () => chatId,
			model: () => 'm', provider: () => 'or',
			providers: () => ({ or: { url: 'http://test', apiKey: 'key', enabled: true } }),
			options: () => ({ stream: true }),
			activeConfig: () => ({ name: '', prompts: [], tools: { fold: true } }),
			promptMessages: () => [],
			cache: () => 'none', cacheLength: () => '5m',
			macros: () => ({}), chatFolder: () => '', cut: () => cut, sendMode: () => 'loop',
			folds: () => folds, setFolds: (f: Fold[]) => folds = f,
			onSplice: (index: number, delta: 1 | -1) => ({ cut, folds } = spliceIndices(cut, folds, index, delta)),
			lore: [], setLore: () => {},
			requestPermission: async () => true,
			backend: () => localBackend,
			setError: () => null, setInfo: () => null,
			stream: (async (_model: string, msgs: any[]) => {
				requests.push(msgs);
				if (requests.length === 1)
					return { success: true, toolCalls: [{ id: 'fc', type: 'function', function: { name: 'fold', arguments: { from: 1, to: 3, note: 'NOTE' } } }] };
				finished();
				return { success: true };
			}) as any,
		} as any);
		session.load([msg('user', 'start'), msg('assistant', 'work-1'), msg('user', 'more-2'), msg('assistant', 'done-3'), msg('user', 'fold it')], 0);

		await session.sendMessage(undefined, false);
		await done;
		expect(folds).toEqual([{ id: 'fc', start: 1, end: 4, at: 5, note: 'NOTE' }]);
		const sent = JSON.stringify(requests[1]);
		expect(sent).toContain('start');
		expect(sent).toContain('NOTE');
		expect(sent).not.toContain('work-1');
		expect(sent).not.toContain('done-3');

		session.insertMessage(0, msg('user', 'new first'));
		expect(folds[0]).toMatchObject({ start: 2, end: 5, at: 6 });
		session.deleteMessage(2);
		expect(folds[0]).toMatchObject({ start: 2, end: 4, at: 5 });
	});
});
