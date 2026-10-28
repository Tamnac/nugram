import { createSignal, Index, Show } from 'solid-js';
import type { Tool, ToolCall, ToolData, ToolResult } from '../types';
import type { ToolContext, ToolModule } from './types';
import { applyToolCalls, describedTools } from './index';
import { isFailed, resolveContent, RUN_JS_TOOL, RUN_TOOL } from './registry';
import { jsRuntimeKey, runJs, type JsCallReply, type JsHold } from '../jsRuntime/host';
import { capList } from '../jsRuntime/state';
import { declarations, type ToolSignature } from '../jsRuntime/signatures';
import { chatView } from '../jsRuntime/chatView';
import { MatrixLoader, ToolArgsView, ToolResultView, ToolSummaryItem } from '../ToolViews';

// Model-written JavaScript that calls the other tools; only its prints, return
// value and errors reach the model. Runtime: helpers/jsRuntime/.
// Design: mds/js-code-tool-plan.md

const MAX_CALLS = 100;
const MAX_OUTPUT = 50_000;
const DEFAULT_TIMEOUT_SECS = 600;
const MAX_TIMEOUT_SECS = 3600;
const ENDED_DENIAL = 'Denied: the run_js run that made this call had already ended.';

export type RunJsLogEntry = { print: string } | { call: ToolCall; result?: ToolResult };

/** With `declared` (run_js-only mode), the tools are documented here instead of as tools of their own. */
function describe(declared?: string): string {
	const own = declared === undefined;
	return [
		'Run JavaScript in a sandboxed Web Worker (fetch available) that can call other tools. The code is the body of an async function.',
		own
			? 'Every tool is a global async function taking its required parameters in order, then an object of the optional ones: `some_tool(first, second, { optional })`. `tool(name, args)` takes the arguments object of a direct call instead (more verbose, avoid).'
			: 'This is the only top-level tool. Other tools are global async functions within it, called as `some_tool(first, second, { optional })` required parameters first. `tool(name, args)` takes the whole arguments object instead (more verbose, avoid).',
		'Both resolve to `{ ok, text, data }` no throwing: `ok` is success, `text` what a direct call would show you, `data` the structured result. `data.ok` is always present; failures usually carry an `error` string.',
		own
			? 'Tools document the fields of `data` you can rely on at the end of their description (other fields may appear; ignore them); where one doesn\'t, use `text`. `listTools()` returns `[{ name, description, parameters, returns? }]`.'
			: 'Declarations list the fields of `data` you can rely on (other fields may appear; ignore them); where one doesn\'t, use `text`.',
		'`print(...)` and `console.log(...)` write output: strings as-is, other values as JSON (no need to stringify yourself). Only prints, the return value and errors come back to you, not the results of tool calls made inside, so print what you need. When doing a simple call w/ no data manipulation needed, the best way is to return the reply itself, `return some_tool(...)`, or an array of only replies: you get just the text a direct call would show, images included. Any other return value, including copies of replies or replies mixed with other values, comes back as JSON.',
		'`await chat()` returns this conversation, read-only and oldest first, as `[{ role, text, thinking?, calls?: [{ name, args, text? }] }]` (`text` of a call is its result; thinking and calls are usually not needed). `chat({ hidden: true })` also includes earlier messages that are not in your context (cut off by the user, e.g. after a summary of them), marked `hidden: true`. Sub-agents can read the chat that spawned them, up to the spawn; if you are one, use `chat({ parent: true })`. A `chat()` result kept in a global is not saved across restarts; call it again.',
		'You may only call this once/turn, but it is trivial to do multiple tasks inside, or parallel calls using `Promise.all`, or sequential ones that go off the previous.',
		'shell, fetch_url and web_search calls still running when the run ends are stopped.',
		'State: globals (assigned without let/const/var, e.g. `cache = new Map()` or `parse = s => ...`) persist across runs and app restarts. Restarts are rare, but cause a couple of degradations: Functions are saved as source, they lose variables they captured. Class instances come back as plain objects.',
	].join(' ') + (own ? '' : declared ? `\n\n\`\`\`ts\n${declared}\n\`\`\`` : '\n\nNo other tools are selected.');
}

const definition: Tool = {
	type: 'function',
	function: {
		name: RUN_JS_TOOL,
		description: describe(),
		parameters: {
			type: 'object',
			properties: {
				code: {
					type: 'string',
					description: 'JavaScript: the body of an async function'
				},
				timeout_secs: {
					type: 'integer',
					description: `Wall-clock limit in seconds, 1 to ${MAX_TIMEOUT_SECS} (default: ${DEFAULT_TIMEOUT_SECS}). Omit unless the run needs longer, or you want it stopped sooner.`
				}
			},
			required: ['code']
		}
	}
};

