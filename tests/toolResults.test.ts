/**
 * Tool result content resolution: structured `data` is the source of truth and
 * the model-facing text is formatted from it, while a stored `content` override
 * (user edits, and chats written before `data` existed) always wins.
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { createStore } from 'solid-js/store';

const kvStore = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => kvStore.get(k) ?? null,
	setItem: (k: string, v: string) => kvStore.set(k, v),
	removeItem: (k: string) => kvStore.delete(k),
	clear: () => kvStore.clear(),
};
(globalThis as any).navigator = { platform: 'Win32' };
(globalThis as any).window = {};

const { resolveContent, isPending, toolModules, applyToolCalls, tools } = await import('../src/helpers/tools');
const { buildRequestMessages } = await import('../src/helpers/buildRequest');
import type { ChatMessage, ToolCall, ToolResult } from '../src/helpers/types';
import { createFileContentData } from '../src/helpers/fileContent';

const result = (r: Partial<ToolResult> & { name: string }): ToolResult =>
	({ tool_call_id: 'c1', ...r });

describe('resolveContent', () => {
	test('formats from structured data', () => {
		expect(resolveContent(result({ name: 'random_number', data: { value: 42 } })))
			.toBe('Random number: 42');
	});

	test('a content override wins over data', () => {
		const r = result({ name: 'random_number', data: { value: 42 }, content: 'edited by user' });
		expect(resolveContent(r)).toBe('edited by user');
	});

	test('an empty override is respected, not treated as missing', () => {
		expect(resolveContent(result({ name: 'shell', data: { exit_code: 0, stdout: 'hi' }, content: '' }))).toBe('');
	});

	test('legacy results (content, no data) pass through untouched', () => {
		const legacy = result({ name: 'shell', content: 'Exit code: 0\n\nhello' });
		expect(resolveContent(legacy)).toBe('Exit code: 0\n\nhello');
	});

	test('error data short-circuits the formatter', () => {
		// grep_lore's format would throw on absent `results`
		expect(resolveContent(result({ name: 'grep_lore', data: { ok: false, error: 'Lore system not available' } })))
			.toBe('Lore system not available');
	});

	test('unknown tools and empty results degrade quietly', () => {
		expect(resolveContent(result({ name: 'no_such_tool', data: { foo: 1 } }))).toBe('');
		expect(resolveContent(result({ name: 'shell' }))).toBe('');
	});

	test('a throwing formatter falls back instead of breaking the request', () => {
		// read_file's format reads data.body; a malformed row must not throw
		expect(() => resolveContent(result({ name: 'read_file', data: { path: 'a.txt' } }))).not.toThrow();
	});

	test('re-resolving after data is replaced reflects the new data', () => {
		const r = result({ name: 'shell', data: { running: true, stdout: 'partial\n', stderr: '' } });
		expect(resolveContent(r)).toBe('partial\n');
		r.data = { ok: true, exit_code: 0, duration_ms: 10, stdout: 'done', stderr: '' };
		expect(resolveContent(r)).toBe('Exit code: 0\n\ndone');
	});
});

describe('isPending', () => {
	test('true only when neither data nor content is set', () => {
		expect(isPending(undefined)).toBe(true);
		expect(isPending(result({ name: 'shell' }))).toBe(true);
		expect(isPending(result({ name: 'shell', data: { running: true, stdout: '' } }))).toBe(false);
		// An edit to empty string is a real (empty) result, not a pending one
		expect(isPending(result({ name: 'shell', content: '' }))).toBe(false);
	});
});

describe('format round-trips', () => {
	test('shell reproduces headers, duration, truncation and stderr', () => {
		const fmt = toolModules.shell.format;
		expect(fmt({ exit_code: 0, duration_ms: 10, stdout: 'out', stderr: '' }))
			.toBe('Exit code: 0\n\nout');
		expect(fmt({ exit_code: 1, duration_ms: 1500, stdout: 'out', stderr: 'bad' }))
			.toBe('Exit code: 1 (1.5s)\n\nout\n\nSTDERR:\nbad');
		expect(fmt({ exit_code: 0, duration_ms: 0, stdout: 'tail', stderr: '', truncated: true, fullLen: 90000 }))
			.toBe('Exit code: 0 (90000 bytes total)\n\n...[truncated, use previous=true to get full output]\ntail');
		expect(fmt({ previous: true, exit_code: 2, stdout: 'full', stderr: '' }))
			.toBe('Full previous output:\n\nExit code: 2\n\nfull');
		// While streaming there is no exit code yet, just the partial output
		expect(fmt({ running: true, stdout: 'line1\n', stderr: '' })).toBe('line1\n');
	});

	test('read_file truncation keeps whole lines and reports the real end line', () => {
		// 2000 lines of 40 chars overflows the 50KB numbered budget
		const lines = Array.from({ length: 2000 }, () => 'x'.repeat(40));
		const body = lines.join('\n');
		// Mirror execute()'s budget loop: the stored body must end on a line boundary
		// and format()'s output must stay within ~50KB.
		const text = toolModules.read_file.format({
			path: 'a.ts', body: lines.slice(0, 1063).join('\n'), start: 0, end: 1063, total: 2000, truncated: true,
		});
		expect(text.endsWith('...[truncated at 50KB]')).toBe(true);
		expect(text).toContain('(lines 1\u20131063 of 2000)');
		expect(text.length).toBeLessThan(52000);
		expect(body.length).toBeGreaterThan(0);
	});

	test('read_file truncation helper keeps whole lines within the numbered budget', () => {
		const data = createFileContentData(Array.from({ length: 2000 }, () => 'x'.repeat(40)).join('\n'), 'a.ts');
		expect(data.truncated).toBe(true);
		expect(data.end).toBeLessThan(2000);
		expect(toolModules.read_file.format(data).length).toBeLessThanOrEqual(50050);
	});

	test('read_file re-adds the line gutter and range header', () => {
		const text = toolModules.read_file.format({ path: 'a.ts', body: 'x\ny', start: 4, end: 6, total: 10 });
		expect(text).toBe('a.ts (lines 5\u20136 of 10)\n\n5\u2502x\n6\u2502y');
		expect(toolModules.read_file.format({ path: 'a.ts', body: 'x', start: 0, end: 1, total: 1 }))
			.toBe('a.ts (1 lines)\n\n1\u2502x');
	});

	test('edit_file reproduces status lines and the applied summary', () => {
		const fmt = toolModules.edit_file.format;
		expect(fmt({
			path: 'a.ts', applied: 1, failed: 1, skipped: 0, total: 2,
			outcomes: [
				{ applied: true, line: 5, message: '\u2713 edit 1 (line 5)' },
				{ applied: false, message: '\u2717 edit 2: not found: "foo"' },
			],
		})).toBe('edit_file: a.ts\n\u2713 edit 1 (line 5)\n\u2717 edit 2: not found: "foo"\n1/2 edits applied, 1 failed');

		expect(fmt({
			path: 'a.ts', applied: 0, failed: 1, skipped: 0, total: 1,
			outcomes: [{ applied: false, message: '\u2717 edit 1: not found' }],
		})).toBe('edit_file: a.ts\n1 edit failed:\n\u2717 edit 1: not found');

		expect(fmt({ path: 'new.ts', created: true, lines: 3 }))
			.toBe('Created new file new.ts (3 lines). All newText concatenated, oldText ignored.');
		expect(fmt({ denied: true, message: 'User denied the edit' })).toBe('User denied the edit');
	});

	test('fetch_url marks truncation in both modes', () => {
		const fmt = toolModules.fetch_url.format;
		expect(fmt({ mode: 'raw', status: 200, statusText: 'OK', body: 'hi', truncated: false }))
			.toBe('Status: 200 OK\n\nhi');
		expect(fmt({ mode: 'extract', body: 'md', truncated: true })).toBe('md\n...[truncated]');
		expect(fmt({ mode: 'extract', body: '', truncated: false })).toBe('(no content extracted)');
	});

	test('lore tools format through the shared lore serializers', () => {
		expect(toolModules.grep_lore.format({ query: 'elf', results: [{ name: 'Elves', description: 'tall' }] }))
			.toContain('- `Elves` description: tall');
		expect(toolModules.read_lore_entries.format({ entries: [{ name: 'Elves', content: 'body' }] }))
			.toBe('<lore name="Elves">\n\nbody\n\n</lore>');
		expect(toolModules.edit_lore_entry.format({ name: 'Elves', mode: 'append', isNew: true, lines: 2 }))
			.toBe('Created lore entry "Elves":\n2 lines appended');
	});
});

describe('streaming updates through the store', () => {
	// Solid merges when both old and new values of a key are objects, so writing
	// `data` directly would keep stale fields and mutate in place — which also
	// poisons the identity-keyed format cache. Results must be patched instead.
	const partial = { running: true, stdout: 'line1\n', stderr: '', previous: false };
	const final = { ok: true, exit_code: 0, duration_ms: 1500, stdout: 'line1\nline2\n', stderr: '' };

	test('patching the result replaces data wholesale', () => {
		const [results, setResults] = createStore<ToolResult[]>([result({ name: 'shell', data: partial })]);
		expect(resolveContent(results[0])).toBe('line1\n');

		setResults(0, { data: final });

		expect(results[0].data!.running).toBeUndefined();
		expect(resolveContent(results[0])).toBe('Exit code: 0 (1.5s)\n\nline1\nline2\n');
	});

	test('writing the data key directly would merge and go stale', () => {
		const [results, setResults] = createStore<ToolResult[]>([result({ name: 'shell', data: { ...partial } })]);
		resolveContent(results[0]);

		setResults(0, 'data', { ...final });

		// Documents the footgun: the finished command still looks like it's running
		expect(results[0].data!.running).toBe(true);
	});
});

describe('step ordering', () => {
	// A tool of known timing: every start/end is recorded, so overlap (parallel)
	// and strict alternation (sequential) are both directly observable.
	const events: string[] = [];
	toolModules.test_tool = {
		definition: { type: 'function', function: { name: 'test_tool', parameters: { type: 'object', properties: {} } } },
		async execute(call: ToolCall) {
			const args = call.function.arguments as any;
			events.push(`start ${args.tag}`);
			await new Promise(r => setTimeout(r, args.ms ?? 0));
			events.push(`end ${args.tag}`);
			return args.fail ? { ok: false, error: 'boom' } : { ok: true, tag: args.tag };
		},
		format: (data: any) => `ran ${data.tag}`,
	} as any;

	const call = (tag: string, args: Record<string, any> = {}): ToolCall =>
		({ id: tag, type: 'function', function: { name: 'test_tool', arguments: { tag, ...args } } });

	const run = (calls: ToolCall[]) => { events.length = 0; return applyToolCalls(calls, {}); };

	test('every schema advertises the step parameter', () => {
		expect(tools.every(t => (t.function.parameters as any).properties.step)).toBe(true);
	});

	test('unlabelled calls run in parallel, as before steps existed', async () => {
		await run([call('a', { ms: 10 }), call('b')]);
		expect(events).toEqual(['start a', 'start b', 'end b', 'end a']);
	});

	test('calls sharing a step run in parallel', async () => {
		await run([call('a', { ms: 10, step: 1 }), call('b', { step: 1 })]);
		expect(events).toEqual(['start a', 'start b', 'end b', 'end a']);
	});

	test('steps run in ascending order regardless of array order', async () => {
		const results = await run([call('b', { step: 2 }), call('a', { step: 1, ms: 10 })]);
		expect(events).toEqual(['start a', 'end a', 'start b', 'end b']);
		expect(results.map(r => r.tool_call_id)).toEqual(['a', 'b']);
	});

	test('a failure skips every later step', async () => {
		const results = await run([
			call('a', { step: 1, fail: true }),
			call('b', { step: 2 }),
			call('c', { step: 3 }),
		]);
		expect(events).toEqual(['start a', 'end a']);
		expect(results.map(r => r.tool_call_id)).toEqual(['a', 'b', 'c']);
		expect(results[1].data).toMatchObject({ ok: false, skipped: true });
		expect(results[2].data.error).toBe('Skipped: step 1 failed (test_tool)');
	});

	test('the rest of a failing step still finishes', async () => {
		await run([call('a', { step: 1, fail: true }), call('b', { step: 1, ms: 10 })]);
		expect(events).toEqual(['start a', 'start b', 'end a', 'end b']);
	});

	test('a skipped result reads as a failure to the model', async () => {
		const results = await run([call('a', { step: 1, fail: true }), call('b', { step: 2 })]);
		expect(resolveContent({ ...results[1], name: 'test_tool' })).toBe('Skipped: step 1 failed (test_tool)');
	});
});

describe('buildRequestMessages', () => {
	const msgWithResult = (r: ToolResult): ChatMessage[] => ([{
		role: 'assistant',
		content: [''],
		currentVersionIndex: 0,
		tool_calls: [[{ id: 'c1', type: 'function', function: { name: r.name, arguments: {} } }]],
		tool_results: [[r]],
	}]);

	const build = (msgs: ChatMessage[]) =>
		buildRequestMessages(msgs, { provider: 'or', prompts: [], cache: 'none', cacheLength: 'full', model: 'gpt-4' } as any);

	test('sends formatted text and never leaks structured data', () => {
		const out = build(msgWithResult(result({ name: 'random_number', data: { value: 7 } })));
		const toolMsg = out.find(m => m.role === 'tool') as any;
		expect(toolMsg.content).toBe('Random number: 7');
		expect(toolMsg.data).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain('"value"');
	});

	test('sends the override for edited and legacy results', () => {
		const edited = build(msgWithResult(result({ name: 'random_number', data: { value: 7 }, content: 'nine' })));
		expect((edited.find(m => m.role === 'tool') as any).content).toBe('nine');

		const legacy = build(msgWithResult(result({ name: 'shell', content: 'Exit code: 0\n\nold' })));
		expect((legacy.find(m => m.role === 'tool') as any).content).toBe('Exit code: 0\n\nold');
	});

	test('a pending result sends empty text rather than undefined', () => {
		const out = build(msgWithResult(result({ name: 'shell' })));
		expect((out.find(m => m.role === 'tool') as any).content).toBe('');
	});

	test('images in result data are sent as content parts after the text', () => {
		const out = build(msgWithResult(result({
			name: 'read_file',
			data: { path: 'C:/pic.png', images: ['data:image/webp;base64,AAA'], bytes: 2048 },
		})));
		const toolMsg = out.find(m => m.role === 'tool') as any;
		expect(toolMsg.content).toEqual([
			{ type: 'text', text: 'C:/pic.png (image, 2 KB)' },
			{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAA' } },
		]);
		expect(JSON.stringify(out)).not.toContain('bytes');
	});
});
