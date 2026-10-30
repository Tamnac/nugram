/**
 * run_js Worker: runs snippets as sloppy-mode async functions, bridges `tool()`
 * and the tool functions to the parent, and encodes the user-added globals
 * after every run.
 * Protocol and design: host.ts, mds/js-code-tool-plan.md
 */
import { decodeState, encodeState } from './state';
import { describeError, inspect } from './inspect';
import { callArgs, isFunctionName } from './signatures';

type Reply = { ok: boolean; text: string; data: unknown };
type ToolInfo = { name: string; parameters?: object };

const AsyncFunction = (async () => {}).constructor as new (body: string) => () => Promise<unknown>;
const g = globalThis as unknown as Record<string, unknown>;
/**
 * The run messages are tagged with. Output from a finished snippet's leftover
 * callbacks carries the old id until the next run starts, so the host drops it;
 * after that it can't be told apart from the new run's own output.
 */
let runId = 0;
const post = (msg: object) => postMessage({ ...msg, runId });

/** Lines the Function constructor adds above the body, for snippet line numbers. */
const LINE_OFFSET = (() => {
	try {
		new Function('throw new Error()')();
	} catch (e) {
		const line = /<anonymous>:(\d+)/.exec((e as Error).stack ?? '')?.[1];
		if (line) return Number(line) - 1;
	}
	return 0;
})();

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCallId = 0;
let tools: ToolInfo[] = [];
/** Names defined as tool functions: not user globals, never snapshotted or restored. */
let toolFunctions = new Set<string>();
/** Replies handed to the snippet, so returning one can show it as a direct call would. */
const replyIds = new WeakMap<object, { runId: number; id: number }>();
/** Arrays `chat()` returned: rebuilt on request, so never snapshotted. */
const chatCopies = new WeakSet<object>();

function print(...args: unknown[]) {
	post({ type: 'print', text: args.map(inspect).join(' ') });
}

/** Posts a request the host answers by id; `what` names the call in errors. */
function request<T>(msg: object, what: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const id = ++nextCallId;
		try {
			post({ ...msg, id });
		} catch (e) {
			reject(new Error(`${what}: arguments can't be sent: ${e instanceof Error ? e.message : String(e)}`));
			return;
		}
		pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
	});
}

function tool(name: string, args?: unknown): Promise<Reply> {
	return request({ type: 'call', name, args }, `tool(${JSON.stringify(name)})`);
}

function chat(opts?: unknown): Promise<unknown[]> {
	return request({ type: 'chat', opts }, 'chat()');
}

function listTools() {
	return structuredClone(tools);
}

Object.assign(globalThis, { print, tool, listTools, chat });
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = print;

addEventListener('unhandledrejection', e => {
	e.preventDefault();
	print(`Unhandled promise rejection: ${describeError((e as PromiseRejectionEvent).reason, LINE_OFFSET)}`);
});
addEventListener('error', e => {
	e.preventDefault();
	const error = e as ErrorEvent;
	print(`Uncaught ${describeError(error.error ?? error.message, LINE_OFFSET)}`);
});

onmessage = async ({ data: msg }) => {
	if (msg.type !== 'run' && msg.runId !== runId) return;
	switch (msg.type) {
		case 'result':
			if (typeof msg.reply === 'object' && msg.reply !== null) replyIds.set(msg.reply, { runId, id: msg.id });
			pending.get(msg.id)?.resolve(msg.reply);
			pending.delete(msg.id);
			break;
		case 'chatResult':
			chatCopies.add(msg.messages);
			pending.get(msg.id)?.resolve(msg.messages);
			pending.delete(msg.id);
			break;
		case 'callError':
			pending.get(msg.id)?.reject(new Error(msg.message));
			pending.delete(msg.id);
			break;
		case 'run':
			runId = msg.runId;
			tools = msg.tools;
			defineToolFunctions();
			if (msg.restore !== undefined) restore(msg.restore);
			await run(msg.code);
			break;
	}
};

// Everything above is ours; globals added after this point are the user's.
const baseline = new Set(Object.getOwnPropertyNames(globalThis));

/** `read_file(path, { range })` for each tool, as accessors so reassigning one throws. */
function defineToolFunctions() {
	for (const name of toolFunctions) delete g[name];
	toolFunctions = new Set();
	for (const { name, parameters } of tools) {
		if (!isFunctionName(name) || baseline.has(name)) continue;
		const fn = { [name]: async (...args: unknown[]) => tool(name, callArgs(name, parameters, args)) }[name];
		Object.defineProperty(globalThis, name, {
			configurable: true,
			get: () => fn,
			set: () => { throw new TypeError(`${name} is a tool function and can't be reassigned`); },
		});
		toolFunctions.add(name);
	}
}

/** Worker call ids of the replies a snippet returned (one, or an array of them) from this run. */
function shownCalls(result: unknown): number[] | undefined {
	const list = Array.isArray(result) ? result : [result];
	const ids = list.map(v => {
		const tag = typeof v === 'object' && v !== null ? replyIds.get(v) : undefined;
		return tag?.runId === runId ? tag.id : undefined;
	});
	return ids.length && ids.every(id => id !== undefined) ? ids as number[] : undefined;
}

function restore(text: string) {
	const names: string[] = [];
	let lost: string[];
	try {
		const decoded = decodeState(text);
		for (const [name, value] of Object.entries(decoded.globals)) {
			if (baseline.has(name)) continue;
			if (toolFunctions.has(name)) {
				decoded.lost.push(`${name} (now the name of a tool function)`);
				continue;
			}
			g[name] = value;
			names.push(name);
		}
		lost = decoded.lost;
	} catch (e) {
		lost = [`the saved state could not be read (${e instanceof Error ? e.message : String(e)}); started empty`];
	}
	post({ type: 'restored', names, lost });
}

async function run(code: string) {
	let value: string | undefined;
	let shown: number[] | undefined;
	let thrown: string | undefined;
	try {
		const result = await new AsyncFunction(code)();
		shown = shownCalls(result);
		if (result !== undefined && !shown) value = inspect(result);
	} catch (e) {
		thrown = describeError(e, LINE_OFFSET);
	}

	const globals: Record<string, unknown> = {};
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		if (baseline.has(name) || toolFunctions.has(name)) continue;
		const value = Object.getOwnPropertyDescriptor(globalThis, name)?.value;
		if (!chatCopies.has(value as object)) globals[name] = value;
	}
	try {
		const { text, lost } = encodeState(globals);
		post({ type: 'done', value, shown, thrown, state: text, lost });
	} catch (e) {
		post({ type: 'done', value, shown, thrown, stateError: `encoding failed: ${e instanceof Error ? e.message : String(e)}` });
	}
}
