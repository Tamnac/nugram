/**
 * run_js tool functions: argument mapping and declarations (helpers/jsRuntime/signatures.ts).
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { callArgs, callSource, declarations, isFunctionName, shortSignature } from '../src/helpers/jsRuntime/signatures';

const readFile = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'File path' },
		range: { type: 'string' },
		crop: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' } }, required: ['x1', 'y1'] },
	},
	required: ['path'],
};
const lore = { type: 'object', properties: { entry: { type: 'object' }, mode: { type: 'string' } }, required: ['entry'] };
const noRequired = { type: 'object', properties: { min: { type: 'integer' } } };

describe('callArgs', () => {
	test('required parameters in order, then an options object', () => {
		expect(callArgs('read_file', readFile, ['a.ts'])).toEqual({ path: 'a.ts' });
		expect(callArgs('read_file', readFile, ['a.ts', { range: '1:5' }])).toEqual({ path: 'a.ts', range: '1:5' });
		expect(callArgs('read_file', readFile, ['a.ts', { path: 'ignored' }])).toEqual({ path: 'a.ts' });
		expect(callArgs('read_file', readFile, [undefined, undefined])).toEqual({});
	});

	test('a lone plain object is the whole arguments object, unless the first parameter is an object', () => {
		expect(callArgs('read_file', readFile, [{ path: 'a.ts', range: '2:' }])).toEqual({ path: 'a.ts', range: '2:' });
		expect(callArgs('random_number', noRequired, [{ min: 2 }])).toEqual({ min: 2 });
		expect(callArgs('lore', lore, [{ name: 'x' }])).toEqual({ entry: { name: 'x' } });
		expect(callArgs('read_file', readFile, [new Map()])).toEqual({ path: new Map() });
	});

	test('too many arguments and non-object options throw with the signature', () => {
		expect(() => callArgs('read_file', readFile, ['a', {}, 3])).toThrow('read_file(path, opts?) takes at most 2 arguments, got 3');
		expect(() => callArgs('read_file', readFile, ['a', '1:5'])).toThrow('read_file(path, opts?): the last argument must be an object of the optional parameters (range, crop)');
		expect(() => callArgs('lore', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, ['x', {}])).toThrow('lore(a) takes at most 1 argument, got 2');
		expect(() => callArgs('none', undefined, [1])).toThrow('none() takes at most 0 arguments, got 1');
		expect(callArgs('none', undefined, [undefined])).toEqual({});
	});
});

describe('callSource', () => {
	test('the function form callArgs maps back to the same arguments', () => {
		expect(callSource('read_file', readFile, { path: 'a.ts' })).toBe('read_file("a.ts")');
		expect(callSource('read_file', readFile, { range: '1:5', path: 'a.ts', 'odd-key': 1 })).toBe('read_file("a.ts", { range: "1:5", "odd-key": 1 })');
		expect(callSource('lore', lore, { entry: { name: 'x' } })).toBe('lore({ name: "x" })');
		expect(callSource('random_number', noRequired, { min: 2 })).toBe('random_number({ min: 2 })');
		expect(callSource('random_number', noRequired, {})).toBe('random_number()');
	});

	test('JSON-encoded arrays and objects are decoded', () => {
		const edit = { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] };
		expect(callSource('edit_file', edit, { path: 't', edits: '[{"oldText":"","newText":"x"}]' })).toBe('edit_file("t", [{ oldText: "", newText: "x" }])');
		expect(callSource('edit_file', edit, { path: 't', edits: '[oops' })).toBe('edit_file("t", "[oops")');
	});

	test('tool() when the function form cannot express the call', () => {
		expect(callSource('read_file', readFile, { range: '1:5' })).toBe('tool("read_file", { range: "1:5" })');
		expect(callSource('mcp:x', undefined, {})).toBe('tool("mcp:x", {})');
		const untyped = { type: 'object', properties: { q: {} }, required: ['q'] };
		expect(callSource('q', untyped, { q: { a: 1 } })).toBe('tool("q", { q: { a: 1 } })');
	});
});

describe('declarations', () => {
	test('descriptions become comments, returns go in the doc comment', () => {
		expect(declarations([{ name: 'read_file', description: 'Read a file.\nLine two', parameters: readFile, returns: '{ body: string }' }])).toBe([
			'/**',
			' * Read a file.',
			' * Line two',
			' * data: { body: string }',
			' */',
			'read_file(',
			'\tpath: string, // File path',
			'\topts?: { range?: string, crop?: { x1: number, y1: number } },',
			')',
		].join('\n'));
	});

	test('signatures without comments stay on one line', () => {
		expect(declarations([
			{ name: 'roll', description: 'Roll', parameters: noRequired },
			{ name: 'ping', parameters: { type: 'object', properties: {} } },
		])).toBe('/** Roll */\nroll(opts?: { min?: number })\n\nping()');
	});

	test('arrays, enums, unions and nested blocks', () => {
		const parameters = {
			type: 'object',
			properties: {
				edits: { type: 'array', description: 'Edits', items: { type: 'object', properties: { old: { type: 'string', description: 'Find' } }, required: ['old'] } },
				tags: { type: 'array', items: { enum: ['a', 'b'] } },
				value: { type: ['string', 'null'] },
			},
			required: ['edits'],
		};
		expect(declarations([{ name: 'edit', parameters }])).toBe([
			'edit(',
			'\tedits: { // Edits',
			'\t\told: string, // Find',
			'\t}[],',
			'\topts?: { tags?: ("a" | "b")[], value?: string | null },',
			')',
		].join('\n'));
	});

	test('tools that cannot be functions are left out', () => {
		expect(isFunctionName('mcp:server.tool')).toBe(false);
		expect(declarations([{ name: 'mcp:server.tool' }])).toBe('');
		expect(shortSignature('x', noRequired)).toBe('x(opts?)');
	});
});
