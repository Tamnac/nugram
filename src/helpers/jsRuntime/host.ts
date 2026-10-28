/**
 * Parent side of run_js: one module Worker per chat, a queue so a chat runs one
 * snippet at a time, the tool-call bridge, restore-before-run and snapshot
 * saving. The Worker only ever hands over an opaque state string.
 * Design: mds/js-code-tool-plan.md
 */
import { loadJsState, saveJsState } from '../attachments';
import type { ToolData } from '../types';
import { stateId } from './state';

export const MAX_STATE_CHARS = 5_000_000;

export interface JsToolInfo { name: string; description?: string | undefined; parameters?: object | undefined; returns?: string | undefined }
export interface JsCallReply { ok: boolean; text: string; data: ToolData }

/** Worker key: the chat id, or the session's own key while the chat has none yet. */
export const jsRuntimeKey = (chatId: string | undefined, session: string | undefined) => chatId || `session:${session ?? ''}`;

/** Pauses the run's wall-clock timeout until the returned release is called. */
export type JsHold = () => () => void;

export interface JsRun {
	key: string;
	code: string;
	timeoutMs: number;
	/** Snapshot id the visible history ends on; read once the run gets its turn. */
	latestState: () => string | undefined;
	tools: () => JsToolInfo[];
	/** Runs one nested call; `id` is its call id. Rejections reach the snippet as a thrown error. */
	callTool: (name: string, args: unknown) => Promise<{ id: string; reply: JsCallReply }>;
	/** Builds what `chat(opts)` returns; absent = no chat to read. Throws reach the snippet. */
	chat?: ((opts: unknown) => unknown[]) | undefined;
	onPrint: (text: string) => void;
	/** Receives the run's timeout hold once the run gets its turn. */
	onStart?: ((hold: JsHold) => void) | undefined;
}

export interface JsOutcome {
	ok: boolean;
	value?: string;
	/** Call ids of the replies the snippet returned, shown in place of a return value. */
	shown?: string[];
	thrown?: string;
	state?: string;
	lost?: string[];
	stateError?: string;
	restored?: { names: string[]; lost: string[] };
	timedOut?: true;
	cancelled?: true;
	/** The runtime itself failed (Worker crashed or didn't load). */
	error?: string;
}

interface Runtime {
	worker: Worker;
	/** Snapshot the live globals correspond to. */
	ref: string | undefined;
	/** Ends the current run by terminating the Worker. */
	kill?: ((outcome: Partial<JsOutcome>) => void) | undefined;
}

const runtimes = new Map<string, Runtime>();
const queues = new Map<string, Promise<unknown>>();
/** Bumped by cancelJs so runs queued before the cancel don't start. */
const generations = new Map<string, number>();
/** Tags worker↔host messages, so output a finished run produces late isn't taken for the next run's. */
let nextRunId = 0;

export function runJs(run: JsRun): Promise<JsOutcome> {
	const generation = generations.get(run.key) ?? 0;
	const next = (queues.get(run.key) ?? Promise.resolve()).then(() =>
		(generations.get(run.key) ?? 0) === generation ? execute(run, generation) : { ok: false, cancelled: true } as JsOutcome);
	// Release the next run a macrotask later: by then this run's result is in the
	// message history, so the next restore check sees this run's state.
	const released = next.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve)));
	queues.set(run.key, released);
	released.then(() => { if (queues.get(run.key) === released) queues.delete(run.key); });
	return next;
}

/** Stop the chat's running snippet (terminating its Worker) and drop queued ones. */
export function cancelJs(key: string): void {
	generations.set(key, (generations.get(key) ?? 0) + 1);
	runtimes.get(key)?.kill?.({ cancelled: true });
}

async function execute(run: JsRun, generation: number): Promise<JsOutcome> {
	const latest = run.latestState();
	let rt = runtimes.get(run.key);
	if (rt && rt.ref !== latest) {
		rt.worker.terminate();
		runtimes.delete(run.key);
		rt = undefined;
	}

	let restore: string | undefined;
	const loadLost: string[] = [];
	if (!rt) {
		if (latest) {
			restore = await loadJsState(latest).catch(() => undefined);
			if (restore === undefined) loadLost.push('the saved state could not be loaded; started empty');
			if ((generations.get(run.key) ?? 0) !== generation) return { ok: false, cancelled: true };
		}
		rt = { worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), ref: latest };
		runtimes.set(run.key, rt);
	}
	return talk(run, rt, restore, loadLost);
}

