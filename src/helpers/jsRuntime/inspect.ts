/** How run_js shows values and errors to the model. Pure, shared by the Worker and tests. */

/** Strings as-is; everything else as JSON with Map → entries, Set → array, BigInt → string. */
export function inspect(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined) return 'undefined';
	if (typeof value !== 'object' || value === null) return String(jsonable(value, []));
	try {
		return JSON.stringify(jsonable(value, [])) ?? String(value);
	} catch {
		return String(value);
	}
}

function jsonable(v: unknown, ancestors: object[]): unknown {
	if (typeof v === 'bigint') return String(v);
	if (typeof v === 'function') return `[Function ${v.name || '(anonymous)'}]`;
	if (typeof v === 'symbol') return String(v);
	if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
	if (typeof v !== 'object' || v === null) return v;
	if (ancestors.includes(v)) return '[Circular]';
	if (v instanceof Error) return `${v.name}: ${v.message}`;
	if (v instanceof Date) return Number.isNaN(+v) ? 'Invalid Date' : v.toISOString();
	if (v instanceof RegExp) return String(v);
	ancestors.push(v);
	try {
		if (v instanceof Map) return [...v].map(([k, x]) => [jsonable(k, ancestors), jsonable(x, ancestors)]);
		if (v instanceof Set) return [...v].map(x => jsonable(x, ancestors));
		if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<unknown>, x => jsonable(x, ancestors));
		if (Array.isArray(v)) return v.map(x => jsonable(x, ancestors));
		const source = v as Record<string, unknown>;
		if (typeof source.toJSON === 'function') return jsonable(source.toJSON(), ancestors);
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source)) out[key] = jsonable(source[key], ancestors);
		return out;
	} finally {
		ancestors.pop();
	}
}

/**
 * An error thrown by a snippet: message plus the stack frames inside snippet
 * code (`<anonymous>`), with the Function-constructor header lines
 * (`lineOffset`) subtracted so line numbers match the snippet. Non-errors are
 * shown as values; callers add any "Uncaught" prefix.
 */
export function describeError(e: unknown, lineOffset = 0): string {
	if (!(e instanceof Error)) return inspect(e);
	const frames = (e.stack ?? '').split('\n')
		.filter(line => line.includes('<anonymous>:'))
		.map(line => '    ' + line.trim()
			.replace(/\(eval at .*?, (<anonymous>:\d+:\d+)\)$/, '($1)')
			.replace(/<anonymous>:(\d+):(\d+)/, (_, l, c) => `line ${Math.max(1, Number(l) - lineOffset)}:${c}`));
	return [`${e.name}: ${e.message}`, ...frames].join('\n');
}
