/**
 * Tool result content resolution: structured `data` is the source of truth and
 * the model-facing text is formatted from it, while a stored `content` override
 * (user edits, and chats written before `data` existed) always wins.
 *
 * Run: bun test
 */

import { describe, test, expect, spyOn } from 'bun:test';
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

const { resolveContent, isPending, toolModules, applyToolCalls, tools, sentTools, expandRunCalls } = await import('../src/helpers/tools');
const { isSearch } = await import('../src/helpers/tools/shell');
const { buildRequestMessages } = await import('../src/helpers/buildRequest');
const { repairOrphanedToolCalls } = await import('../src/helpers/messages');
import type { ChatMessage, ToolCall, ToolResult } from '../src/helpers/types';
import { createFileContentData } from '../src/helpers/fileContent';
import { imageCropMime, imageCropMode, imageViewSize, parseImageCrop, zoomedCropSize } from '../src/helpers/imageCrop';

const result = (r: Partial<ToolResult> & { name: string }): ToolResult =>
	({ tool_call_id: 'c1', ...r });

describe('resolveContent', () => {
	test('formats from structured data', () => {
		expect(resolveContent(result({ name: 'random_number', data: { value: 42, min: 1, max: 100 } })))
			.toBe('Random(1, 100): 42');
	});

	test('results stored before min/max were recorded still format', () => {
		expect(resolveContent(result({ name: 'random_number', data: { value: 42 } })))
			.toBe('Random number: 42');
	});

	test('does not repeat outcomes from previously stored results', () => {
		expect(resolveContent(result({ name: 'random_number', data: { value: 4, min: 1, max: 6, outcomes: '1-2: failure; 3-6: success' } })))
			.toBe('Random(1, 6): 4');
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
		const error = spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(resolveContent(result({ name: 'read_file', data: { path: 'a.txt' } }))).toBe('{"path":"a.txt"}');
			expect(error).toHaveBeenCalledTimes(1);
		} finally {
			error.mockRestore();
		}
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

	test('read_file advertises the model family crop convention', () => {
		const crop = (model: string) => (toolModules.read_file.describe!(undefined as any, model).function.parameters as any).properties.crop;
		expect(crop('anthropic/claude-fable-5').description).toContain('pixel coordinates');
		expect(crop('openai/gpt-5.6').description).toContain('pixel coordinates');
		expect(crop('google/gemini-3.8-flash').description).toContain('0-1000');
		expect(crop('qwen/qwen3-vl').description).toContain('0-1000');
	});

	test('read_file reports image dimensions and tolerates incomplete crop metadata', () => {
		expect(toolModules.read_file.format({ path: 'image.png', images: ['id'], bytes: 1024, viewSize: { width: 640, height: 788 } }))
			.toBe('image.png (image, 1 KB, image dimensions 640x788)');
		expect(toolModules.read_file.format({ path: 'image.png', images: ['id'], bytes: 1024, viewSize: { width: 640, height: 788 }, crop: { x1: 1, y1: 2, x2: 3, y2: 4 } }))
			.toBe('image.png (image, 1 KB, source view dimensions 640x788)');
	});

	test('image crop helpers normalize tolerant args and use integer zoom', () => {
		expect(imageCropMode('claude-opus-5')).toBe('pixels');
		expect(imageCropMime(1500, 1000)).toBe('image/png');
		expect(imageCropMime(1501, 1000)).toBe('image/webp');
		expect(imageCropMode('glm-5.3-flash')).toBe('normalized');
		expect(imageViewSize(3136, 1568)).toEqual({ width: 1568, height: 784 });
		expect(parseImageCrop('[900, 800, 100, 200]', { width: 1000, height: 1000 }))
			.toEqual({ x1: 100, y1: 200, x2: 900, y2: 800 });
		expect(parseImageCrop({ left: -10, top: 20, right: 1200, bottom: 900 }, { width: 1000, height: 1000 }))
			.toEqual({ x1: 0, y1: 20, x2: 1000, y2: 900 });
		const zoom = zoomedCropSize(100, 50);
		expect(zoom).toEqual({ width: 1500, height: 750 });
		expect(zoom.width % 100).toBe(0);
		expect(zoom.height % 50).toBe(0);
		expect(zoom.width * zoom.height).toBeLessThanOrEqual(1_500_000);
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

	test('edit_file omits adjustment notes from persisted successful outcomes', () => {
		expect(resolveContent(result({ name: 'edit_file', data: {
			path: 'a.ts', applied: 1, failed: 0, skipped: 0, total: 1,
			outcomes: [{ applied: true, line: 1, message: '✓ edit 1 (line 1) (indentation adjusted)' }],
		} }))).toBe('edit_file: a.ts\n✓ edit 1 (line 1)\n1/1 edits applied');
	});

	test('edit_file rewrites over-indented call args and reports ordinary success', async () => {
		let content = '\tx = 1;';
		const args = { path: '/a.ts', edits: [{ oldText: '\t\tx = 1;', newText: '\t\tx = 2;' }] };
		const call: ToolCall = { id: 'edit1', type: 'function', function: { name: 'edit_file', arguments: args } };
		const data = await toolModules.edit_file.execute(call, { backend: {
			paths: { sep: '/', windows: false },
			stat: async () => ({ isDirectory: false }),
			readText: async () => content,
			writeText: async (_path: string, text: string) => { content = text; },
		} } as any);
		expect(data.ok).toBe(true);
		expect(content).toBe('\tx = 2;');
		expect(args.edits).toEqual([{ oldText: '\tx = 1;', newText: '\tx = 2;' }]);
		expect(resolveContent(result({ name: 'edit_file', data })))
			.toBe('edit_file: /a.ts\n✓ edit 1 (line 1)\n1/1 edits applied');
	});

	test('fetch_url marks truncation in both modes', () => {
		const fmt = toolModules.fetch_url.format;
		expect(fmt({ mode: 'raw', status: 200, statusText: 'OK', body: 'hi', truncated: false }))
			.toBe('Status: 200 OK\n\nhi');
		expect(fmt({ mode: 'extract', body: 'md', truncated: true })).toBe('md\n...[truncated]');
		expect(fmt({ mode: 'extract', body: '', truncated: false })).toBe('(no content extracted)');
	});

	test('show_widget names the widget', () => {
		expect(toolModules.show_widget.format({ ok: true, name: 'calendar', args: { date: 'today' } }))
			.toBe('Showing widget calendar');
	});

	test('show_widget validates name, args and height', async () => {
		const { scanWidgets } = await import('../src/helpers/widgets');
		const tree: Record<string, string[]> = { '/w': ['Calendar'], '/w/Calendar': ['widget.html'] };
		const backend = {
			readDir: async (dir: string) => (tree[dir] ?? []).map(name => ({ name, isDirectory: !name.endsWith('.html') })),
			readText: async () => '<meta name="description" content="d">',
		} as any;
		await scanWidgets(['/w'], backend);
		const run = (args: object) => toolModules.show_widget.execute({ id: 'w', type: 'function', function: { name: 'show_widget', arguments: args } }, {} as any);
		expect(await run({ name: 'calendar', height: '300px' })).toEqual({ ok: true, name: 'Calendar', args: undefined, height: 300 });
		expect(await run({ name: 'calendar', args: null, height: null })).toEqual({ ok: true, name: 'Calendar', args: undefined, height: undefined });
		expect((await run({ name: 'calendar', height: 'tall' })).error).toBe('`height` must be a positive number of pixels, got "tall"');
		expect((await run({ name: 'calendar', args: [1] })).error).toBe('`args` must be an object');
		expect((await run({ name: 'clock' })).error).toBe('Unknown widget "clock". Available: Calendar');
		// Written after the last scan: a miss rescans
		tree['/w']!.push('clock');
		tree['/w/clock'] = ['widget.html'];
		expect(await run({ name: 'clock' })).toEqual({ ok: true, name: 'clock', args: undefined, height: undefined });
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

describe('run_js format', () => {
	const fmt = (data: object) => resolveContent(result({ name: 'run_js', data }));
	const nested = (id: string, name: string, data?: object) => ({
		call: { id, type: 'function', function: { name, arguments: {} } },
		...(data && { result: { tool_call_id: id, name, data } }),
	});

	test('prints, then the return value, then the error, then notices', () => {
		expect(fmt({
			ok: false,
			log: [{ print: 'a' }, nested('j:1', 'random_number', { value: 4, min: 1, max: 6 }), { print: 'b' }],
			value: '42',
			thrown: 'TypeError: x is not a function\n    at eval (line 3:1)',
			lost: ['cache.item (Foo instance → plain object)'],
		})).toBe([
			'a\nb',
			'Return value: 42',
			'Uncaught TypeError: x is not a function\n    at eval (line 3:1)',
			"Saved globals that won't come back intact after a restart: cache.item (Foo instance → plain object)",
		].join('\n\n'));
	});

	test('nested results stay out; failed and unfinished calls get one line', () => {
		const text = fmt({
			ok: true,
			log: [
				nested('j:1', 'random_number', { value: 4 }),
				nested('j:2', 'shell', { ok: false, exit_code: 2, duration_ms: 0, stdout: '', stderr: 'boom' }),
				nested('j:3', 'read_file', { ok: false, error: 'No such file\nmore detail' }),
				nested('j:4', 'shell'),
				nested('j:5', 'shell', { running: true, stdout: 'partial', stderr: '' }),
			],
		});
		expect(text).toBe('Failed tool calls: shell (Exit code: 2); read_file (No such file); shell (unfinished); shell (unfinished)');
	});

	test('restore, timeout, cancel and save notices', () => {
		expect(fmt({ ok: true, log: [], restored: { names: ['a', 'b'], lost: ['a.fn (function source could not be revived)'] } }))
			.toBe('The runtime was restarted and globals were restored from the saved state: a, b. Functions were restored from source and lost any variables they captured. Lost on restore: a.fn (function source could not be revived).');
		expect(fmt({ ok: true, log: [], restored: { names: [], lost: [] } })).toBe('The runtime was restarted; the saved state had no globals.');
		expect(fmt({ ok: false, log: [{ print: 'x' }], timedOut: true })).toStartWith('x\n\nTimed out.');
		expect(fmt({ ok: false, log: [], cancelled: true })).toStartWith('Cancelled by the user.');
		expect(fmt({ ok: true, log: [], stateError: 'globals take 6.2 MB encoded, over the 5 MB limit' }))
			.toBe('Globals were not saved: globals take 6.2 MB encoded, over the 5 MB limit');
	});

	test('output is capped', () => {
		const text = fmt({ ok: true, log: [{ print: 'x'.repeat(60_000) }] });
		expect(text.length).toBeLessThan(50_100);
		expect(text).toEndWith('[output truncated at 50000 characters]');
		expect(fmt({ ok: true, log: [{ print: 'abc' }], truncated: true })).toBe('abc\n\n[output truncated at 50000 characters]');
	});

	test('prints near the cap leave room for the error, value and notices', () => {
		const text = fmt({
			ok: false,
			log: [{ print: 'x'.repeat(49_990) }, nested('j:1', 'read_file', { ok: false, error: 'No such file' })],
			truncated: true,
			value: '1',
			thrown: 'Error: boom',
		});
		expect(text.length).toBeLessThanOrEqual(50_100);
		expect(text).toContain('[output truncated at 50000 characters]\n\nReturn value: 1\n\nUncaught Error: boom');
		expect(text).toEndWith('Failed tool calls: read_file (No such file)');
	});

	test('lost lists are capped', () => {
		const lost = Array.from({ length: 30 }, (_, i) => `g${i} (symbol)`);
		const text = fmt({ ok: true, log: [], lost, restored: { names: ['a'], lost } });
		expect(text).toContain('g19 (symbol), and 10 more.');
		expect(text).toEndWith('g19 (symbol), and 10 more');
		expect(text).not.toContain('g20');
	});

	test('total over old, partial and malformed data', () => {
		expect(fmt({})).toBe('(no output)');
		expect(fmt({ ok: true, running: true, log: [{ print: 'so far' }] })).toBe('so far');
		expect(fmt({ log: 'nonsense', restored: 'odd', lost: 'x' })).toBe('(no output)');
		expect(fmt({ log: [null, 5, { call: null }, { print: 'kept' }] })).toBe('kept');
		expect(fmt({ ok: false, error: 'runtime failed' })).toBe('runtime failed');
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

describe('step execution', () => {
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

	// Expanded from `run` call `parent` unless parent is null (a native call).
	const call = (tag: string, args: Record<string, any> = {}, parent: string | null = 'r'): ToolCall =>
		({ id: tag, type: 'function', function: { name: 'test_tool', arguments: { tag, ...args } }, ...(parent !== null && { parent }) });

	const run = (calls: ToolCall[], ctx: object = {}) => { events.length = 0; return applyToolCalls(calls, ctx as any); };

	test('native calls without steps run in parallel', async () => {
		await run([call('a', { ms: 10 }, null), call('b', {}, null)]);
		expect(events).toEqual(['start a', 'start b', 'end b', 'end a']);
	});

	test('every settled result carries ok; explicit values win', async () => {
		const [rolled] = await run([{ id: 'n', type: 'function', function: { name: 'random_number', arguments: { min: 1, max: 1 } } }]);
		expect(rolled.data).toEqual({ ok: true, value: 1, min: 1, max: 1 });
		toolModules.test_denied = { ...toolModules.test_tool, execute: async () => ({ denied: true, message: 'no' }) } as any;
		const [denied] = await run([{ id: 'd', type: 'function', function: { name: 'test_denied', arguments: {} } }]);
		expect(denied.data).toEqual({ ok: false, denied: true, message: 'no' });
		delete toolModules.test_denied;
		const [failed] = await run([call('f', { fail: true }, null)]);
		expect(failed.data.ok).toBe(false);
	});

	test('native calls with the legacy step arg keep their ordering, ahead of run items', async () => {
		await run([call('r', { step: 0 }), call('b', { step: 2 }, null), call('a', { step: 1, ms: 10 }, null)]);
		expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start r', 'end r']);
	});

	test('a non-numeric step is missing, not coerced', async () => {
		const results = await run([call('a', { step: true })]);
		expect(results[0].data.error).toBe('test_tool: missing `step`');
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
		expect(results[2].data.error).toBe('Skipped (step 3 of 3): [0] test_tool failed');
	});

	test('the rest of a failing step still finishes', async () => {
		await run([call('a', { step: 1, fail: true }), call('b', { step: 1, ms: 10 }), call('c', { step: 2 })]);
		expect(events).toEqual(['start a', 'start b', 'end a', 'end b']);
	});

	test('a skipped result reads as a failure to the model', async () => {
		const results = await run([call('a', { step: 1, fail: true }), call('b', { step: 2 })]);
		expect(resolveContent({ ...results[1], name: 'test_tool' })).toBe('Skipped (step 2 of 2): [0] test_tool failed');
	});

	test('failures are named by index within their run call, native ones by name', async () => {
		const results = await run([call('a', { step: 1 }), call('b', { step: 1, fail: true }), call('c', { step: 2 })]);
		expect(results[2].data.error).toBe('Skipped (step 2 of 2): [1] test_tool failed');
		const native = await run([call('a', { step: 1, fail: true }, null), call('b', { step: 2 }, null)]);
		expect(native[1].data.error).toBe('Skipped (step 2 of 2): test_tool failed');
	});

	test('several run calls chain in order: (run call, step)', async () => {
		await run([
			call('a', { step: 2 }, 'r1'),
			call('b', { step: 1, ms: 10 }, 'r1'),
			call('c', { step: 0 }, 'r2'),
		]);
		expect(events).toEqual(['start b', 'end b', 'start a', 'end a', 'start c', 'end c']);
	});

	test('a failure in one run call skips the next', async () => {
		const results = await run([call('a', { step: 1, fail: true }, 'r1'), call('b', { step: 1 }, 'r2')]);
		expect(results[1].data).toMatchObject({ ok: false, skipped: true });
		expect(results[1].data.error).toBe('Skipped (step 2 of 2): [0] test_tool of an earlier run call failed');
	});

	test('malformed items fail with feedback in their own slot', async () => {
		const calls = expandRunCalls([{ id: 'r', type: 'function', function: { name: 'run', arguments: { calls: [
			{ tool: 'test_tool', tag: 'nostep' },
			{ tool: 'nope', step: 1 },
			{ step: 1, tag: 'x' },
		] } } }]);
		const results = await run(calls);
		const byId = Object.fromEntries(results.map(r => [r.tool_call_id, r.data]));
		expect(byId['r.0'].error).toBe('test_tool: missing `step`');
		expect(byId['r.1'].error).toBe('Skipped (step 2 of 2): [0] test_tool failed');
		expect(byId['r.2'].error).toContain('Skipped');
		const stepped = await run(calls.slice(1), { enabledTools: { test_tool: true } });
		expect(stepped.find(r => r.tool_call_id === 'r.1')!.data.error).toBe('Unknown tool nope');
		expect(stepped.find(r => r.tool_call_id === 'r.2')!.data.error).toContain('needs a `tool`');
	});

	test('a run call without items fails instead of vanishing', async () => {
		const calls = expandRunCalls([{ id: 'r', type: 'function', function: { name: 'run', arguments: { calls: [] } } }]);
		expect(calls.map(c => c.id)).toEqual(['r']);
		const results = await run(calls);
		expect(results[0].data.error).toContain('non-empty `calls`');
	});

	test('a stringified calls array that does not parse explains why', async () => {
		const calls = expandRunCalls([{ id: 'r', type: 'function', function: { name: 'run', arguments: { calls: '[{"tool": "test_tool", "step": 1, "edits": [{"a": 1}, {"tool": "x"}]' } } }]);
		expect(calls.map(c => c.id)).toEqual(['r']);
		const results = await run(calls);
		expect(results[0].data.error).toContain('must be an array of objects, not a string');
	});
});

describe('run schema', () => {
	const sent = (selected: Record<string, boolean> | undefined) => sentTools(selected, undefined, undefined, undefined, 'run');

	test('wraps every selected tool into one run tool', () => {
		const out = sent({ shell: true, random_number: true });
		expect(out.map(t => t.function.name)).toEqual(['run']);
		const branches = (out[0].function.parameters as any).properties.calls.items.anyOf;
		expect(branches.map((b: any) => b.properties.tool.enum)).toEqual([['shell'], ['random_number']]);
		const shell = branches[0];
		expect(Object.keys(shell.properties).slice(0, 2)).toEqual(['tool', 'step']);
		expect(shell.required).toEqual(['tool', 'step', 'command']);
		expect(shell.description).toContain('Execute a shell command');
	});

	test('no tools selected sends nothing, not an empty run', () => {
		expect(sent({})).toEqual([]);
	});

	test('and_then is no longer offered', () => {
		expect(tools.some(t => t.function.name === 'and_then')).toBe(false);
		expect(toolModules.and_then).toBeDefined();
	});

	test('no tool declares the reserved tool/step params', () => {
		expect(() => sent(undefined)).not.toThrow();
	});
});

describe('run expansion', () => {
	const runCall = (id: string, calls: unknown): ToolCall =>
		({ id, type: 'function', function: { name: 'run', arguments: { calls } } });

	test('items become calls tagged with their run call', () => {
		const out = expandRunCalls([runCall('r', [
			{ tool: 'shell', step: 1, command: 'ls' },
			{ tool: 'read_file', step: 2, path: 'a' },
		])]);
		expect(out).toEqual([
			{ id: 'r.0', type: 'function', function: { name: 'shell', arguments: { step: 1, command: 'ls' } }, parent: 'r' },
			{ id: 'r.1', type: 'function', function: { name: 'read_file', arguments: { step: 2, path: 'a' } }, parent: 'r' },
		]);
	});

	test('a stringified calls array is parsed, raw newlines included', () => {
		const out = expandRunCalls([runCall('r', '[{"tool": "shell", "step": 1, "command": "echo a\nb"}]')]);
		expect(out).toEqual([
			{ id: 'r.0', type: 'function', function: { name: 'shell', arguments: { step: 1, command: 'echo a\nb' } }, parent: 'r' },
		]);
	});

	test('native calls pass through untouched', () => {
		const native: ToolCall = { id: 'n', type: 'function', function: { name: 'shell', arguments: { command: 'ls' } } };
		expect(expandRunCalls([native])).toEqual([native]);
	});

	test('items without a usable tool keep their raw value', () => {
		const out = expandRunCalls([runCall('r', [{ step: 1 }, 'junk', { tool: 3 }])]);
		expect(out.map(c => [c.function.name, c.function.arguments])).toEqual([['', { step: 1 }], ['', 'junk'], ['', { tool: 3 }]]);
	});
});

describe('shell no-match', () => {
	test('the last command of a pipeline decides', () => {
		expect(isSearch('rg foo src')).toBe(true);
		expect(isSearch('git grep -n foo')).toBe(true);
		expect(isSearch('cd src && grep -r foo .')).toBe(true);
		expect(isSearch('cat x | findstr foo')).toBe(true);
		expect(isSearch('rg "a|b" src')).toBe(true);
		expect(isSearch("rg 'a;b' 2>&1")).toBe(true);
		expect(isSearch('rg foo | head')).toBe(false);
		expect(isSearch('rg foo; echo done')).toBe(false);
		expect(isSearch('rgx foo')).toBe(false);
		expect(isSearch('bun test')).toBe(false);
	});

	test('no-match results read as success, old data unchanged', () => {
		const fmt = toolModules.shell.format;
		expect(fmt({ ok: true, noMatch: true, exit_code: 1, duration_ms: 0, stdout: '', stderr: '' })).toBe('Exit code: 1 (no matches)\n\n');
		expect(fmt({ ok: false, exit_code: 1, duration_ms: 0, stdout: '', stderr: '' })).toBe('Exit code: 1\n\n');
		const failed = toolModules.shell.failed!;
		expect(failed({} as any, result({ name: 'shell', content: 'Exit code: 1 (no matches)\n\n' }))).toBe(false);
		expect(failed({} as any, result({ name: 'shell', content: 'Exit code: 1\n\n' }))).toBe(true);
	});
});

describe('random_number', () => {
	test('advertises an optional outcomes field', () => {
		const parameters = toolModules.random_number.definition.function.parameters as any;
		expect(parameters.required ?? []).not.toContain('outcomes');
		expect(parameters.properties.outcomes.type).toBe('string');
	});

	test('rolls with or without outcomes, returning only the number', async () => {
		const execute = toolModules.random_number.execute;
		const call = (args: Record<string, unknown>) => ({ function: { name: 'random_number', arguments: args } } as ToolCall);
		expect(await execute(call({ min: 1, max: 1 }), {} as any)).toEqual({ value: 1, min: 1, max: 1 });
		expect(await execute(call({ min: 2, max: 2, outcomes: '2: success' }), {} as any)).toEqual({ value: 2, min: 2, max: 2 });
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
		const rolled = result({ name: 'random_number', data: { value: 7, min: 1, max: 6 } });
		const out = build(msgWithResult(rolled));
		const toolMsg = out.find(m => m.role === 'tool') as any;
		expect(toolMsg.content).toBe(resolveContent(rolled));
		expect(toolMsg.data).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain('"value"');
	});

	test('preserves declared outcomes in arguments without repeating them in the result', () => {
		const rolled = result({ name: 'random_number', data: { value: 4, min: 1, max: 6 } });
		const messages = msgWithResult(rolled);
		messages[0].tool_calls![0][0].function.arguments = { min: 1, max: 6, outcomes: '1-2: failure; 3-6: success' };
		const out = build(messages);
		expect((out[0] as any).tool_calls[0].function.arguments).toContain('1-2: failure; 3-6: success');
		expect((out.find(m => m.role === 'tool') as any).content).toBe(resolveContent(rolled));
		expect(resolveContent(rolled)).not.toContain('failure');
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

describe('run re-nesting', () => {
	const build = (msgs: ChatMessage[]) =>
		buildRequestMessages(msgs, { provider: 'or', prompts: [], cache: 'none', cacheLength: '5m', model: 'gpt-4' });

	const rolled = (id: string, value: number): ToolResult =>
		({ tool_call_id: id, name: 'random_number', data: { value, min: 1, max: 6 } });

	const turn = (calls: ToolCall[], results: ToolResult[]): ChatMessage =>
		({ role: 'assistant', content: [''], currentVersionIndex: 0, tool_calls: [calls], tool_results: [results] });

	const received = { calls: [
		{ tool: 'shell', step: 1, command: 'ls' },
		{ step: 1, tool: 'random_number', min: 1 },
		{ step: 2 },
		'junk',
		{ tool: 'nope', step: 2 },
	] };
	const expanded = expandRunCalls([{ id: 'r', type: 'function', function: { name: 'run', arguments: received } }]);
	const results: ToolResult[] = [
		{ tool_call_id: 'r.0', name: 'shell', data: { ok: true, exit_code: 0, duration_ms: 0, stdout: 'a', stderr: '' } },
		rolled('r.1', 4),
		{ tool_call_id: 'r.2', name: '', data: { ok: false, error: 'bad' } },
		{ tool_call_id: 'r.3', name: '', data: { ok: false, skipped: true, error: 'Skipped' } },
		{ tool_call_id: 'r.4', name: 'nope' },
	];

	test('one run call and one tool message per parent', () => {
		const out = build([turn(expanded, results)]) as any[];
		expect(out.map(m => m.role)).toEqual(['assistant', 'tool']);
		expect(out[0].tool_calls.map((c: any) => [c.id, c.function.name])).toEqual([['r', 'run']]);
		expect(out[1]).toMatchObject({ tool_call_id: 'r', name: 'run' });
		expect(out[1].content).toBe(`[0] shell\nExit code: 0\n\na\n\n[1] random_number\n${resolveContent(results[1])}\n\n[2] \nbad\n\n[3] \nSkipped\n\n[4] nope\n`);
	});

	test('rebuilt arguments are deterministic; well-ordered items round-trip exactly', () => {
		const args = (build([turn(expanded, results)])[0] as any).tool_calls[0].function.arguments;
		expect(args).toBe((build([turn(expanded, results)])[0] as any).tool_calls[0].function.arguments);
		// Only the item that put `step` before `tool` comes back reordered
		const expected = structuredClone(received);
		expected.calls[1] = { tool: 'random_number', step: 1, min: 1 };
		expect(args).toBe(JSON.stringify(expected));
	});

	test('native and legacy calls in the same turn are sent as before', () => {
		const native: ToolCall = { id: 'n', type: 'function', function: { name: 'and_then', arguments: {} } };
		const out = build([turn([native, ...expanded], [{ tool_call_id: 'n', name: 'and_then', data: { ok: true } }, ...results])]) as any[];
		expect(out[0].tool_calls.map((c: any) => c.function.name)).toEqual(['and_then', 'run']);
		expect(out.slice(1).map(m => m.tool_call_id)).toEqual(['n', 'r']);
		expect(out[1].content).toBe('ok');
	});

	test('several run calls stay separate', () => {
		const two = expandRunCalls([
			{ id: 'r1', type: 'function', function: { name: 'run', arguments: { calls: [{ tool: 'random_number', step: 0 }] } } },
			{ id: 'r2', type: 'function', function: { name: 'run', arguments: { calls: [{ tool: 'random_number', step: 0 }] } } },
		]);
		const out = build([turn(two, [
			rolled('r1.0', 1),
			rolled('r2.0', 2),
		])]) as any[];
		expect(out[0].tool_calls.map((c: any) => c.id)).toEqual(['r1', 'r2']);
		expect(out.slice(1).map(m => [m.tool_call_id, m.content])).toEqual([['r1', `[0] random_number\n${resolveContent(rolled('r1.0', 1))}`], ['r2', `[0] random_number\n${resolveContent(rolled('r2.0', 2))}`]]);
	});

	test('images from every inner result follow the text, labelled', () => {
		const calls = expandRunCalls([{ id: 'r', type: 'function', function: { name: 'run', arguments: { calls: [
			{ tool: 'read_file', step: 0, path: 'a.png' },
			{ tool: 'random_number', step: 0 },
			{ tool: 'read_file', step: 0, path: 'b.png' },
		] } } }]);
		const out = build([turn(calls, [
			{ tool_call_id: 'r.0', name: 'read_file', data: { path: 'a.png', images: ['data:a'], bytes: 1024 } },
			rolled('r.1', 3),
			{ tool_call_id: 'r.2', name: 'read_file', data: { path: 'b.png', images: ['data:b1', 'data:b2'], bytes: 1024 } },
		])]) as any[];
		expect(out[1].content).toEqual([
			{ type: 'text', text: `[0] read_file\na.png (image, 1 KB)\n\n[1] random_number\n${resolveContent(rolled('r.1', 3))}\n\n[2] read_file\nb.png (image, 1 KB)` },
			{ type: 'text', text: '[0] read_file:' },
			{ type: 'image_url', image_url: { url: 'data:a' } },
			{ type: 'text', text: '[2] read_file image 1:' },
			{ type: 'image_url', image_url: { url: 'data:b1' } },
			{ type: 'text', text: '[2] read_file image 2:' },
			{ type: 'image_url', image_url: { url: 'data:b2' } },
		]);
	});
});

describe('repairOrphanedToolCalls', () => {
	const call = (id: string, name = 'shell'): ToolCall =>
		({ id, type: 'function', function: { name, arguments: { command: 'sleep 10' } } });
	const turn = (calls: ToolCall[], results?: ToolResult[]): ChatMessage =>
		({ role: 'assistant', content: [''], currentVersionIndex: 0, tool_calls: [calls], ...(results && { tool_results: [results] }) });

	test('settles the placeholder an interrupted call leaves behind', () => {
		const msgs = [turn([call('a')], [{ tool_call_id: 'a', name: 'shell' }])];
		expect(isPending(msgs[0].tool_results![0][0])).toBe(true);

		expect(repairOrphanedToolCalls(msgs)).toBe(true);
		const repaired = msgs[0].tool_results![0][0];
		expect(isPending(repaired)).toBe(false);
		expect(repaired.data?.ok).toBe(false);
		expect(resolveContent(repaired)).toContain('application closed');
	});

	test('appends results that were never stored', () => {
		const msgs = [turn([call('a'), call('b', 'read_file')])];
		expect(repairOrphanedToolCalls(msgs)).toBe(true);
		expect(msgs[0].tool_results![0].map(r => [r.tool_call_id, r.name, r.data?.ok]))
			.toEqual([['a', 'shell', false], ['b', 'read_file', false]]);
	});

	test('leaves finished results untouched', () => {
		const done = result({ tool_call_id: 'a', name: 'shell', data: { ok: true, exit_code: 0, stdout: 'hi', stderr: '', duration_ms: 1 } });
		const edited = result({ tool_call_id: 'b', name: 'shell', content: '' });
		const msgs = [turn([call('a'), call('b')], [done, edited])];
		expect(repairOrphanedToolCalls(msgs)).toBe(false);
		expect(msgs[0].tool_results![0]).toEqual([done, edited]);
	});
});