/** run_js as the only tool, documenting the others as functions. */
export function jsOnlyDefinition(tools: ToolSignature[]): Tool {
	return { ...definition, function: { ...definition.function, description: describe(declarations(tools)) } };
}

/** The run's limit in seconds, or why `timeout_secs` is invalid. */
function timeoutSecs(raw: unknown): number | string {
	if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_SECS;
	const secs = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
	return Number.isInteger(secs) && secs >= 1 && secs <= MAX_TIMEOUT_SECS ? secs
		: `run_js: timeout_secs must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECS}, got ${JSON.stringify(raw)}`;
}

const firstLine = (text: string) => {
	const line = text.split('\n').find(l => l.trim())?.trim() ?? '';
	return line.length > 200 ? line.slice(0, 200) + '…' : line;
};

const logOf = (data: ToolData): RunJsLogEntry[] => Array.isArray(data.log) ? data.log : [];

const isCall = (entry: RunJsLogEntry | undefined): entry is { call: ToolCall; result?: ToolResult } =>
	!!entry && typeof (entry as { call?: unknown }).call === 'object' && (entry as { call?: unknown }).call !== null;

const isPrint = (entry: RunJsLogEntry | undefined): entry is { print: string } =>
	!!entry && typeof (entry as { print?: unknown }).print === 'string';

function restoredNotice(restored: { names?: string[]; lost?: string[] }): string {
	const names = Array.isArray(restored.names) ? restored.names : [];
	const lost = Array.isArray(restored.lost) ? restored.lost : [];
	const parts = [names.length
		? `The runtime was restarted and globals were restored from the saved state: ${names.join(', ')}. Functions were restored from source and lost any variables they captured.`
		: 'The runtime was restarted; the saved state had no globals.'];
	if (lost.length) parts.push(`Lost on restore: ${capList(lost).join(', ')}.`);
	return parts.join(' ');
}

/** Log entries of the replies the snippet returned, in order. */
function shownEntries(data: ToolData, log: RunJsLogEntry[]): { call: ToolCall; result?: ToolResult }[] {
	if (!Array.isArray(data.shown)) return [];
	const calls = log.filter(isCall);
	return data.shown.flatMap((id: unknown) => calls.filter(e => e.call.id === id));
}

function failedCalls(log: RunJsLogEntry[], skip: Set<unknown>): string | undefined {
	const failed = log.filter(isCall)
		.filter(e => !skip.has(e))
		.filter(e => !e.result || e.result.data?.running || (e.result.content === undefined && isFailed(e.result.data)))
		.map(e => `${e.call.function?.name ?? '?'} (${!e.result || e.result.data?.running ? 'unfinished' : firstLine(resolveContent(e.result))})`);
	if (!failed.length) return undefined;
	const listed = failed.slice(0, 10).join('; ');
	return `Failed tool calls: ${listed}${failed.length > 10 ? `; and ${failed.length - 10} more` : ''}`;
}

function formatRunJs(data: ToolData): string {
	const log = logOf(data);
	const parts: string[] = [];
	const shown = shownEntries(data, log);
	if (shown.length) parts.push(shown.map(e => (shown.length > 1 ? `${e.call.function.name}:\n` : '') + (e.result ? resolveContent(e.result) : '(no result)')).join('\n\n'));
	else if (typeof data.value === 'string') parts.push(`Return value: ${data.value}`);
	if (typeof data.thrown === 'string') parts.push(`Uncaught ${data.thrown}`);
	if (data.timedOut) parts.push('Timed out. The runtime was stopped; the next run starts from the globals saved by the last finished run.');
	if (data.cancelled) parts.push('Cancelled by the user. The runtime was stopped; the next run starts from the globals saved by the last finished run.');
	if (data.restored && typeof data.restored === 'object') parts.push(restoredNotice(data.restored));
	if (Array.isArray(data.lost) && data.lost.length) parts.push(`Saved globals that won't come back intact after a restart: ${capList(data.lost).join(', ')}`);
	if (typeof data.stateError === 'string') parts.push(`Globals were not saved: ${data.stateError}`);
	const failed = failedCalls(log, new Set(shown));
	if (failed) parts.push(failed);

	// Prints get what's left of the budget after everything else, which is usually short.
	const note = `[output truncated at ${MAX_OUTPUT} characters]`;
	const prints = log.filter(isPrint).map(e => e.print).join('\n');
	const budget = Math.max(0, MAX_OUTPUT - parts.reduce((n, p) => n + p.length + 2, note.length + 2));
	const cut = prints.length > budget;
	const printed = cut ? prints.slice(0, budget) : prints;
	const head: string[] = [];
	if (printed) head.push(printed);
	if (cut || data.truncated) head.push(note);
	const text = [...head, ...parts].join('\n\n') || '(no output)';
	// Only when the return value or error alone is over the cap.
	return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + `\n[truncated at ${MAX_OUTPUT} characters]` : text;
}

