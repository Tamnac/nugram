/** Editable tree model behind `JsonEditor`: JSON values with stable row ids, so edits keep focus and key order. */

export type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export interface JsonNode {
	kind: JsonKind;
	/** The string, or the number as typed, or 'true'/'false'. */
	text: string;
	children: JsonEntry[];
	open: boolean;
}

export interface JsonEntry {
	id: number;
	/** Property name; unused in arrays. */
	key: string;
	node: JsonNode;
}

export const JSON_KINDS: JsonKind[] = ['string', 'number', 'boolean', 'null', 'object', 'array'];

/** The subset of JSON Schema the editor follows: tool parameter schemas. */
export interface JsonSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: (string | number | boolean | null)[];
	default?: unknown;
}

let nextId = 0;

export const isContainer = (node: JsonNode) => node.kind === 'object' || node.kind === 'array';

export function newEntry(key: string, node: JsonNode): JsonEntry {
	return { id: nextId++, key, node };
}

export function emptyNode(kind: JsonKind): JsonNode {
	return { kind, text: kind === 'boolean' ? 'false' : kind === 'number' ? '0' : '', children: [], open: true };
}

export function fromJson(value: unknown): JsonNode {
	if (Array.isArray(value))
		return { ...emptyNode('array'), children: value.map(v => newEntry('', fromJson(v))) };
	if (value !== null && typeof value === 'object')
		return { ...emptyNode('object'), children: Object.entries(value).map(([k, v]) => newEntry(k, fromJson(v))) };
	if (typeof value === 'string') return { ...emptyNode('string'), text: value };
	if (typeof value === 'number') return { ...emptyNode('number'), text: String(value) };
	if (typeof value === 'boolean') return { ...emptyNode('boolean'), text: String(value) };
	return emptyNode('null');
}

export function isValidNumber(text: string): boolean {
	return text.trim() !== '' && Number.isFinite(Number(text));
}

/** Whether the schema allows only whole numbers. */
export const isIntegerSchema = (schema?: JsonSchema) => schema?.type === 'integer';

export function isValidNumberFor(text: string, schema?: JsonSchema): boolean {
	return isValidNumber(text) && (!isIntegerSchema(schema) || Number.isInteger(Number(text)));
}

/** The schema of a child: a named property, or an array's items. Undefined where the schema says nothing. */
export function childSchema(schema: JsonSchema | undefined, parent: JsonKind, key: string): JsonSchema | undefined {
	if (parent === 'array') return schema?.items;
	return schema?.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
}

/** An object whose schema lists its properties takes only those names. */
export const isClosedObject = (node: JsonNode, schema?: JsonSchema) => node.kind === 'object' && !!schema?.properties;

/** The node kinds a schema allows, first being the preferred one. All kinds when it has no `type`. */
export function allowedKinds(schema?: JsonSchema): JsonKind[] {
	const types = schema?.type === undefined ? [] : [schema.type].flat();
	const kinds = types.flatMap((t): JsonKind[] => t === 'integer' ? ['number'] : JSON_KINDS.includes(t as JsonKind) ? [t as JsonKind] : []);
	return kinds.length ? [...new Set(kinds)] : JSON_KINDS;
}

/** A starting value for a schema: its default, else an empty value of its first type (with required properties present). */
export function defaultNode(schema?: JsonSchema): JsonNode {
	if (schema?.default !== undefined) return fromJson(schema.default);
	const node = emptyNode(allowedKinds(schema)[0]!);
	if (schema?.enum?.length) node.text = String(schema.enum[0]);
	if (node.kind === 'object')
		node.children = (schema?.required ?? []).map(key => newEntry(key, defaultNode(childSchema(schema, 'object', key))));
	return node;
}

/** Throws if a number is not valid for its schema; the editor then keeps its last valid output. */
export function toJson(node: JsonNode, schema?: JsonSchema): unknown {
	switch (node.kind) {
		case 'string': return node.text;
		case 'number':
			if (!isValidNumberFor(node.text, schema)) throw new Error(`Invalid number: ${node.text}`);
			return Number(node.text);
		case 'boolean': return node.text === 'true';
		case 'null': return null;
		case 'array': return node.children.map(c => toJson(c.node, childSchema(schema, 'array', '')));
		case 'object': return Object.fromEntries(node.children.map(c => [c.key, toJson(c.node, childSchema(schema, 'object', c.key))]));
	}
}

/** Re-types a node in place, keeping what carries over (text between string/number, children between object/array). */
export function convertNode(node: JsonNode, kind: JsonKind): void {
	if (kind === node.kind) return;
	const from = node.kind;
	if (kind === 'object' || kind === 'array') {
		if (!isContainer(node)) node.children = [];
		else if (kind === 'object') node.children.forEach((c, i) => c.key ||= String(i));
		node.text = '';
	} else {
		node.children = [];
		const keepsText = (from === 'string' || from === 'number') && (kind === 'string' || isValidNumber(node.text));
		if (kind === 'boolean') node.text = node.text === 'true' ? 'true' : 'false';
		else if (kind === 'null') node.text = '';
		else if (!keepsText) node.text = kind === 'number' ? '0' : '';
	}
	node.kind = kind;
}

/** A property name not yet used in the object. */
export function freshKey(node: JsonNode): string {
	const used = new Set(node.children.map(c => c.key));
	if (!used.has('key')) return 'key';
	let n = 2;
	while (used.has(`key${n}`)) n++;
	return `key${n}`;
}
