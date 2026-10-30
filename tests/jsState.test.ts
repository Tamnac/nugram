/**
 * run_js persisted state (helpers/jsRuntime/state.ts) and value display
 * (helpers/jsRuntime/inspect.ts). Both are pure, so no Worker is needed.
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { capList, decodeState, encodeState, reviveFunction, stateId, STATE_FORMAT } from '../src/helpers/jsRuntime/state';
import { describeError, inspect } from '../src/helpers/jsRuntime/inspect';

const roundTrip = (globals: Record<string, unknown>) => {
	const encoded = encodeState(globals);
	return { encoded, decoded: decodeState(encoded.text) };
};

describe('encodeState / decodeState', () => {
	test('plain values round-trip', () => {
		const globals = { n: 1, s: 'x', b: true, nil: null, u: undefined, nan: NaN, neg: -0, arr: [1, 'a', [2]], obj: { a: { b: 2 } } };
		const { encoded, decoded } = roundTrip(globals);
		expect(encoded.lost).toEqual([]);
		expect(decoded.lost).toEqual([]);
		expect(decoded.globals).toEqual(globals);
		expect(Object.is(decoded.globals.neg, -0)).toBe(true);
		expect('u' in decoded.globals).toBe(true);
	});

	test('cycles survive', () => {
		const node: any = { name: 'a' };
		node.self = node;
		node.list = [node];
		const { decoded } = roundTrip({ node });
		const out = decoded.globals.node as any;
		expect(out.self).toBe(out);
		expect(out.list[0]).toBe(out);
	});

	test('references shared between globals stay shared', () => {
		const shared = { hits: 0 };
		const { decoded } = roundTrip({ a: shared, b: { inner: shared }, m: new Map([['k', shared]]) });
		const g = decoded.globals as any;
		expect(g.b.inner).toBe(g.a);
		expect(g.m.get('k')).toBe(g.a);
	});

	test('Map, Set, BigInt, Date, RegExp and typed arrays', () => {
		const buffer = new ArrayBuffer(8);
		const globals = {
			m: new Map<unknown, unknown>([[1, 'one'], [{ k: 1 }, new Set([2n])]]),
			s: new Set(['a', 'b']),
			big: 12345678901234567890n,
			d: new Date(0),
			r: /a+/gi,
			bytes: new Uint8Array([1, 2, 3]),
			floats: new Float64Array([0.5]),
			view: new Uint8Array(buffer, 2, 4),
			whole: new Uint32Array(buffer),
		};
		const { encoded, decoded } = roundTrip(globals);
		expect(encoded.lost).toEqual([]);
		const g = decoded.globals as any;
		expect(g.m.get(1)).toBe('one');
		expect([...g.m.values()][1]).toEqual(new Set([2n]));
		expect(g.s).toEqual(new Set(['a', 'b']));
		expect(g.big).toBe(12345678901234567890n);
		expect(g.d).toEqual(new Date(0));
		expect(g.r.source).toBe('a+');
		expect(g.r.flags).toBe('gi');
		expect(g.bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(g.floats).toEqual(new Float64Array([0.5]));
		expect(g.view.byteOffset).toBe(2);
		expect(g.view.buffer).toBe(g.whole.buffer);
	});

	test('functions are saved as source and revived', () => {
		const double = (x: number) => x * 2;
		async function fetchIt() { return 'ok'; }
		class Point { constructor(public x: number) {} }
		const holder = { add(a: number, b: number) { return a + b; }, *count() { yield 1; } };
		const { encoded, decoded } = roundTrip({ double, fetchIt, Point, add: holder.add, count: holder.count, again: double });
		expect(encoded.lost).toEqual([]);
		const g = decoded.globals as any;
		expect(g.double(4)).toBe(8);
		expect(g.again).toBe(g.double);
		expect(g.add(2, 3)).toBe(5);
		expect([...g.count()]).toEqual([1]);
		expect(new g.Point(3).x).toBe(3);
		expect(g.fetchIt()).resolves.toBe('ok');
	});

	test('function properties are dropped', () => {
		const fn: any = () => 1;
		fn.extra = 5;
		const { decoded } = roundTrip({ fn });
		expect((decoded.globals.fn as any).extra).toBeUndefined();
	});

	test('lost values are reported by path and revive to undefined', () => {
		const globals = {
			cache: { parse: Math.max, bound: function () {}.bind(null), pending: Promise.resolve(1), weak: new WeakMap(), sym: Symbol('s') },
			list: [1, Symbol.iterator],
			m: new Map([['key', Math.min]]),
		};
		const { encoded, decoded } = roundTrip(globals);
		expect(encoded.lost).toEqual([
			'cache.parse (native function)',
			'cache.bound (bound function)',
			'cache.pending (Promise)',
			'cache.weak (WeakMap)',
			'cache.sym (symbol)',
			'list[1] (symbol)',
			'm.get("key") (native function)',
		]);
		const g = decoded.globals as any;
		expect(g.cache).toEqual({ parse: undefined, bound: undefined, pending: undefined, weak: undefined, sym: undefined });
		expect(g.list).toEqual([1, undefined]);
		expect(decoded.lost).toEqual(encoded.lost);
	});

	test('lost lists are capped at 20 entries', () => {
		const globals = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`s${i}`, Symbol()]));
		const { encoded, decoded } = roundTrip(globals);
		expect(encoded.lost).toHaveLength(21);
		expect(encoded.lost[19]).toBe('s19 (symbol)');
		expect(encoded.lost[20]).toBe('and 5 more');
		expect(decoded.lost).toEqual(encoded.lost);
		expect(capList([...encoded.lost, 'extra'])).toEqual([...encoded.lost.slice(0, 20), 'and 6 more']);
	});

	test('a value reachable twice is reported once', () => {
		const p = Promise.resolve();
		expect(encodeState({ a: p, b: { p } }).lost).toEqual(['a (Promise)']);
	});

	test('class instances become plain objects and are reported as converted', () => {
		class Foo { a = 1; b = { c: 2 }; }
		const { encoded, decoded } = roundTrip({ cache: { item: new Foo() } });
		expect(encoded.lost).toEqual(['cache.item (Foo instance → plain object)']);
		const item = (decoded.globals.cache as any).item;
		expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
		expect(item).toEqual({ a: 1, b: { c: 2 } });
	});

	test('errors keep name, message and stack as a plain object', () => {
		const { encoded, decoded } = roundTrip({ err: new TypeError('bad') });
		expect(encoded.lost).toEqual(['err (TypeError → plain object)']);
		expect((decoded.globals.err as any).message).toBe('bad');
		expect((decoded.globals.err as any).name).toBe('TypeError');
	});

	test('null-prototype objects and odd keys survive', () => {
		const bare = Object.create(null);
		bare['two words'] = 1;
		const { encoded, decoded } = roundTrip({ bare });
		expect(encoded.lost).toEqual([]);
		expect(Object.getPrototypeOf(decoded.globals.bare)).toBeNull();
		expect((decoded.globals.bare as any)['two words']).toBe(1);
	});

	test('getters that throw are reported, not fatal', () => {
		const obj = { ok: 1, get boom() { throw new Error('no'); } };
		const { encoded, decoded } = roundTrip({ obj });
		expect(encoded.lost).toEqual(['obj.boom (getter threw)']);
		expect(decoded.globals.obj).toEqual({ ok: 1 });
	});

	test('functions whose source no longer evaluates are lost on decode', () => {
		const text = encodeState({ fn: () => 1, obj: { method() { return 1; } } }).text;
		const decoded = decodeState(text, () => { throw new Error('nope'); });
		expect(decoded.lost).toEqual(['fn (function source could not be revived)', 'obj.method (function source could not be revived)']);
		expect(decoded.globals.fn).toBeUndefined();
	});

	test('snapshots carry their format version', () => {
		const { text } = encodeState({ a: 1 });
		expect(JSON.parse(text).v).toBe(STATE_FORMAT);
		expect(() => decodeState(JSON.stringify({ v: 99, data: [] }))).toThrow(/unsupported state format/);
	});

	test('stateId is content-addressed', async () => {
		const a = await stateId(encodeState({ x: 1 }).text);
		expect(a).toMatch(/^jsstate-[0-9a-f]{64}$/);
		expect(await stateId(encodeState({ x: 1 }).text)).toBe(a);
		expect(await stateId(encodeState({ x: 2 }).text)).not.toBe(a);
	});
});

describe('reviveFunction', () => {
	test('expressions, arrows, classes and method shorthand', () => {
		expect((reviveFunction('function f(a) { return a + 1 }') as any)(1)).toBe(2);
		expect((reviveFunction('x => x * 3') as any)(2)).toBe(6);
		expect(typeof reviveFunction('class A {}')).toBe('function');
		expect((reviveFunction('sum(a, b) { return a + b }') as any)(1, 2)).toBe(3);
		expect((reviveFunction('async load() { return 1 }') as any)()).resolves.toBe(1);
	});

	test('accessors and garbage throw', () => {
		expect(() => reviveFunction('get size() { return 1 }')).toThrow();
		expect(() => reviveFunction('not js at all {')).toThrow();
	});
});

describe('inspect', () => {
	test('strings raw, other values as JSON', () => {
		expect(inspect('hi')).toBe('hi');
		expect(inspect(5)).toBe('5');
		expect(inspect(undefined)).toBe('undefined');
		expect(inspect(null)).toBe('null');
		expect(inspect({ a: [1, 'x'] })).toBe('{"a":[1,"x"]}');
	});

	test('Map entries, Set arrays, BigInt strings', () => {
		expect(inspect(new Map([['k', 1]]))).toBe('[["k",1]]');
		expect(inspect(new Set([1, 2]))).toBe('[1,2]');
		expect(inspect(10n)).toBe('10');
		expect(inspect({ n: 10n })).toBe('{"n":"10"}');
	});

	test('cycles, functions, errors and typed arrays', () => {
		const a: any = { x: 1 };
		a.self = a;
		expect(inspect(a)).toBe('{"x":1,"self":"[Circular]"}');
		const shared = { y: 1 };
		expect(inspect([shared, shared])).toBe('[{"y":1},{"y":1}]');
		expect(inspect(function named() {})).toBe('[Function named]');
		expect(inspect({ e: new RangeError('r') })).toBe('{"e":"RangeError: r"}');
		expect(inspect(new Uint8Array([1, 2]))).toBe('[1,2]');
		expect(inspect(Infinity)).toBe('Infinity');
	});
});

describe('describeError', () => {
	test('keeps snippet frames with snippet line numbers', () => {
		const e = new TypeError('x is not a function');
		e.stack = [
			'TypeError: x is not a function',
			'    at helper (eval at run (http://localhost:3000/src/helpers/jsRuntime/worker.ts:99:22), <anonymous>:4:3)',
			'    at eval (eval at run (http://localhost:3000/src/helpers/jsRuntime/worker.ts:99:22), <anonymous>:7:1)',
			'    at run (http://localhost:3000/src/helpers/jsRuntime/worker.ts:99:40)',
		].join('\n');
		expect(describeError(e, 2)).toBe('TypeError: x is not a function\n    at helper (line 2:3)\n    at eval (line 5:1)');
	});

	test('non-errors are shown as values', () => {
		expect(describeError('oops')).toBe('oops');
		expect(describeError({ code: 1 })).toBe('{"code":1}');
	});
});
