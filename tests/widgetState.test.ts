import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetWidgetStateForTesting, flushWidgetStates, loadWidgetState, resetWidgetState, saveWidgetState, MAX_WIDGET_STATE } from '../src/helpers/widgetState';

/** Storage in a Map, with a log of the writes. */
function fakeIO(initial: Record<string, string> = {}) {
	const rows = new Map(Object.entries(initial));
	const writes: string[] = [];
	return {
		rows, writes,
		io: {
			load: async (chatId: string, id: string) => rows.get(`${chatId}/${id}`) ?? null,
			save: async (chatId: string, id: string, json: string) => { writes.push(`${chatId}/${id}=${json}`); rows.set(`${chatId}/${id}`, json); },
		},
	};
}

let store: ReturnType<typeof fakeIO>;

function useStore(initial?: Record<string, string>) {
	store = fakeIO(initial);
	_resetWidgetStateForTesting(store.io);
}

beforeEach(() => useStore());
afterEach(() => _resetWidgetStateForTesting());

describe('widget state', () => {
	test('a save is readable at once and written once after the delay', async () => {
		saveWidgetState('c', 'a', '{"n":1}');
		saveWidgetState('c', 'a', '{"n":2}');
		expect(await loadWidgetState('c', 'a')).toBe('{"n":2}');
		expect(store.writes).toEqual([]);
		await flushWidgetStates('c');
		expect(store.writes).toEqual(['c/a={"n":2}']);
		await flushWidgetStates('c');
		expect(store.writes.length).toBe(1);
	});

	test('flushing one chat leaves the others pending', async () => {
		saveWidgetState('c1', 'a', '1');
		saveWidgetState('c2', 'a', '2');
		await flushWidgetStates('c1');
		expect(store.writes).toEqual(['c1/a=1']);
		await flushWidgetStates();
		expect(store.writes).toEqual(['c1/a=1', 'c2/a=2']);
	});

	test('loads what was stored, null when nothing was', async () => {
		useStore({ 'c/a': '[1]' });
		expect(await loadWidgetState('c', 'a')).toBe('[1]');
		expect(await loadWidgetState('c', 'b')).toBeNull();
		expect(await loadWidgetState('other', 'a')).toBeNull();
	});

	test('rejects text that is not JSON or is too long', () => {
		expect(() => saveWidgetState('c', 'a', '{oops')).toThrow('not valid JSON');
		expect(() => saveWidgetState('c', 'a', JSON.stringify('x'.repeat(MAX_WIDGET_STATE)))).toThrow('over the limit');
	});

	test('an inheriting instance starts from a copy, then the two are independent', async () => {
		saveWidgetState('c', 'a', '{"n":5}');
		expect(await loadWidgetState('c', 'b', 'a')).toBe('{"n":5}');
		expect(store.writes).toEqual(['c/b={"n":5}']);
		saveWidgetState('c', 'a', '{"n":6}');
		saveWidgetState('c', 'b', '{"n":9}');
		expect(await loadWidgetState('c', 'b', 'a')).toBe('{"n":9}');
		expect(await loadWidgetState('c', 'a')).toBe('{"n":6}');
	});

	test('fresh does not copy, and an empty source is not copied later either', async () => {
		saveWidgetState('c', 'a', '1');
		expect(await loadWidgetState('c', 'b', 'a', 'fresh')).toBeNull();
		expect(await loadWidgetState('c', 'd', 'empty')).toBeNull();
		saveWidgetState('c', 'empty', '2');
		expect(await loadWidgetState('c', 'd', 'empty')).toBe('null');
	});

	test('reset clears the state and keeps an inheriting instance from copying again', async () => {
		saveWidgetState('c', 'a', '1');
		expect(await loadWidgetState('c', 'b', 'a')).toBe('1');
		resetWidgetState('c', 'b');
		expect(await loadWidgetState('c', 'b', 'a')).toBe('null');
		await flushWidgetStates('c');
		expect(store.rows.get('c/b')).toBe('null');
	});
});
