/**
 * run_js end to end: the real Worker (bun runs it), the host queue/restore
 * logic and the tool bridge through applyToolCalls. Snapshot storage is an
 * in-memory map in place of the attachments store.
 *
 * Run: bun test
 */

import { describe, test, expect, mock } from 'bun:test';

const kvStore = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => kvStore.get(k) ?? null,
	setItem: (k: string, v: string) => kvStore.set(k, v),
	removeItem: (k: string) => kvStore.delete(k),
	clear: () => kvStore.clear(),
};
(globalThis as any).navigator ??= { platform: 'Win32' };
(globalThis as any).window ??= {};

const attachments = await import('../src/helpers/attachments');
const snapshots = new Map<string, string>();
mock.module('../src/helpers/attachments', () => ({
	...attachments,
	saveJsState: async (id: string, text: string) => { snapshots.set(id, text); },
	loadJsState: async (id: string) => snapshots.get(id),
}));

// Swappable per test; earlier test files may have made this a Tauri environment.
const platform = await import('../src/helpers/platform');
let httpFetch = platform.httpFetch;
mock.module('../src/helpers/platform', () => ({ ...platform, httpFetch: (...args: Parameters<typeof httpFetch>) => httpFetch(...args) }));

const { applyToolCalls, resolveContent, runnableTools, sentTools, toolModules, wrapInRunJs } = await import('../src/helpers/tools');
const { decodeState } = await import('../src/helpers/jsRuntime/state');
const { cancelJs, jsRuntimeKey } = await import('../src/helpers/jsRuntime/host');
const { guardPermissions } = await import('../src/helpers/tools/runJs');
const { createChatSession } = await import('../src/helpers/session');
const { latestJsState } = await import('../src/helpers/messages');
const { localBackend } = await import('../src/helpers/backend');
const { collectAttachmentRefs } = attachments;
import type { ChatMessage, ToolCall, ToolData, ToolResult } from '../src/helpers/types';
import type { ToolContext } from '../src/helpers/tools';

let seq = 0;
const jsCall = (code: string, extra: Record<string, unknown> = {}): ToolCall =>
	({ id: `js${++seq}`, type: 'function', function: { name: 'run_js', arguments: { code, ...extra } } });

const ctxFor = (chatId: string, latest?: () => string | undefined): ToolContext => ({
	chatId,
	backend: localBackend,
	enabledTools: { run_js: true, random_number: true },
	latestJsState: latest,
});

async function runOne(code: string, ctx: ToolContext, extra: Record<string, unknown> = {}): Promise<ToolData> {
	const [item] = await applyToolCalls([jsCall(code, extra)], ctx);
	return item.data;
}

const text = (data: ToolData) => resolveContent({ tool_call_id: 'x', name: 'run_js', data });