function talk(run: JsRun, rt: Runtime, restore: string | undefined, loadLost: string[]): Promise<JsOutcome> {
	const { worker } = rt;
	const runId = ++nextRunId;
	return new Promise(resolve => {
		let restored: JsOutcome['restored'] = loadLost.length ? { names: [], lost: loadLost } : undefined;
		const callIds = new Map<number, string>();
		let done = false;

		// Stands still while any hold is out, and for good once the snippet is done.
		let timer: ReturnType<typeof setTimeout> | undefined;
		let remaining = run.timeoutMs;
		let startedAt = 0;
		let running = true;
		let holds = 0;
		const stopTimer = () => {
			if (timer === undefined) return;
			clearTimeout(timer);
			timer = undefined;
			remaining -= Date.now() - startedAt;
		};
		const startTimer = () => {
			if (done || !running || holds > 0 || timer !== undefined) return;
			startedAt = Date.now();
			timer = setTimeout(() => kill({ timedOut: true }), Math.max(0, remaining));
		};
		const hold: JsHold = () => {
			holds++;
			stopTimer();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				holds--;
				startTimer();
			};
		};

		const finish = (outcome: Partial<JsOutcome>) => {
			if (done) return;
			done = true;
			stopTimer();
			rt.kill = undefined;
			worker.onmessage = worker.onerror = worker.onmessageerror = null;
			resolve({ ok: false, ...(restored && { restored }), ...outcome });
		};
		const kill = (outcome: Partial<JsOutcome>) => {
			if (done) return;
			worker.terminate();
			if (runtimes.get(run.key) === rt) runtimes.delete(run.key);
			finish(outcome);
		};
		rt.kill = kill;
		startTimer();
		run.onStart?.(hold);

		const post = (msg: object) => {
			if (done) return;
			try {
				worker.postMessage(msg);
			} catch {
				worker.postMessage(JSON.parse(JSON.stringify(msg)));
			}
		};

		worker.onerror = e => {
			e.preventDefault();
			kill({ error: `JavaScript runtime failed: ${e.message || 'the worker could not start'}` });
		};
		worker.onmessageerror = () => kill({ error: 'JavaScript runtime failed: a message could not be decoded' });
		worker.onmessage = ({ data: msg }) => {
			if (done || msg.runId !== runId) return;
			switch (msg.type) {
				case 'print':
					run.onPrint(msg.text);
					break;
				case 'restored':
					restored = { names: msg.names, lost: [...loadLost, ...msg.lost] };
					break;
				case 'call':
					run.callTool(msg.name, msg.args).then(
						({ id, reply }) => {
							callIds.set(msg.id, id);
							post({ type: 'result', runId, id: msg.id, reply });
						},
						e => post({ type: 'callError', runId, id: msg.id, message: e instanceof Error ? e.message : String(e) }),
					);
					break;
				case 'chat':
					try {
						if (!run.chat) throw new Error("chat() isn't available here");
						post({ type: 'chatResult', runId, id: msg.id, messages: run.chat(msg.opts) });
					} catch (e) {
						post({ type: 'callError', runId, id: msg.id, message: e instanceof Error ? e.message : String(e) });
					}
					break;
				case 'done':
					stopTimer();
					running = false;
					rt.kill = undefined;
					saveState(rt, msg).then(saved => finish({
						ok: msg.thrown === undefined,
						...(msg.value !== undefined && { value: msg.value }),
						...(Array.isArray(msg.shown) && { shown: msg.shown.map((id: number) => callIds.get(id)).filter((id: unknown) => id !== undefined) }),
						...(msg.thrown !== undefined && { thrown: msg.thrown }),
						...(msg.lost?.length && { lost: msg.lost }),
						...saved,
					}));
					break;
			}
		};

		post({ type: 'run', runId, code: run.code, tools: run.tools(), ...(restore !== undefined && { restore }) });
	});
}

/** Store the Worker's snapshot; over the cap or on failure, keep the previous ref. */
async function saveState(rt: Runtime, msg: { state?: string; stateError?: string }): Promise<Pick<JsOutcome, 'state' | 'stateError'>> {
	const previous = rt.ref !== undefined ? { state: rt.ref } : {};
	if (typeof msg.state !== 'string') return { ...previous, stateError: msg.stateError ?? 'no state was produced' };
	if (msg.state.length > MAX_STATE_CHARS)
		return { ...previous, stateError: `globals take ${(msg.state.length / 1e6).toFixed(1)} MB encoded, over the ${MAX_STATE_CHARS / 1e6} MB limit` };
	try {
		const id = await stateId(msg.state);
		await saveJsState(id, msg.state);
		rt.ref = id;
		return { state: id };
	} catch (e) {
		return { ...previous, stateError: `saving failed: ${e instanceof Error ? e.message : String(e)}` };
	}
}
