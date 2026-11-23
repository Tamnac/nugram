import { describe, test, expect } from 'bun:test';
import { applyEdits } from '../src/helpers/editFile';

describe('applyEdits', () => {
	// ── Exact matching ──────────────────────────────────────────

	test('basic exact match', () => {
		const r = applyEdits('hello world', [{ oldText: 'hello', newText: 'goodbye' }]);
		expect(r.content).toBe('goodbye world');
		expect(r.applied).toBe(1);
		expect(r.failed).toBe(0);
	});

	test('multiple exact edits applied bottom-to-top', () => {
		const r = applyEdits('aaa\nbbb\nccc', [
			{ oldText: 'aaa', newText: 'AAA' },
			{ oldText: 'ccc', newText: 'CCC' },
		]);
		expect(r.content).toBe('AAA\nbbb\nCCC');
		expect(r.applied).toBe(2);
	});

	test('not found gives descriptive error', () => {
		const r = applyEdits('hello world', [{ oldText: 'xyz', newText: 'abc' }]);
		expect(r.applied).toBe(0);
		expect(r.failed).toBe(1);
		expect(r.outcomes[0].message).toContain('not found');
	});

	test('empty oldText rejected', () => {
		const r = applyEdits('hello', [{ oldText: '', newText: 'x' }]);
		expect(r.failed).toBe(1);
		expect(r.outcomes[0].message).toContain('empty');
	});

	test('no-op edit skipped', () => {
		const r = applyEdits('hello', [{ oldText: 'hello', newText: 'hello' }]);
		expect(r.skipped).toBe(1);
		expect(r.applied).toBe(0);
	});

	// ── Ambiguity ───────────────────────────────────────────────

	test('ambiguous match fails', () => {
		const r = applyEdits('abc\nabc\nabc', [{ oldText: 'abc', newText: 'xyz' }]);
		expect(r.failed).toBe(1);
		expect(r.outcomes[0].message).toContain('3 locations');
	});

	// ── Overlaps ────────────────────────────────────────────────

	test('overlapping edits both rejected', () => {
		const r = applyEdits('aabbcc', [
			{ oldText: 'aabb', newText: 'XX' },
			{ oldText: 'bbcc', newText: 'YY' },
		]);
		expect(r.failed).toBe(2);
		expect(r.outcomes[0].message).toContain('overlaps');
	});

	// ── Indentation adjustment ──────────────────────────────────

	test('multi-line dedented oldText auto-adjusts (transcript scenario)', () => {
		const file = '\t\t\t\t\t\t\t\t\t\tif (typeof x === "string")\n\t\t\t\t\t\t\t\t\t\t\tbuffer.arguments += y;';
		const r = applyEdits(file, [{
			oldText: 'if (typeof x === "string")\n\tbuffer.arguments += y;',
			newText: 'if (typeof x === "string") {\n\tbuffer.arguments += y;\n\ttoolCallTokens += 1;\n}'
		}]);
		expect(r.applied).toBe(1);
		expect(r.outcomes[0].adjusted).toBeTruthy();
		expect(r.outcomes[0].message).toBe('✓ edit 1 (lines 1–2)');
		expect(r.content).toBe(
			'\t\t\t\t\t\t\t\t\t\tif (typeof x === "string") {\n' +
			'\t\t\t\t\t\t\t\t\t\t\tbuffer.arguments += y;\n' +
			'\t\t\t\t\t\t\t\t\t\t\ttoolCallTokens += 1;\n' +
			'\t\t\t\t\t\t\t\t\t\t}'
		);
	});

	test('consistent over-indentation auto-adjusts', () => {
		const file = '\tif (typeof x === "string")\n\t\tbuffer.arguments += y;';
		const r = applyEdits(file, [{
			oldText: '\t\tif (typeof x === "string")\n\t\t\tbuffer.arguments += y;',
			newText: '\t\tif (typeof x === "string") {\n\t\t\tbuffer.arguments += y;\n\t\t\ttoolCallTokens += 1;\n\t\t}'
		}]);
		expect(r.applied).toBe(1);
		expect(r.failed).toBe(0);
		expect(r.content).toBe('\tif (typeof x === "string") {\n\t\tbuffer.arguments += y;\n\t\ttoolCallTokens += 1;\n\t}');
		expect(r.adjustments.get(0)).toEqual({ oldText: file, newText: r.content });
		expect(r.outcomes[0].message).toBe('✓ edit 1 (lines 1–2)');
	});

	test('space over-indentation adjusts while preserving blank lines', () => {
		const file = '  a();\n\n    b();';
		const r = applyEdits(file, [{
			oldText: '    a();\n  \n      b();',
			newText: '    a();\n \n      c();\n'
		}]);
		expect(r.applied).toBe(1);
		expect(r.content).toBe('  a();\n \n    c();\n');
	});

	test('over-indentation adjusts single-line edits and deletions', () => {
		const file = '\tx = 1;';
		const r = applyEdits(file, [{ oldText: '\t\tx = 1;', newText: '\t\tx = 2;' }]);
		expect(r.content).toBe('\tx = 2;');
		expect(r.adjustments.get(0)).toEqual({ oldText: file, newText: r.content });
		const deletion = applyEdits(file, [{ oldText: '\t\tx = 1;', newText: '' }]);
		expect(deletion.applied).toBe(1);
		expect(deletion.content).toBe('');
	});

	test('over-indentation rejects newText missing the removable prefix', () => {
		const file = '\tx = 1;';
		const r = applyEdits(file, [{ oldText: '\t\tx = 1;', newText: 'x = 2;' }]);
		expect(r.failed).toBe(1);
		expect(r.content).toBe(file);
		expect(r.adjustments.size).toBe(0);
	});

	test('inconsistent over-indentation is rejected', () => {
		const file = '\ta();\n\t\tb();';
		const r = applyEdits(file, [{ oldText: '\t\t\ta();\n\t\t\tb();', newText: '\t\t\tc();' }]);
		expect(r.failed).toBe(1);
		expect(r.content).toBe(file);
	});

	test('ambiguous over-indentation is rejected', () => {
		const file = '\ta();\n\ta();';
		const r = applyEdits(file, [{ oldText: '\t\ta();', newText: '\t\tb();' }]);
		expect(r.failed).toBe(1);
		expect(r.content).toBe(file);
		expect(r.outcomes[0].message).toContain('2 locations');
	});

	test('consistent partial dedent adjusts', () => {
		const file = '\t\t\t\t\t\t\t\t\t\tif (x)\n\t\t\t\t\t\t\t\t\t\t\ty = 1;';
		const r = applyEdits(file, [{
			oldText: '\tif (x)\n\t\ty = 1;',
			newText: '\tif (x) {\n\t\ty = 1;\n\t}'
		}]);
		expect(r.applied).toBe(1);
		// Prefix should be 9 tabs (file has 10, oldText has 1)
		expect(r.content).toBe(
			'\t\t\t\t\t\t\t\t\t\tif (x) {\n' +
			'\t\t\t\t\t\t\t\t\t\t\ty = 1;\n' +
			'\t\t\t\t\t\t\t\t\t\t}'
		);
	});

	test('inconsistent dedent rejected', () => {
		const file = '\t\t\t\t\t\t\t\t\t\tif (x)\n\t\t\t\t\t\t\t\t\t\t\ty = 1;';
		// 0 tabs / 0 tabs — file is 10/11 so deltas 10 vs 11, inconsistent
		const r = applyEdits(file, [{
			oldText: 'if (x)\ny = 1;',
			newText: 'if (x) {\ny = 1;\n}'
		}]);
		expect(r.failed).toBe(1);
		expect(r.outcomes[0].message).toContain('indentation differs');
	});

	test('diagnostic points at first mismatching line, not line 1', () => {
		// First line matches exactly; middle lines are one tab short (non-uniform → no adjustment)
		const file = '\t\t\ta();\n\t\t\tif (x) {\n\t\t\t\tb();\n\t\t\t}';
		const r = applyEdits(file, [{
			oldText: '\t\t\ta();\n\t\t\tif (x) {\n\t\t\tb();\n\t\t}',
			newText: '\t\t\ta();'
		}]);
		expect(r.failed).toBe(1);
		const msg = r.outcomes[0].message;
		expect(msg).toContain('matches lines 1–4');
		expect(msg).toContain('at line 3 "b();"');
		expect(msg).toContain('file has 4 tabs, oldText has 3 tabs');
		expect(msg).toContain('and on 1 more line');
	});

	test('blank line in oldText preserved during adjustment', () => {
		const file = '\t\tline1\n\n\t\tline3';
		const r = applyEdits(file, [{
			oldText: 'line1\n\nline3',
			newText: 'line1\ninserted\nline3'
		}]);
		expect(r.applied).toBe(1);
		expect(r.content).toBe('\t\tline1\n\t\tinserted\n\t\tline3');
	});

	test('adjustment returns corrected edits in adjustments map', () => {
		// Multi-line needed to trigger adjustment (single-line matches via substring)
		const file = '\t\tlet x = 1;\n\t\tlet y = 2;';
		const r = applyEdits(file, [{ oldText: 'let x = 1;\nlet y = 2;', newText: 'let x = 10;\nlet y = 20;' }]);
		expect(r.applied).toBe(1);
		expect(r.adjustments.size).toBe(1);
		const adj = r.adjustments.get(0)!;
		expect(adj.oldText).toBe('\t\tlet x = 1;\n\t\tlet y = 2;');
		expect(adj.newText).toBe('\t\tlet x = 10;\n\t\tlet y = 20;');
	});

	test('exact match does not produce adjustment', () => {
		const file = '\t\tlet x = 1;';
		const r = applyEdits(file, [{ oldText: '\t\tlet x = 1;', newText: '\t\tlet x = 2;' }]);
		expect(r.applied).toBe(1);
		expect(r.adjustments.size).toBe(0);
	});

	test('CRLF in edit normalized', () => {
		const file = 'hello\nworld';
		const r = applyEdits(file, [{ oldText: 'hello\r\nworld', newText: 'goodbye\r\nworld' }]);
		expect(r.applied).toBe(1);
		expect(r.content).toBe('goodbye\nworld');
	});

	test('adjustment with multiple ws matches fails', () => {
		const file = '\t\tx = 1;\nother\n\t\tx = 1;';
		const r = applyEdits(file, [{ oldText: 'x = 1;', newText: 'x = 2;' }]);
		// Two ws matches, adjustment can't pick. The exact indexOf also finds
		// 2 matches ("x = 1;" is a substring at both locations), so this hits
		// the exact-match ambiguity path.
		expect(r.failed).toBe(1);
	});
});