describe('run_js', () => {
	test('prints, return value and nested calls', async () => {
		const data = await runOne(`
			print('start', { a: 1 });
			console.log(new Map([['k', 2]]));
			const r = await tool('random_number', { min: 3, max: 3 });
			print(r.ok, r.data.value);
			return r.text;
		`, ctxFor('basic'));
		expect(data.ok).toBe(true);
		expect(data.value).toBe('Random(3, 3): 3');
		expect(data.log).toHaveLength(3);
		expect(data.log[0]).toEqual({ print: 'start {"a":1}\n[["k",2]]' });
		const nested = data.log[1];
		expect(nested.call.id).toMatch(/^js\d+:1$/);
		expect(nested.call.parent).toBeUndefined();
		expect(nested.result.data).toEqual({ ok: true, value: 3, min: 3, max: 3 });
		expect(data.log[2]).toEqual({ print: 'true 3' });
		expect(data.state).toMatch(/^jsstate-/);
		// Nested results stay out of the model-facing text
		expect(text(data)).toBe('start {"a":1}\n[["k",2]]\ntrue 3\n\nReturn value: Random(3, 3): 3');
	});

	test('failed tools resolve with ok: false; bridge failures throw', async () => {
		const data = await runOne(`
			const bad = await tool('random_number', { min: 5, max: 1 });
			print(bad.ok, bad.text);
			for (const name of ['shell', 'run_js', 'run', 'nope']) {
				try { await tool(name, {}); } catch (e) { print(e.message); }
			}
			try { await tool('random_number', [1]); } catch (e) { print(e.message); }
			print(listTools().map(t => t.name).join(','));
		`, ctxFor('bridge'));
		expect(data.ok).toBe(true);
		expect(data.log).toHaveLength(2);
		expect(data.log[1].print.split('\n')).toEqual([
			'false random_number error: min (5) > max (1)',
			'Unknown tool shell; listTools() lists the available ones',
			"run_js can't be called from run_js",
			"run can't be called from run_js",
			'Unknown tool nope; listTools() lists the available ones',
			'tool("random_number", args): args must be an object',
			'random_number',
		]);
		expect(text(data)).toEndWith('Failed tool calls: random_number (random_number error: min (5) > max (1))');
	});

	test('listTools carries return types; descriptions name them only with run_js selected', async () => {
		const data = await runOne(`return listTools().find(t => t.name === 'random_number').returns`, ctxFor('returns'));
		expect(data.value).toBe('{ value: number, min: number, max: number }');
		const description = (selected: Record<string, boolean>) =>
			sentTools(selected).find(t => t.function.name === 'random_number')!.function.description;
		expect(description({ random_number: true, run_js: true })).toEndWith('\nIn run_js, `tool()` data: { value: number, min: number, max: number }');
		expect(description({ random_number: true })).not.toContain('run_js');
	});

	test('tools are global functions: positional, options object or a whole arguments object', async () => {
		const realFetch = httpFetch;
		const urls: string[] = [];
		httpFetch = async url => { urls.push(String(url)); return new Response('body'); };
		try {
			const ctx: ToolContext = { ...ctxFor('functions'), enabledTools: { run_js: true, random_number: true, fetch_url: true } };
			const data = await runOne(`
				print((await random_number({ min: 4, max: 4 })).data.value);
				print((await fetch_url('http://a.test')).data.body);
				print((await fetch_url('http://b.test', { mode: 'raw' })).ok);
				print((await fetch_url({ url: 'http://c.test' })).ok);
				for (const bad of [() => fetch_url('x', {}, 1), () => fetch_url('x', 'raw')])
					try { await bad(); } catch (e) { print(e.message); }
				try { random_number = 1; } catch (e) { print(e.message); }
				print(typeof shell, random_number.name);
				kept = 1;
			`, ctx);
			expect(data.log.filter((e: any) => e.print).map((e: any) => e.print).join('\n').split('\n')).toEqual([
				'4', 'body', 'true', 'true',
				'fetch_url(url, opts?) takes at most 2 arguments, got 3',
				'fetch_url(url, opts?): the last argument must be an object of the optional parameters (mode)',
				"random_number is a tool function and can't be reassigned",
				'undefined random_number',
			]);
			expect(urls).toEqual(['http://a.test', 'http://b.test', 'http://c.test']);
			expect(Object.keys(decodeState(snapshots.get(data.state)!).globals)).toEqual(['kept']);
		} finally {
			httpFetch = realFetch;
		}
	});

	test('returned replies show as direct calls would, images included', async () => {
		const rn = toolModules.random_number!;
		const realExecute = rn.execute;
		rn.execute = async (call, ctx) => ({ ...await realExecute(call, ctx), images: ['img-' + (call.function.arguments as any).min] });
		try {
			const ctx = ctxFor('shown');
			const one = await runOne(`return random_number({ min: 2, max: 2 })`, ctx);
			expect(one.shown).toEqual([one.log[0].call.id]);
			expect(one.value).toBeUndefined();
			expect(one.images).toEqual(['img-2']);
			expect(text(one)).toBe('Random(2, 2): 2');

			const both = await runOne(`print('hi'); return Promise.all([random_number({ min: 3, max: 3 }), tool('random_number', { min: 9, max: 1 })])`, ctx);
			expect(both.images).toEqual(['img-3']);
			expect(text(both)).toBe('hi\n\nrandom_number:\nRandom(3, 3): 3\n\nrandom_number:\nrandom_number error: min (9) > max (1)');

			const failed = await runOne(`return random_number({ min: 9, max: 1 })`, ctx);
			expect(failed.ok).toBe(false);
			expect(both.ok).toBe(true);

			const mixed = await runOne(`return [await random_number(), 1]`, ctx);
			expect(mixed.shown).toBeUndefined();
			expect(mixed.value).toStartWith('[{"ok":true');

			const stale = await runOne(`last = await random_number({ min: 1, max: 1 })`, ctx);
			expect(stale.ok).toBe(true);
			const old = await runOne(`return last`, ctx);
			expect(old.shown).toBeUndefined();
		} finally {
			rn.execute = realExecute;
		}
	});

	test('run_js-only mode sends one tool declaring the others, and may run unselected', async () => {
		const selected = { random_number: true, fetch_url: true };
		const sent = sentTools(selected, undefined, undefined, undefined, 'js');
		expect(sent.map(t => t.function.name)).toEqual(['run_js']);
		const description = sent[0]!.function.description!;
		expect(description).toContain('random_number(\n\topts?: {\n\t\tmin?: number, // 1 if not specified');
		expect(description).toContain('fetch_url(\n\turl: string, // The URL to fetch');
		expect(description).toContain(' * data: { value: number, min: number, max: number }');
		expect(description).not.toContain('In run_js, `tool()` data');
		expect(runnableTools(selected, 'js')).toEqual({ ...selected, run_js: true });
		expect(runnableTools(selected, 'run')).toBe(selected);
		expect(sentTools({}, undefined, undefined, undefined, 'js')).toEqual([]);
		expect(runnableTools({ shell: false }, 'js')).toEqual({ shell: false });
		expect(sentTools({ run_js: true }, undefined, undefined, undefined, 'js')[0]!.function.description).toEndWith('\n\nNo other tools are selected.');
		const data = await runOne('return 1', { ...ctxFor('jsOnly'), enabledTools: runnableTools(selected, 'js') });
		expect(data.value).toBe('1');
	});

	test('run_js-only mode rewrites direct calls into the run_js call', () => {
		const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: args as {} } });
		const code = (calls: ReturnType<typeof call>[]) => wrapInRunJs(calls).map(c => [c.id, c.function.name, (c.function.arguments as any).code]);
		expect(code([call('a', 'fetch_url', { url: 'http://a.test', mode: 'raw' })]))
			.toEqual([['a', 'run_js', 'return fetch_url("http://a.test", { mode: "raw" })']]);
		expect(code([call('a', 'random_number', { min: 1 }), call('b', 'nope', {}), call('c', 'fetch_url', { url: 'u' })]))
			.toEqual([['a', 'run_js', 'return Promise.all([\n\trandom_number({ min: 1 }),\n\tfetch_url("u"),\n])'], ['b', 'nope', undefined]]);
		const withJs = [call('a', 'run_js', { code: '1' }), call('b', 'fetch_url', { url: 'u' })];
		expect(wrapInRunJs(withJs)).toBe(withJs);
	});

	test('chat() returns the conversation after the cut, or all of it on request', async () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: ['old'], currentVersionIndex: 0 },
			{ role: 'assistant', content: ['summary'], currentVersionIndex: 0 },
			{ role: 'user', content: ['hi'], currentVersionIndex: 0 },
			{
				role: 'assistant', content: ['rejected', 'kept'], thinking: ['', 'hmm'], currentVersionIndex: 1,
				tool_calls: [[], [
					{ id: 'c1', type: 'function', function: { name: 'random_number', arguments: { min: 1, max: 1 } } },
					{ id: 'c2', type: 'function', function: { name: 'run_js', arguments: { code: 'chat()' } } },
				]],
				tool_results: [[], [{ tool_call_id: 'c1', name: 'random_number', data: { ok: true, value: 1, min: 1, max: 1 } }, { tool_call_id: 'c2', name: 'run_js' }]],
			},
		];
		const ctx: ToolContext = { ...ctxFor('chatView'), chatMessages: () => ({ messages, cut: 1 }) };
		const data = await runOne(`
			msgs = await chat();
			print(JSON.stringify(msgs));
			print((await chat({ hidden: true })).map(m => m.text + (m.hidden ? '*' : '')).join(','));
			kept = msgs.length;
		`, ctx);
		const prints = data.log.filter((e: any) => e.print).map((e: any) => e.print).join('\n').split('\n');
		expect(JSON.parse(prints[0]!)).toEqual([
			{ role: 'assistant', text: 'summary' },
			{ role: 'user', text: 'hi' },
			{ role: 'assistant', text: 'kept', thinking: 'hmm', calls: [
				{ name: 'random_number', args: { min: 1, max: 1 }, text: 'Random(1, 1): 1' },
				{ name: 'run_js', args: { code: 'chat()' } },
			] },
		]);
		expect(prints[1]).toBe('old*,summary,hi,kept');
		expect(Object.keys(decodeState(snapshots.get(data.state)!).globals)).toEqual(['kept']);

		const missing = await runOne(`try { await chat() } catch (e) { return e.message }`, ctxFor('noChat'));
		expect(missing.value).toBe("chat() isn't available here");
	});

	test('chat({ parent: true }) reads a sub-agent\'s spawning chat, which spawn_agent passes on', async () => {
		const own: ChatMessage[] = [{ role: 'user', content: ['task'], currentVersionIndex: 0 }];
		const parent: ChatMessage[] = [{ role: 'user', content: ['before'], currentVersionIndex: 0 }, { role: 'user', content: ['after'], currentVersionIndex: 0 }];
		const ctx: ToolContext = { ...ctxFor('parentChat'), chatMessages: () => ({ messages: own, cut: 0 }), parentChat: { messages: parent, cut: 1 } };
		const data = await runOne(`
			const texts = async c => (await c).map(m => m.text).join(',');
			return Promise.all([texts(chat()), texts(chat({ parent: true })), texts(chat({ parent: true, hidden: true }))]);
		`, ctx);
		expect(data.value).toBe('["task","after","before,after"]');
		const orphan = await runOne(`try { await chat({ parent: true }) } catch (e) { return e.message }`, { ...ctx, parentChat: undefined });
		expect(orphan.value).toBe('chat({ parent: true }): only sub-agents have a parent chat');

		let passed: unknown;
		await toolModules.spawn_agent!.execute(
			{ id: 's', type: 'function', function: { name: 'spawn_agent', arguments: { task: 't' } } },
			{ ...ctx, spawnAgent: async (_args, _id, chat) => { passed = chat; return 'done'; } },
		);
		expect(passed).toEqual({ messages: own, cut: 0 });
	});

	test('thrown errors and non-errors get one Uncaught prefix', async () => {
		const error = await runOne(`throw new RangeError('bad')`, ctxFor('throwError'));
		expect(error.thrown).toStartWith('RangeError: bad');
		expect(text(error)).toStartWith('Uncaught RangeError: bad');
		const value = await runOne(`throw 'oops'`, ctxFor('throwValue'));
		expect(value.thrown).toBe('oops');
		expect(text(value)).toBe('Uncaught oops');
		const rejection = await runOne(`Promise.reject('late'); await new Promise(r => setTimeout(r, 20))`, ctxFor('rejection'));
		// Browsers report it as unhandledrejection, bun as an error event.
		expect(rejection.log[0].print).toMatch(/^(Unhandled promise rejection: |Uncaught )late$/);
	});

	test('many prints followed by a throw still show the error', async () => {
		const data = await runOne(`for (let i = 0; i < 2000; i++) print('x'.repeat(40)); throw new Error('after prints')`, ctxFor('flood'));
		expect(data.truncated).toBe(true);
		const out = text(data);
		expect(out.length).toBeLessThanOrEqual(50_000);
		expect(out).toContain('[output truncated at 50000 characters]');
		expect(out).toContain('Uncaught Error: after prints');
	});

	test('timeout_secs must be whole seconds within range', async () => {
		const ctx = ctxFor('timeoutArg');
		for (const timeout_secs of [0, -1, 1.5, 3601, Infinity, 'abc', '', true])
			expect((await runOne('return 1', ctx, { timeout_secs })).error).toStartWith('run_js: timeout_secs must be a whole number of seconds from 1 to 3600');
		for (const timeout_secs of [1, '30', 3600, null])
			expect((await runOne('return 1', ctx, { timeout_secs })).value).toBe('1');
	});

	test('calls left running when the run ends are aborted', async () => {
		const realFetch = httpFetch;
		let seen: AbortSignal | undefined;
		httpFetch = (_url, init) => new Promise<Response>((_, reject) => {
			seen = init?.signal ?? undefined;
			const fail = () => reject(new DOMException('aborted', 'AbortError'));
			if (seen?.aborted) fail();
			else seen?.addEventListener('abort', fail);
		});
		try {
			const ctx: ToolContext = { ...ctxFor('stopCalls'), enabledTools: { run_js: true, fetch_url: true } };
			const data = await runOne(`tool('fetch_url', { url: 'http://example.invalid' })`, ctx);
			expect(seen?.aborted).toBe(true);
			expect(text(data)).toContain('Failed tool calls: fetch_url (unfinished)');
		} finally {
			httpFetch = realFetch;
		}
	});

	test('an aborted shell call cancels only its own command, in the chat\'s session', async () => {
		const { shellTool } = await import('../src/helpers/tools/shell');
		const cancelled: [string | undefined, string | undefined][] = [];
		const ended = new AbortController();
		let finish!: () => void;
		const backend = {
			...localBackend,
			exec: () => new Promise<any>(resolve => finish = () => resolve({ stdout: '', stderr: 'Command cancelled\n', exit_code: -1, duration_ms: 1 })),
			cancelExec: async (session: string | undefined, id?: string) => { cancelled.push([session, id]); finish(); },
		};
		const call: ToolCall = { id: 'sh1', type: 'function', function: { name: 'shell', arguments: { command: 'sleep 100' } } };
		const pending = shellTool.execute(call, { backend, shellSession: 's', signal: ended.signal });
		ended.abort();
		expect(cancelled).toEqual([['s', 'sh1']]);
		expect((await pending).ok).toBe(false);
		expect((await shellTool.execute(call, { backend, shellSession: 's', signal: ended.signal })).reason).toBe('cancelled');
	});

	test('late output of a finished run stays out of the next one', async () => {
		const ctx = ctxFor('late');
		const first = await runOne(`setTimeout(() => print('late'), 30)`, ctx);
		expect(first.log).toEqual([]);
		const second = await runOne(`await new Promise(r => setTimeout(r, 80)); print('mine')`, ctx);
		expect(second.log).toEqual([{ print: 'mine' }]);
	});

	test('chats without an id get a Worker per session', async () => {
		let latest: string | undefined;
		const a: ToolContext = { ...ctxFor('', () => latest), chatId: undefined, shellSession: 'a' };
		const b: ToolContext = { ...ctxFor(''), chatId: undefined, shellSession: 'b' };
		latest = (await runOne('mark = "a"', a)).state;
		expect((await runOne('return typeof mark', b)).value).toBe('undefined');
		expect((await runOne('return mark', a)).value).toBe('a');
		expect(jsRuntimeKey('', 'a')).not.toBe(jsRuntimeKey('', 'b'));
	});

	test('a thrown error keeps the prints and the globals set before it', async () => {
		const ctx = ctxFor('throws');
		const data = await runOne(`kept = 1; print('before'); null.x;`, ctx);
		expect(data.ok).toBe(false);
		expect(data.error).toBeUndefined();
		expect(data.thrown).toStartWith('TypeError');
		expect(text(data)).toStartWith('before\n\nUncaught TypeError');
		const after = await runOne('return kept', { ...ctx, latestJsState: () => data.state });
		expect(after.value).toBe('1');
		expect(after.restored).toBeUndefined();
	});

	test('globals persist in the live Worker; locals do not', async () => {
		let latest: string | undefined;
		const ctx = ctxFor('live', () => latest);
		const first = await runOne(`counter = 1; let local = 2; var alsoLocal = 3; function decl() {}`, ctx);
		latest = first.state;
		const second = await runOne(`counter++; return [typeof local, typeof alsoLocal, typeof decl, counter]`, ctx);
		expect(second.value).toBe('["undefined","undefined","undefined",2]');
		expect(second.restored).toBeUndefined();
	});

	test('a new Worker restores the latest snapshot and reports it once', async () => {
		const saved = await runOne(`
			shared = { n: 1 };
			holder = { a: shared, b: shared, twice: x => x * 2, max: Math.max };
		`, ctxFor('origin'));
		expect(saved.lost).toEqual(['holder.max (native function)']);
		const restored = await runOne(`return [holder.a === holder.b, holder.a === shared, holder.twice(4), holder.max]`,
			ctxFor('restarted', () => saved.state));
		expect(restored.value).toBe('[true,true,8,null]');
		expect(restored.restored).toEqual({ names: ['shared', 'holder'], lost: ['holder.max (native function)'] });
		expect(text(restored)).toContain('globals were restored from the saved state: shared, holder');
		expect(text(restored)).toContain('Lost on restore: holder.max (native function).');
	});

	test('the Worker is rebuilt when the history ends on a different snapshot', async () => {
		let latest: string | undefined;
		const ctx = ctxFor('branch', () => latest);
		const one = await runOne('x = 1', ctx);
		latest = one.state;
		const two = await runOne('x = 2', ctx);
		latest = one.state; // e.g. the second run was regenerated away
		const back = await runOne('return x', ctx);
		expect(back.value).toBe('1');
		expect(back.restored?.names).toEqual(['x']);
		latest = undefined; // no run_js left in the history
		const fresh = await runOne('return typeof x', ctx);
		expect(fresh.value).toBe('undefined');
		expect(two.state).not.toBe(one.state);
	});

	test('unchanged globals reuse the snapshot id', async () => {
		let latest: string | undefined;
		const ctx = ctxFor('same', () => latest);
		const a = await runOne('y = [1, 2]', ctx);
		latest = a.state;
		const b = await runOne('print(y.length)', ctx);
		expect(b.state).toBe(a.state);
	});

	test('runs in one chat queue, and each sees the previous result in history', async () => {
		const msg: ChatMessage = { role: 'assistant', content: [''], currentVersionIndex: 0 };
		const calls = [jsCall('order = (typeof order === "undefined" ? [] : order).concat(1)'), jsCall('order.push(2); return order')];
		msg.tool_calls = [calls];
		msg.tool_results = [calls.map(c => ({ tool_call_id: c.id, name: c.function.name }))];
		const results = await applyToolCalls(calls, {
			...ctxFor('queue'),
			latestJsState: () => latestJsState([msg]),
			onResult: item => {
				const i = msg.tool_results![0].findIndex(r => r.tool_call_id === item.tool_call_id);
				msg.tool_results![0][i] = { ...msg.tool_results![0][i], data: item.data };
			},
		});
		expect(results[1].data.value).toBe('[1,2]');
		expect(results[1].data.restored).toBeUndefined();
	});

	test('timeouts keep prints, and the next run starts from the last snapshot', async () => {
		let latest: string | undefined;
		const ctx = ctxFor('timeout', () => latest);
		latest = (await runOne('z = 1', ctx)).state;
		// The print is posted before the loop starts, so it is in the log however slow the machine is.
		const data = await runOne(`z = 2; print('looping'); while (true) {}`, ctx, { timeout_secs: 1 });
		expect(data.timedOut).toBe(true);
		expect(data.ok).toBe(false);
		expect(data.state).toBeUndefined();
		expect(data.log).toEqual([{ print: 'looping' }]);
		expect(text(data)).toStartWith('looping\n\nTimed out.');
		const after = await runOne('return z', ctx);
		expect(after.value).toBe('1');
		expect(after.restored?.names).toEqual(['z']);
	}, 20_000);

	test('cancelJs stops the running snippet and drops queued ones', async () => {
		let looping!: () => void;
		const started = new Promise<void>(r => looping = r);
		const ctx: ToolContext = { ...ctxFor('cancel'), onResult: item => { if (item.data.log?.length) looping(); } };
		const running = applyToolCalls([jsCall(`print('looping'); while (true) {}`), jsCall('return 1')], ctx);
		await started;
		cancelJs('cancel');
		const results = await running;
		expect(results.map(r => r.data.cancelled)).toEqual([true, true]);
		expect(text(results[0].data)).toContain('Cancelled by the user.');
		expect((await runOne('return 2', ctx)).value).toBe('2');
	}, 20_000);

	test('missing code is a runtime error', async () => {
		const data = await runOne('   ', ctxFor('empty'));
		expect(data.error).toBe('run_js needs `code`: a string of JavaScript');
	});
});