/**
 * Permission requests of one run's nested calls. While a prompt waits, the
 * run's timeout is held. Once `end` is called, nested calls still in flight
 * must not act: waiting prompts are withdrawn, new requests are denied, and
 * approvals arriving afterwards count as denials.
 */
export function guardPermissions(ctx: Pick<ToolContext, 'requestPermission' | 'dismissPermission'>, hold: () => JsHold | undefined) {
	let ended = false;
	const waiting = new Map<string, (answer: string) => void>();
	const ask = ctx.requestPermission;
	return {
		request: ask && (async (toolCall: ToolCall): Promise<true | string> => {
			if (ended) return ENDED_DENIAL;
			const release = hold()?.();
			const withdrawn = new Promise<string>(resolve => waiting.set(toolCall.id, resolve));
			try {
				const answer = await Promise.race([ask(toolCall), withdrawn]);
				return ended ? ENDED_DENIAL : answer;
			} finally {
				waiting.delete(toolCall.id);
				release?.();
			}
		}),
		end() {
			ended = true;
			for (const [id, deny] of waiting) {
				ctx.dismissPermission?.(id);
				deny(ENDED_DENIAL);
			}
		},
	};
}

export const runJsTool: ToolModule = {
	definition,

	async execute(call, ctx) {
		const args = call.function.arguments as { code?: unknown; timeout_secs?: unknown };
		if (typeof args?.code !== 'string' || !args.code.trim()) return { ok: false, error: 'run_js needs `code`: a string of JavaScript' };
		const timeout = timeoutSecs(args.timeout_secs);
		if (typeof timeout === 'string') return { ok: false, error: timeout };

		const reachable = describedTools(ctx.enabledTools, ctx.backend, ctx.model, ctx.provider)
			.filter(({ tool }) => tool.function.name !== RUN_JS_TOOL)
			.map(({ module, tool }) => ({
				name: tool.function.name,
				description: tool.function.description,
				parameters: tool.function.parameters,
				...(module.returns && { returns: module.returns }),
			}));
		const names = new Set(reachable.map(t => t.name));

		let log: RunJsLogEntry[] = [];
		let printed = 0;
		let truncated = false;
		let calls = 0;
		let denied = false;
		let finished = false;
		let hold: JsHold | undefined;
		const permissions = guardPermissions(ctx, () => hold);
		// Stops nested calls still running when the run ends.
		const ended = new AbortController();

		// Streaming updates replace the data wholesale; batch bursts of prints and partials.
		// Calls the snippet didn't await may settle after it ends; they must not
		// overwrite the final result.
		let pendingEmit: ReturnType<typeof setTimeout> | undefined;
		const emit = () => {
			if (finished) return;
			pendingEmit ??= setTimeout(() => {
				pendingEmit = undefined;
				ctx.emit?.({ ok: true, running: true, log, ...(truncated && { truncated }) });
			}, 50);
		};

		const print = (text: string) => {
			if (truncated) return;
			if (printed + text.length > MAX_OUTPUT) {
				text = text.slice(0, Math.max(0, MAX_OUTPUT - printed));
				truncated = true;
			}
			printed += text.length + 1;
			const last = log[log.length - 1];
			log = isPrint(last) ? [...log.slice(0, -1), { print: last.print + '\n' + text }] : [...log, { print: text }];
			emit();
		};

		// The bridge: each nested call goes through the normal dispatcher with this
		// chat's context, so tool selection and permissions apply per call. Results
		// land in this call's log instead of the message's tool_results.
		const callTool = async (name: unknown, rawArgs: unknown): Promise<{ id: string; reply: JsCallReply }> => {
			if (typeof name !== 'string' || !name) throw new Error('tool(name, args): name must be a tool name');
			if (name === RUN_JS_TOOL || name === RUN_TOOL) throw new Error(`${name} can't be called from run_js`);
			if (!names.has(name)) throw new Error(`Unknown tool ${name}; listTools() lists the available ones`);
			if (calls >= MAX_CALLS) throw new Error(`run_js allows at most ${MAX_CALLS} tool calls per run`);
			const toolArgs = rawArgs === undefined ? {} : JSON.parse(JSON.stringify(rawArgs));
			if (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs))
				throw new Error(`tool(${JSON.stringify(name)}, args): args must be an object`);

			const nested: ToolCall = { id: `${call.id}:${++calls}`, type: 'function', function: { name, arguments: toolArgs } };
			const index = log.length;
			log = [...log, { call: nested }];
			emit();
			const settle = (data: ToolData) => {
				log = log.slice();
				log[index] = { call: nested, result: { tool_call_id: nested.id, name, data } };
				emit();
			};
			const [item] = await applyToolCalls([nested], { ...ctx, signal: ended.signal, requestPermission: permissions.request, emit: undefined, onResult: item => settle(item.data) });
			const data = item?.data ?? { ok: false, error: `${name} produced no result` };
			if (data.denied) denied = true;
			return { id: nested.id, reply: { ok: !isFailed(data), text: resolveContent({ tool_call_id: nested.id, name, data }), data } };
		};

		const outcome = await runJs({
			key: jsRuntimeKey(ctx.chatId, ctx.shellSession),
			code: args.code,
			timeoutMs: timeout * 1000,
			latestState: () => ctx.latestJsState?.(),
			tools: () => reachable,
			callTool,
			chat: ctx.chatMessages && (raw => {
				const opts = raw as { hidden?: unknown; parent?: unknown } | undefined;
				if (opts?.parent === true && !ctx.parentChat) throw new Error('chat({ parent: true }): only sub-agents have a parent chat');
				const { messages, cut } = opts?.parent === true ? ctx.parentChat! : ctx.chatMessages!();
				return chatView(messages, cut, { hidden: opts?.hidden === true });
			}),
			onPrint: print,
			onStart: h => { hold = h; },
		});
		finished = true;
		clearTimeout(pendingEmit);
		permissions.end();
		ended.abort();

		const { error, ...rest } = outcome;
		const shown = shownEntries(outcome, log);
		const images = shown.flatMap(e => Array.isArray(e.result?.data?.images) ? e.result.data.images : []);
		return {
			...rest,
			// Shown replies stand in for direct calls, so their failure is the run's.
			...(shown.length && shown.every(e => isFailed(e.result?.data)) && { ok: false }),
			log,
			...(images.length && { images }),
			...(truncated ? { truncated } : {}),
			...(denied ? { denied } : {}),
			...(error !== undefined && { error }),
		};
	},

	format: formatRunJs,

	Summary: props => {
		const code = () => String((props.call.function.arguments as { code?: unknown })?.code ?? '');
		const calls = () => props.result?.data ? logOf(props.result.data).filter(isCall).length : 0;
		return <span>js <code>{firstLine(code())}</code>{calls() ? ` · ${calls()} call${calls() === 1 ? '' : 's'}` : ''}</span>;
	},

	Args: props => {
		const args = () => props.call.function.arguments as { code?: unknown; timeout_secs?: unknown };
		return (
			<div class='toolArgEdit'>
				<pre class='shellCommand toolScroll'>{String(args().code ?? '')}</pre>
				{args().timeout_secs ? <span style={{ opacity: '0.5', 'font-size': '0.85em' }}>timeout: {String(args().timeout_secs)}s</span> : null}
			</div>
		);
	},

	Result: props => <RunJsLog data={props.data} />,
};

