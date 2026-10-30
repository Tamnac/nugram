/**
 * Persisted run_js state: the user-added globals of a Worker, encoded in one
 * devalue graph so shared references and cycles survive. Pure (no Worker APIs)
 * so it can be tested directly; the Worker calls it, the parent only stores the
 * resulting string. Design: mds/js-code-tool-plan.md
 */
import { stringify, unflatten } from 'devalue';

/** devalue's format may change between versions, so snapshots carry their own. */
export const STATE_FORMAT = 1;

class FnRef {
	constructor(readonly src: string, readonly path: string) {}
}

class LostRef {
	constructor(readonly what: string) {}
}

const reducers = {
	Fn: (v: unknown) => v instanceof FnRef && [v.src, v.path],
	Lost: (v: unknown) => v instanceof LostRef && v.what,
};

/** Kept as-is: devalue encodes these natively. */
const NATIVE_TAGS = new Set([
	'Date', 'RegExp', 'URL', 'URLSearchParams', 'ArrayBuffer', 'DataView',
	'Number', 'String', 'Boolean', 'BigInt',
	'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Float16Array',
	'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);

const MAX_LISTED = 20;
const MORE = /^and (\d+) more$/;

/**
 * At most 20 entries plus an "and N more" line. Idempotent: existing "and N
 * more" lines are folded into the count, so lists can be capped again after
 * being combined.
 */
export function capList(items: string[]): string[] {
	let more = 0;
	const kept: string[] = [];
	for (const item of items) {
		const m = MORE.exec(item);
		if (m) more += Number(m[1]);
		else if (kept.length < MAX_LISTED) kept.push(item);
		else more++;
	}
	return more ? [...kept, `and ${more} more`] : kept;
}

const NATIVE_SOURCE = /\{\s*\[native code\]\s*\}\s*$/;

const keyPath = (key: string) => /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

const mapKeyLabel = (key: unknown) =>
	typeof key === 'string' ? JSON.stringify(key)
	: typeof key === 'number' || typeof key === 'boolean' || key == null ? String(key)
	: typeof key === 'bigint' ? `${key}n` : '…';

/**
 * Copy the globals into a graph devalue can encode, keeping identity (shared
 * references, cycles). Functions become their source, class instances plain
 * objects; everything else unsupported becomes a marker that revives to
 * undefined. Each loss or conversion is reported by path, once per value.
 */
function prepare(globals: Record<string, unknown>): { root: Record<string, unknown>; lost: string[] } {
	const seen = new Map<unknown, unknown>();
	const lost: string[] = [];
	const lose = (path: string, what: string) => {
		lost.push(`${path} (${what})`);
		return new LostRef(what);
	};

	const visit = (v: unknown, path: string): unknown => {
		if (typeof v === 'symbol') return lose(path, 'symbol');
		if ((typeof v !== 'object' && typeof v !== 'function') || v === null) return v;
		if (seen.has(v)) return seen.get(v);

		if (typeof v === 'function') {
			const src = Function.prototype.toString.call(v);
			const out = NATIVE_SOURCE.test(src)
				? lose(path, v.name.startsWith('bound ') ? 'bound function' : 'native function')
				: new FnRef(src, path);
			seen.set(v, out);
			return out;
		}

		const tag = Object.prototype.toString.call(v).slice(8, -1);
		if (NATIVE_TAGS.has(tag)) {
			seen.set(v, v);
			return v;
		}

		if (Array.isArray(v)) {
			const out: unknown[] = [];
			seen.set(v, out);
			out.length = v.length;
			for (const key of Object.keys(v)) {
				const i = Number(key);
				if (Number.isInteger(i)) out[i] = visit(v[i], `${path}[${i}]`);
			}
			return out;
		}

		if (v instanceof Map) {
			const out = new Map();
			seen.set(v, out);
			let i = 0;
			for (const [key, value] of v) {
				out.set(visit(key, `${path}.keys()[${i++}]`), visit(value, `${path}.get(${mapKeyLabel(key)})`));
			}
			return out;
		}

		if (v instanceof Set) {
			const out = new Set();
			seen.set(v, out);
			let i = 0;
			for (const value of v) out.add(visit(value, `${path}.values()[${i++}]`));
			return out;
		}

		const isError = v instanceof Error;
		if (tag !== 'Object' && !isError) {
			const out = lose(path, tag);
			seen.set(v, out);
			return out;
		}

		const proto = Object.getPrototypeOf(v);
		const out: Record<string, unknown> = proto === null ? Object.create(null) : {};
		seen.set(v, out);
		if (proto !== null && proto !== Object.prototype) {
			const name = isError ? (v as Error).name || 'Error' : `${proto.constructor?.name || 'class'} instance`;
			lost.push(`${path} (${name} → plain object)`);
		}
		const source = v as Record<string, unknown>;
		const keys = isError ? ['name', 'message', 'stack', ...Object.keys(v)] : Object.keys(v);
		for (const key of new Set(keys)) {
			const at = path + keyPath(key);
			if (key === '__proto__') { lose(at, 'reserved key'); continue; }
			let value: unknown;
			try {
				value = source[key];
			} catch {
				lose(at, 'getter threw');
				continue;
			}
			out[key] = visit(value, at);
		}
		return out;
	};

	const root: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(globals)) {
		try {
			root[name] = visit(value, name);
		} catch (e) {
			root[name] = lose(name, `unreadable: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { root, lost };
}

/** Encode user globals into a snapshot string. `lost` lists what won't come back intact. */
export function encodeState(globals: Record<string, unknown>): { text: string; lost: string[] } {
	const { root, lost: all } = prepare(globals);
	const lost = capList(all);
	const data = JSON.parse(stringify(root, reducers));
	return { text: JSON.stringify({ v: STATE_FORMAT, lost, data }), lost };
}

/**
 * Decode a snapshot. `lost` repeats what was lost on encoding, plus functions
 * whose source no longer evaluates. Throws on a foreign or corrupt snapshot.
 */
export function decodeState(text: string, revive: (src: string) => unknown = reviveFunction): { globals: Record<string, unknown>; lost: string[] } {
	const wrapper = JSON.parse(text);
	if (wrapper?.v !== STATE_FORMAT) throw new Error(`unsupported state format ${JSON.stringify(wrapper?.v)}`);
	const lost: string[] = Array.isArray(wrapper.lost) ? [...wrapper.lost] : [];
	const globals = unflatten(wrapper.data, {
		Fn: ([src, path]: [string, string]) => {
			try {
				return revive(src);
			} catch {
				lost.push(`${path} (function source could not be revived)`);
				return undefined;
			}
		},
		Lost: () => undefined,
	});
	return { globals, lost: capList(lost) };
}

/**
 * Rebuild a function from its source in the global scope. Method shorthand
 * (`name() {}`) is evaluated inside an object literal; accessors are not
 * functions on their own and throw.
 */
export function reviveFunction(src: string): Function {
	try {
		const fn = (0, eval)(`(${src})`);
		if (typeof fn === 'function') return fn;
	} catch {}
	const holder = (0, eval)(`({${src}})`);
	for (const key of Reflect.ownKeys(holder)) {
		const value = Object.getOwnPropertyDescriptor(holder, key)?.value;
		if (typeof value === 'function') return value;
	}
	throw new Error('not a function');
}

/** Content-addressed attachment id for a snapshot, so unchanged state reuses its row. */
export async function stateId(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return 'jsstate-' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