describe('nested permission requests', () => {
	// Mirrors App: a prompt list whose entries are resolved by the user or withdrawn.
	const prompts = () => {
		const pending = new Map<string, (answer: true | string) => void>();
		return {
			pending,
			ctx: {
				requestPermission: (tc: ToolCall) => new Promise<true | string>(resolve => pending.set(tc.id, resolve)),
				dismissPermission: (id: string) => { pending.get(id)?.('denied'); pending.delete(id); },
			},
		};
	};
	const edit = (id: string): ToolCall => ({ id, type: 'function', function: { name: 'edit_file', arguments: {} } });

	test('pass through while the run lasts, holding its timeout', async () => {
		const { pending, ctx } = prompts();
		let holds = 0;
		const guard = guardPermissions(ctx, () => () => { holds++; return () => holds--; });
		const answer = guard.request!(edit('j:1'));
		expect(holds).toBe(1);
		pending.get('j:1')!(true);
		expect(await answer).toBe(true);
		expect(holds).toBe(0);
	});

	test('the end of the run withdraws waiting prompts and denies later ones', async () => {
		const { pending, ctx } = prompts();
		const guard = guardPermissions(ctx, () => undefined);
		const waiting = guard.request!(edit('j:1'));
		guard.end();
		expect(pending.size).toBe(0);
		expect(await waiting).toStartWith('Denied: the run_js run');
		expect(await guard.request!(edit('j:2'))).toStartWith('Denied: the run_js run');
		expect(pending.size).toBe(0);
	});

	test('an approval arriving after the end counts as a denial', async () => {
		let approve!: () => void;
		const guard = guardPermissions({
			requestPermission: () => new Promise(resolve => approve = () => resolve(true)),
		}, () => undefined);
		const answer = guard.request!(edit('j:1'));
		guard.end();
		approve();
		expect(await answer).toStartWith('Denied: the run_js run');
	});
});