function RunJsLog(props: { data: ToolData }) {
	const notices = () => formatRunJs({ ...props.data, log: [] }).replace(/^\(no output\)$/, '');
	return (
		<div class='toolResultContent jsLog'>
			<Index each={logOf(props.data)}>
				{entry => isCall(entry())
					? <NestedCall entry={entry as () => { call: ToolCall; result?: ToolResult }} running={!!props.data.running} />
					: <pre class='jsPrint'>{(entry() as { print?: string }).print ?? ''}</pre>}
			</Index>
			<Show when={!props.data.running && notices()}>
				<pre class='jsPrint' classList={{ jsFailed: props.data.ok === false }}>{notices()}</pre>
			</Show>
		</div>
	);
}

/** A call made by the snippet, rendered like a top-level tool call: chip, then args and result when expanded. */
function NestedCall(props: { entry: () => { call: ToolCall; result?: ToolResult }; running: boolean }) {
	const [open, setOpen] = createSignal(false);
	const result = () => props.entry().result;
	const settled = () => !!result() && !result()!.data?.running;
	return (
		<div class='jsCall'>
			<div onClick={() => setOpen(o => !o)}>
				<ToolSummaryItem toolCall={props.entry().call} toolResult={result()} />
			</div>
			<Show when={open()}>
				<div class='tool'>
					<ToolArgsView call={props.entry().call} result={result()} />
					<Show when={result()}>{r => <ToolResultView result={r()} />}</Show>
					<Show when={!settled()}>
						{props.running ? <MatrixLoader /> : <div class='jsPrint'>(did not finish)</div>}
					</Show>
				</div>
			</Show>
		</div>
	);
}
