/**
 * Tests for msgVars macro expansion (src/helpers/Extras.tsx). Run: bun test
 */
import { test, expect, describe } from 'bun:test';
import { msgVars, DERIVED_MACROS } from '../src/helpers/Extras';

describe('built-in macros', () => {
	test('model, folder and id are substituted', () => {
		expect(msgVars('m=@@model f=@@folder i=@@id', {}, 'gpt-4o', 'C:/work a$b', 'chat 1'))
			.toBe('m=gpt-4o f=C:/work a$b i=chat 1');
	});

	test('missing values become empty', () => {
		expect(msgVars('[@@model][@@folder][@@id]')).toBe('[][][]');
	});

	test('unknown macros are left alone', () => {
		expect(msgVars('@@nope')).toBe('@@nope');
	});
});

describe('chat macros', () => {
	test('values replace the macro, case-insensitively', () => {
		expect(msgVars('@@char and @@CHAR', { char: 'Bob' })).toBe('Bob and Bob');
	});

	test('replacement patterns in the value are not interpreted', () => {
		expect(msgVars('@@note', { note: 'costs $& and $` and $1' })).toBe('costs $& and $` and $1');
	});

	test('a macro name also matching a built-in prefix is not mangled', () => {
		expect(msgVars('@@model_x', { model_x: 'mine' })).toBe('mine');
	});
});

describe('derived macros', () => {
	for (const key of DERIVED_MACROS)
		test(`@@${key} expands when scanned`, () => {
			expect(msgVars(`before @@${key} after`, { [key]: 'VALUE' })).toBe('before VALUE after');
		});

	for (const key of DERIVED_MACROS)
		test(`@@${key} vanishes when the scan found nothing`, () => {
			expect(msgVars(`before @@${key} after`, {})).toBe('before  after');
			expect(msgVars(`@@${key}`, undefined)).toBe('');
		});

	test('only a whole word is dropped', () => {
		expect(msgVars('@@agents_extra', { agents_extra: 'kept' })).toBe('kept');
		expect(msgVars('@@widgets\n@@widgets')).toBe('\n');
	});
});