describe('regenerating a message', () => {
	test('restores from the runs before it, not from later ones', async () => {
		const stateWith = async (x: number) => (await runOne(`x = ${x}`, ctxFor(`regen-${x}`))).state as string;
		const [s1, s2, s3] = [await stateWith(1), await stateWith(2), await stateWith(3)];
		const turn = (id: string, state: string): ChatMessage => ({
			role: 'assistant', content: [''], currentVersionIndex: 0,
			tool_calls: [[{ id, type: 'function', function: { name: 'run_js', arguments: { code: '' } } }]],
			tool_results: [[{ tool_call_id: id, name: 'run_js', data: { ok: true, log: [], state } }]],
		});
		const user = (text: string): ChatMessage => ({ role: 'user', content: [text], currentVersionIndex: 0 });

		const session = createChatSession({
			chatId: () => 'regen',
			model: () => 'm', provider: () => 'or',
			providers: () => ({ or: { url: 'http://test', apiKey: 'key', enabled: true } }),
			options: () => ({ stream: true }),
			activeConfig: () => ({ name: '', prompts: [], tools: { run_js: true } }),
			promptMessages: () => [],
			cache: () => 'none', cacheLength: () => '5m',
			macros: () => ({}), chatFolder: () => '', cut: () => -1, sendMode: () => 'single',
			lore: [], setLore: () => {},
			requestPermission: async () => true,
			backend: () => localBackend,
			setError: () => null, setInfo: () => null,
			stream: async () => ({ success: true, toolCalls: [jsCall('return x')] }),
		} as any);
		session.load([user('a'), turn('t1', s1), user('b'), turn('t2', s2), user('c'), turn('t3', s3)], 0);

		await session.sendMessage(3, false);
		const regenerated = session.messages[3];
		expect(regenerated.currentVersionIndex).toBe(1);
		expect(regenerated.tool_results?.[1]?.[0]?.data?.value).toBe('1');
	});
});

