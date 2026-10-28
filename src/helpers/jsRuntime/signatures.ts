/**
 * run_js tool functions: how a call like `read_file(path, { range })` maps onto
 * the tool's arguments object, and the TypeScript-like declarations of those
 * functions sent in run_js-only mode. Positional parameters are the schema's
 * `required` list in order (an API, like `ToolModule.returns`); the other
 * parameters go in a trailing options object.
 */

type Schema = {
	type?: string | string[];
	description?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	enum?: unknown[];
	anyOf?: Schema[];
	oneOf?: Schema[];
};

export interface ToolSignature { name: string; description?: string | undefined; parameters?: object | undefined; returns?: string | undefined }

/** Tools whose name can be a global function; the rest are only reachable through `tool()`. */
export const isFunctionName = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
	if (typeof v !== 'object' || v === null) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

const typeOf = (schema: Schema | undefined) => Array.isArray(schema?.type) ? schema.type[0] : schema?.type;

function shape(parameters: object | undefined) {
	const schema = (parameters ?? {}) as Schema;
	const props = schema.properties ?? {};
	const positional = schema.required ?? [];
	const optional = Object.keys(props).filter(name => !positional.includes(name));
	return { props, positional, optional };
}

/** `read_file(path, opts?)`, for error messages. */
export function shortSignature(name: string, parameters: object | undefined): string {
	const { positional, optional } = shape(parameters);
	return `${name}(${[...positional, ...(optional.length ? ['opts?'] : [])].join(', ')})`;
}

/**
 * The arguments object for a tool function call. A lone plain object is taken
 * as the whole arguments object (the `tool()` form), unless the first
 * positional parameter is itself an object. Missing required arguments are
 * left for the tool to report.
 */
export function callArgs(name: string, parameters: object | undefined, args: unknown[]): Record<string, unknown> {
	const { props, positional, optional } = shape(parameters);
	while (args.length && args[args.length - 1] === undefined) args = args.slice(0, -1);
	if (args.length === 1 && isPlainObject(args[0]) && !(positional.length && typeOf(props[positional[0]!]) === 'object'))
		return { ...args[0] };
	const max = positional.length + (optional.length ? 1 : 0);
	if (args.length > max)
		throw new TypeError(`${shortSignature(name, parameters)} takes at most ${max} argument${max === 1 ? '' : 's'}, got ${args.length}`);
	const out: Record<string, unknown> = {};
	positional.forEach((param, i) => { if (args[i] !== undefined) out[param] = args[i]; });
	const opts = args[positional.length];
	if (opts === undefined) return out;
	if (!isPlainObject(opts))
		throw new TypeError(`${shortSignature(name, parameters)}: the last argument must be an object of the optional parameters (${optional.join(', ')})`);
	return { ...opts, ...out };
}

/**
 * The source of a tool function call with these arguments, the inverse of
 * `callArgs`; `tool(name, args)` when the function form can't express them.
 * Array and object arguments sent JSON-encoded as strings are decoded.
 */
export function callSource(name: string, parameters: object | undefined, args: Record<string, unknown>): string {
	const { props, positional } = shape(parameters);
	args = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, decoded(props[key], value)]));
	const fallback = `tool(${literal(name)}, ${literal(args)})`;
	if (!isFunctionName(name) || positional.some(param => args[param] === undefined)) return fallback;
	const list: unknown[] = positional.map(param => args[param]);
	const opts = Object.fromEntries(Object.entries(args).filter(([key]) => !positional.includes(key)));
	if (Object.keys(opts).length) list.push(opts);
	try {
		if (!sameArgs(callArgs(name, parameters, list), args)) return fallback;
	} catch {
		return fallback;
	}
	return `${name}(${list.map(literal).join(', ')})`;
}

function decoded(schema: Schema | undefined, value: unknown): unknown {
	const type = typeOf(schema);
	if (typeof value !== 'string' || (type !== 'array' && type !== 'object')) return value;
	try {
		const parsed = JSON.parse(value);
		return (type === 'array' ? Array.isArray(parsed) : isPlainObject(parsed)) ? parsed : value;
	} catch {
		return value;
	}
}

const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>) =>
	Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));

/** A JSON value as JavaScript source, identifier keys unquoted. */
function literal(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
	if (isPlainObject(value)) {
		const entries = Object.entries(value).map(([key, v]) => `${isFunctionName(key) ? key : JSON.stringify(key)}: ${literal(v)}`);
		return entries.length ? `{ ${entries.join(', ')} }` : '{}';
	}
	return JSON.stringify(value) ?? 'undefined';
}

/** Declarations of the tool functions, descriptions as comments. */
export function declarations(tools: ToolSignature[]): string {
	return tools.filter(t => isFunctionName(t.name)).map(declaration).join('\n\n');
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim();

function declaration(tool: ToolSignature): string {
	const { props, positional, optional } = shape(tool.parameters);
	const params = positional.map(name => member(name, props[name] ?? {}, false, '\t'));
	if (optional.length) params.push(member('opts', { properties: Object.fromEntries(optional.map(n => [n, props[n]!])), required: [] }, true, '\t'));
	const inline = params.every(p => !p.includes('\n') && !p.includes('//'));
	const list = inline
		? params.map(p => p.trim().replace(/,$/, '')).join(', ')
		: `\n${params.join('\n')}\n`;
	const doc = [tool.description?.trim(), tool.returns && `data: ${tool.returns}`]
		.filter(Boolean).flatMap(text => text!.replaceAll('*/', '*\\/').split('\n'));
	const head = doc.length === 0 ? '' : doc.length === 1 ? `/** ${doc[0]} */\n` : `/**\n${doc.map(l => ` * ${l}`).join('\n')}\n */\n`;
	return `${head}${tool.name}(${list})`;
}

/** `name?: type, // description`; a block type carries the comment on its first line. */
function member(name: string, schema: Schema, optional: boolean, indent: string): string {
	const [first, ...rest] = `${indent}${name}${optional ? '?' : ''}: ${typeText(schema, indent)},`.split('\n');
	const comment = schema.description ? ` // ${oneLine(schema.description)}` : '';
	return [first + comment, ...rest].join('\n');
}

function typeText(schema: Schema, indent: string): string {
	if (schema.enum) return schema.enum.map(v => JSON.stringify(v)).join(' | ');
	const variants = schema.anyOf ?? schema.oneOf;
	if (variants) return variants.map(v => typeText(v, indent)).join(' | ');
	if (Array.isArray(schema.type)) return schema.type.map(type => typeText({ ...schema, type }, indent)).join(' | ');
	switch (schema.type) {
		case 'string': case 'boolean': case 'null': return schema.type;
		case 'integer': case 'number': return 'number';
		case 'array': {
			const item = schema.items ? typeText(schema.items, indent) : 'unknown';
			return /^[\w{]/.test(item) && !item.includes(' | ') ? `${item}[]` : `(${item})[]`;
		}
	}
	if (!schema.properties) return schema.type === 'object' ? 'object' : 'unknown';
	const required = schema.required ?? [];
	const members = Object.entries(schema.properties).map(([name, s]) => member(name, s, !required.includes(name), indent + '\t'));
	return members.every(m => !m.includes('\n') && !m.includes('//'))
		? `{ ${members.map(m => m.trim().replace(/,$/, '')).join(', ')} }`
		: `{\n${members.join('\n')}\n${indent}}`;
}
