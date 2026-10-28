import { test, expect, describe } from 'bun:test';
import { allowedKinds, childSchema, convertNode, defaultNode, freshKey, fromJson, toJson, type JsonSchema } from '../src/helpers/jsonTree';

describe('jsonTree', () => {
	test('round trips values and key order', () => {
		const value = { b: 1, a: [true, null, 'x', { n: -2.5 }], c: '' };
		const out = toJson(fromJson(value));
		expect(out).toEqual(value);
		expect(Object.keys(out as object)).toEqual(['b', 'a', 'c']);
	});

	test('invalid numbers throw', () => {
		const node = fromJson({ n: 1 });
		node.children[0]!.node.text = '1e';
		expect(() => toJson(node)).toThrow();
		node.children[0]!.node.text = '';
		expect(() => toJson(node)).toThrow();
	});

	test('conversion keeps what carries over', () => {
		const num = fromJson(5);
		convertNode(num, 'string');
		expect(toJson(num)).toBe('5');
		convertNode(num, 'number');
		expect(toJson(num)).toBe(5);
		const word = fromJson('abc');
		convertNode(word, 'number');
		expect(toJson(word)).toBe(0);
		const arr = fromJson(['x', 'y']);
		convertNode(arr, 'object');
		expect(toJson(arr)).toEqual({ 0: 'x', 1: 'y' });
		convertNode(arr, 'string');
		expect(toJson(arr)).toBe('');
	});

	test('fresh keys avoid existing ones', () => {
		expect(freshKey(fromJson({ key: 1, key2: 2 }))).toBe('key3');
	});
});

describe('jsonTree schema', () => {
	const schema: JsonSchema = {
		type: 'object',
		properties: {
			name: { type: 'string' },
			count: { type: 'integer', default: 3 },
			mode: { type: 'string', enum: ['a', 'b'] },
			tags: { type: 'array', items: { type: 'integer' } },
		},
		required: ['name'],
	};

	test('child schemas follow properties and items', () => {
		expect(childSchema(schema, 'object', 'count')?.type).toBe('integer');
		expect(childSchema(schema, 'object', 'other')).toBeUndefined();
		expect(childSchema(schema.properties!.tags, 'array', '')?.type).toBe('integer');
	});

	test('integer properties reject fractions', () => {
		const node = fromJson({ count: 2 });
		node.children[0]!.node.text = '2.5';
		expect(() => toJson(node, schema)).toThrow();
		expect(toJson(node)).toEqual({ count: 2.5 });
	});

	test('defaults use the schema', () => {
		expect(toJson(defaultNode(schema))).toEqual({ name: '' });
		expect(toJson(defaultNode(schema.properties!.count))).toBe(3);
		expect(toJson(defaultNode(schema.properties!.mode))).toBe('a');
		expect(allowedKinds({ type: ['string', 'null'] })).toEqual(['string', 'null']);
		expect(allowedKinds({})).toHaveLength(6);
	});
});
