/**
 * Tests for chat back/forward persistence (src/helpers/navHistory.ts).
 *
 * Each openWindow() loads a fresh copy of the module, which acts as one window: the
 * copies share localStorage (saved stack and owner heartbeat) but keep their own
 * in-memory stack. Each new window also starts with an empty browser history stub.
 *
 * Run: bun test
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';

type NavHistory = typeof import('../src/helpers/navHistory');
type Entry = { state: any; url: string };

const STACK_KEY = 'chat_nav_history';
const OWNER_KEY = 'chat_nav_owner';

const g = globalThis as any;
const originals = { localStorage: g.localStorage, window: g.window, history: g.history, setInterval: g.setInterval };

let store: Map<string, string>;
let entries: Entry[];
let cur: number;
let goCalls: number[];
let listeners: Map<string, () => void>;
let windowCount = 0;

const urlFor = (id: string) => `/?chat=${id}`;
const chats = new Set(['a', 'b', 'c']);

beforeEach(() => {
	store = new Map();
	entries = [];
	cur = -1;
	goCalls = [];
	listeners = new Map();
	g.localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	};
	g.window = { addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn) };
	g.setInterval = () => 0;
	g.history = {
		get state() { return entries[cur]?.state ?? null; },
		replaceState(state: any, _: string, url: string) {
			if (cur < 0) entries = [{ state, url }];
			else entries[cur] = { state, url };
			cur = entries.length - 1;
		},
		pushState(state: any, _: string, url: string) {
			entries = [...entries.slice(0, cur + 1), { state, url }];
			cur = entries.length - 1;
		},
		go(delta: number) { goCalls.push(delta); cur += delta; },
	};
});

afterAll(() => Object.assign(g, originals));

async function openWindow(): Promise<NavHistory> {
	entries = [];
	cur = -1;
	return import(`../src/helpers/navHistory.ts?window=${windowCount++}`);
}

const savedStack = () => JSON.parse(store.get(STACK_KEY)!);
const chatIds = () => entries.map(e => e.state.chatId);
const currentChat = () => entries[cur]?.state.chatId;

describe('restoreNav', () => {
	test('starts a saved stack from the current chat when nothing is saved', async () => {
		const nav = await openWindow();
		nav.restoreNav('a', chats, urlFor);
		expect(chatIds()).toEqual(['a']);
		expect(savedStack()).toEqual({ stack: ['a'], idx: 0 });
	});

	test('rebuilds the saved entries and position', async () => {
		store.set(STACK_KEY, JSON.stringify({ stack: ['a', 'b', 'c'], idx: 1 }));
		const nav = await openWindow();
		nav.restoreNav('b', chats, urlFor);
		expect(chatIds()).toEqual(['a', 'b', 'c']);
		expect(currentChat()).toBe('b');
		expect(goCalls).toEqual([-1]);
	});

	test('skips deleted chats', async () => {
		store.set(STACK_KEY, JSON.stringify({ stack: ['a', 'gone', 'b', 'c'], idx: 2 }));
		const nav = await openWindow();
		nav.restoreNav('b', chats, urlFor);
		expect(chatIds()).toEqual(['a', 'b', 'c']);
		expect(currentChat()).toBe('b');
		expect(goCalls).toEqual([-1]);
	});

	test('moves to the closest earlier chat when the current one was deleted', async () => {
		store.set(STACK_KEY, JSON.stringify({ stack: ['a', 'b', 'c'], idx: 1 }));
		const nav = await openWindow();
		nav.restoreNav('a', new Set(['a', 'c']), urlFor);
		expect(chatIds()).toEqual(['a', 'c']);
		expect(currentChat()).toBe('a');
	});

	test('replaces the current entry when the saved position is another chat', async () => {
		store.set(STACK_KEY, JSON.stringify({ stack: ['a', 'b'], idx: 0 }));
		const nav = await openWindow();
		nav.restoreNav('z', chats, urlFor);
		expect(chatIds()).toEqual(['z']);
		expect(savedStack()).toEqual({ stack: ['z'], idx: 0 });
	});

	test('ignores a corrupt saved stack', async () => {
		store.set(STACK_KEY, 'not json');
		const nav = await openWindow();
		nav.restoreNav('a', chats, urlFor);
		expect(chatIds()).toEqual(['a']);
	});
});

describe('restoreNav with no chat to open', () => {
	test('a launch that opens a new chat appends it after the saved entries', async () => {
		store.set(STACK_KEY, JSON.stringify({ stack: ['a', 'b', 'c'], idx: 1 }));
		const nav = await openWindow();
		nav.restoreNav(null, chats, urlFor);
		nav.pushNav('new', urlFor('new'));
		expect(chatIds()).toEqual(['a', 'b', 'c', 'new']);
		expect(currentChat()).toBe('new');
		expect(goCalls).toEqual([]);
		expect(savedStack()).toEqual({ stack: ['a', 'b', 'c', 'new'], idx: 3 });
	});

	test('without saved history, the first push replaces the initial browser entry', async () => {
		const nav = await openWindow();
		entries = [{ state: null, url: '/' }];
		cur = 0;
		nav.restoreNav(null, chats, urlFor);
		nav.pushNav('new', urlFor('new'));
		expect(chatIds()).toEqual(['new']);
		expect(savedStack()).toEqual({ stack: ['new'], idx: 0 });
	});
});

describe('navigation', () => {
	test('the owner saves pushes and drops forward entries after going back', async () => {
		const nav = await openWindow();
		nav.restoreNav('a', chats, urlFor);
		nav.pushNav('b', urlFor('b'));
		nav.pushNav('c', urlFor('c'));
		expect(savedStack()).toEqual({ stack: ['a', 'b', 'c'], idx: 2 });

		nav.syncNav({ navIdx: 1 });
		nav.pushNav('d', urlFor('d'));
		expect(savedStack()).toEqual({ stack: ['a', 'b', 'd'], idx: 2 });
	});

	test('a window that does not own the stack keeps its pushes out of storage', async () => {
		store.set(OWNER_KEY, JSON.stringify({ id: 'other', ts: Date.now() }));
		store.set(STACK_KEY, JSON.stringify({ stack: ['a', 'b'], idx: 1 }));
		const nav = await openWindow();
		nav.restoreNav('b', chats, urlFor);
		nav.pushNav('c', urlFor('c'));
		expect(chatIds()).toEqual(['a', 'b', 'c']);
		expect(savedStack()).toEqual({ stack: ['a', 'b'], idx: 1 });
	});

	test('claims the stack when the owner heartbeat is stale', async () => {
		store.set(OWNER_KEY, JSON.stringify({ id: 'gone', ts: Date.now() - 60_000 }));
		const nav = await openWindow();
		nav.restoreNav('a', chats, urlFor);
		nav.pushNav('b', urlFor('b'));
		expect(savedStack()).toEqual({ stack: ['a', 'b'], idx: 1 });
	});

	test('releases the owner heartbeat when the window hides', async () => {
		const nav = await openWindow();
		nav.restoreNav('a', chats, urlFor);
		expect(store.has(OWNER_KEY)).toBe(true);
		listeners.get('pagehide')!();
		expect(store.has(OWNER_KEY)).toBe(false);
	});

	test('keeps the newest 50 entries', async () => {
		const nav = await openWindow();
		nav.restoreNav('0', chats, urlFor);
		for (let i = 1; i < 60; i++) nav.pushNav(String(i), urlFor(String(i)));
		const { stack } = savedStack();
		expect(stack).toHaveLength(50);
		expect(stack[0]).toBe('10');
		expect(stack[49]).toBe('59');
	});

	test('removeNav drops a deleted chat and moves the position back', async () => {
		store.set(STACK_KEY, JSON.stringify({ stack: ['a', 'b', 'c'], idx: 1 }));
		const nav = await openWindow();
		nav.restoreNav('b', chats, urlFor);
		nav.removeNav('b');
		expect(savedStack()).toEqual({ stack: ['a', 'c'], idx: 0 });
	});
});