describe('latestJsState', () => {
	const result = (id: string, state?: string): ToolResult =>
		({ tool_call_id: id, name: 'run_js', data: { ok: true, log: [], ...(state && { state }) } });
	const call = (id: string, step?: number, parent?: string): ToolCall =>
		({ id, type: 'function', function: { name: 'run_js', arguments: { code: '', ...(step !== undefined && { step }) } }, ...(parent && { parent }) });

	test('takes the last run of the current versions, skipping runs that saved nothing', () => {
		const messages: ChatMessage[] = [
			{ role: 'assistant', content: [''], currentVersionIndex: 0, tool_calls: [[call('a')]], tool_results: [[result('a', 's1')]] },
			{
				role: 'assistant', content: ['', ''], currentVersionIndex: 0,
				tool_calls: [[call('b'), call('c')], [call('d')]],
				tool_results: [[result('b', 's2'), result('c')], [result('d', 's3')]],
			},
			{ role: 'user', content: ['hi'], currentVersionIndex: 0 },
		];
		expect(latestJsState(messages)).toBe('s2');
		messages[1].currentVersionIndex = 1;
		expect(latestJsState(messages)).toBe('s3');
		expect(latestJsState(messages.slice(0, 1))).toBe('s1');
		expect(latestJsState([])).toBeUndefined();
	});

	test('follows execution order, not call order', () => {
		const messages: ChatMessage[] = [{
			role: 'assistant', content: [''], currentVersionIndex: 0,
			tool_calls: [[call('r.0', 2, 'r'), call('r.1', 1, 'r')]],
			tool_results: [[result('r.0', 'late'), result('r.1', 'early')]],
		}];
		expect(latestJsState(messages)).toBe('late');
	});
});

describe('collectAttachmentRefs', () => {
	test('keeps run_js snapshots and images of nested results', async () => {
		const messages: ChatMessage[] = [{
			role: 'assistant', content: [''], currentVersionIndex: 0,
			tool_results: [[{
				tool_call_id: 'j', name: 'run_js',
				data: {
					ok: true, state: 'jsstate-abc',
					log: [
						{ print: 'hi' },
						{ call: { id: 'j:1', type: 'function', function: { name: 'read_file', arguments: {} } }, result: { tool_call_id: 'j:1', name: 'read_file', data: { images: ['nested-img', 'https://x/y.png'] } } },
						{ call: { id: 'j:2', type: 'function', function: { name: 'shell', arguments: {} } } },
					],
				},
			}]],
		}];
		expect([...await collectAttachmentRefs(messages)].sort()).toEqual(['jsstate-abc', 'nested-img']);
	});
});
