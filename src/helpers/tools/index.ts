/**
 * Tool registry and dispatcher. Each tool is a self-contained module
 * (schema + execute + optional renderers) implementing `ToolModule`;
 * this file wires them into the schema list sent to the API and the
 * generic execution loop.
 */
import { localBackend, type Backend } from '../backend';
import type { AgentPreset, Provider, Tool, ToolCall, ToolData, ToolMode, ToolResult } from '../types';
import type { ToolContext, ToolModule, ToolResultItem } from './types';
import { isFailed, RUN_JS_TOOL, RUN_TOOL, toolModules } from './registry';
import { editFileTool } from './editFile';
import { shellTool } from './shell';
import { spawnAgentTool, spawnAgentWithPresets } from './spawnAgent';
import { readFileTool } from './readFile';
import { showWidgetTool } from './showWidget';
import { randomNumberTool } from './randomNumber';
import { randomTopicsTool } from './randomTopics';
import { grepLoreTool, readLoreEntriesTool, editLoreEntryTool } from './lore';
import { webSearchTool, fetchUrlTool } from './web';
import { andThenTool } from './andThen';
import { jsOnlyDefinition, runJsTool } from './runJs';
import { callSource } from '../jsRuntime/signatures';

export { updateFetchUrlTool, updateWebSearchTool } from './web';
export { updateSpawnAgentTool } from './spawnAgent';
export type { ToolContext, ToolModule, ToolResultItem, ToolRenderProps } from './types';
export { isFailed, resolveContent, RUN_JS_TOOL, RUN_TOOL, toolModules } from './registry';

/** Registry order defines sidebar and API ordering (desktop tools first). */
const ordered: ToolModule[] = [
	editFileTool, shellTool, spawnAgentTool, readFileTool, showWidgetTool,
	randomNumberTool, randomTopicsTool, grepLoreTool, readLoreEntriesTool, editLoreEntryTool,
	webSearchTool, fetchUrlTool, runJsTool,
];

Object.assign(toolModules, Object.fromEntries(ordered.map(m => [m.definition.function.name, m])));
// Legacy name of grep_lore — renders old chats and tolerates hallucinated calls.
toolModules.search_lore = grepLoreTool;
// Replaced by `run` steps; kept so old chats render.
toolModules.and_then = andThenTool;

const availableModules = ordered.filter(m => m.available !== false);

// `run` items carry these next to the tool's own arguments.
for (const m of ordered) {
	const props = (m.definition.function.parameters as { properties?: object }).properties ?? {};
	if ('tool' in props || 'step' in props)
		throw new Error(`${m.definition.function.name} declares a reserved parameter (tool/step)`);
}

/** Tool schemas advertised to the API on this platform. */
export const tools: Tool[] = availableModules.map(m => m.definition);

/** The selected tools with their schemas for this backend and model. */
export function describedTools(selected: Record<string, boolean> | undefined, backend: Backend = localBackend, model?: string, provider?: Provider): { module: ToolModule; tool: Tool }[] {
	return availableModules
		.filter(m => !selected || selected[m.definition.function.name] === true)
		.map(m => ({ module: m, tool: m.describe?.(backend, model, provider) ?? m.definition }));
}

/**
 * The tool definitions actually sent in a request for a given selection and
 * backend. With run_js selected, the others document their `data` for it.
 * Mode `run` wraps them all into the single `run` tool; mode `js` sends only
 * run_js, selected or not, declaring the others as functions. Nothing selected
 * sends nothing in every mode.
 */
export function sentTools(selected: Record<string, boolean> | undefined, backend: Backend = localBackend, model?: string, provider?: Provider, mode: ToolMode = 'native', agentPresets: AgentPreset[] = []): Tool[] {
	const described = describedTools(selected, backend, model, provider)
		.map(d => d.module === spawnAgentTool ? { ...d, tool: spawnAgentWithPresets(d.tool, agentPresets) } : d);
	if (mode === 'js' && described.length) {
		return [jsOnlyDefinition(described.filter(d => d.module !== runJsTool).map(({ module, tool }) => ({
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters,
			returns: module.returns,
		})))];
	}
	const withJs = described.some(d => d.module === runJsTool);
	const defs = described.map(({ module, tool }) => withJs && module.returns ? withReturns(tool, module.returns) : tool);
	return mode === 'run' && defs.length > 0 ? [runTool(defs)] : defs;
}

/** The tools a turn may run: in mode `js`, run_js beside the selection. */
export function runnableTools(selected: Record<string, boolean> | undefined, mode: ToolMode): Record<string, boolean> | undefined {
	return mode === 'js' && selected && Object.values(selected).some(Boolean) ? { ...selected, [RUN_JS_TOOL]: true } : selected;
}

/**
 * In mode `js`, direct calls to the other tools rewritten as the run_js call
 * that does the same, so the history shows the model the intended form. Left
 * alone beside a run_js call of its own.
 */
export function wrapInRunJs(calls: ToolCall[]): ToolCall[] {
	const direct = calls.filter(c => c.function.name !== RUN_JS_TOOL && c.function.name !== RUN_TOOL && toolModules[c.function.name]
		&& isPlainObject(c.function.arguments));
	if (!direct.length || calls.some(c => c.function.name === RUN_JS_TOOL)) return calls;
	const sources = direct.map(c => callSource(c.function.name, toolModules[c.function.name]!.definition.function.parameters, c.function.arguments as Record<string, unknown>));
	const code = sources.length === 1 ? `return ${sources[0]}` : `return Promise.all([\n${sources.map(s => `\t${s},`).join('\n')}\n])`;
	const wrapped: ToolCall = { id: direct[0]!.id, type: 'function', function: { name: RUN_JS_TOOL, arguments: { code } } };
	return [wrapped, ...calls.filter(c => !direct.includes(c))];
}

const withReturns = (tool: Tool, returns: string): Tool => ({
	...tool,
	function: { ...tool.function, description: `${tool.function.description ?? ''}\nIn run_js, \`tool()\` data: ${returns}` },
});

// ── Nested calls (`run`) ─────────────────────────────────────────────
// The model sees one tool whose items are calls to the real tools. Calls are
// expanded on receipt (`expandRunCalls`) and re-nested when building requests
// (`buildRequestMessages`), so everything in between works on ordinary calls.
// Design: mds/nested-tools-plan.md

const RUN_DESCRIPTION = 'Run tool calls, batched together '
	+ 'Each item names a `tool`, a `step` and that tool\'s arguments. '
	+ 'Calls sharing a step run in parallel; steps run in ascending order. '
	+ 'If any call in a step fails, all later steps are skipped. A non-zero shell exit counts as a failure, '
	+ 'except searches (rg, grep, git grep, findstr) exiting 1 for "no matches", so searches are safe to chain. '
	+ 'Queue dependent work optimistically in later steps instead of waiting for a result.';

function runTool(defs: Tool[]): Tool {
	const branch = (t: Tool) => {
		const { properties = {}, required = [], ...rest } = t.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
		return {
			...rest,
			type: 'object',
			description: t.function.description,
			properties: { tool: { type: 'string', enum: [t.function.name] }, step: { type: 'integer' }, ...properties },
			required: ['tool', 'step', ...required],
		};
	};
	return {
		type: 'function',
		function: {
			name: RUN_TOOL,
			description: RUN_DESCRIPTION,
			parameters: {
				type: 'object',
				properties: { calls: { type: 'array', items: { anyOf: defs.map(branch) } } },
				required: ['calls'],
			},
		},
	};
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Replace each well-formed `run` call with its items as ordinary calls tagged
 * with `parent`. Items without a usable `tool` name keep their raw value as
 * arguments under an empty name, so re-nesting reproduces them exactly.
 * A `run` without usable items (see `runItems`) stays as is and fails on execution.
 */
export function expandRunCalls(calls: ToolCall[]): ToolCall[] {
	return calls.flatMap(call => {
		if (call.function.name !== RUN_TOOL) return [call];
		const parsed = runItems(call);
		if ('error' in parsed) return [call];
		return parsed.items.map((item, i): ToolCall => {
			const id = `${call.id}.${i}`;
			if (!isPlainObject(item) || typeof item.tool !== 'string' || item.tool === '')
				return { id, type: 'function', function: { name: '', arguments: item as {} }, parent: call.id };
			const { tool, ...args } = item;
			return { id, type: 'function', function: { name: tool, arguments: args }, parent: call.id };
		});
	});
}

/**
 * The items of a `run` call. Some models send `calls` JSON-encoded as a
 * string, often with raw newlines inside its string literals; that is
 * accepted, and re-nesting then sends it back as an array.
 */
function runItems(call: ToolCall): { items: unknown[] } | { error: string } {
	let items = (call.function.arguments as { calls?: unknown })?.calls;
	if (typeof items === 'string') {
		const text = escapeRawControlChars(items);
		try {
			items = JSON.parse(text);
		} catch (e: any) {
			const message = String(e?.message ?? e);
			const pos = Number(message.match(/position (\d+)/)?.[1]);
			const near = Number.isFinite(pos) ? ` near ${JSON.stringify(text.slice(Math.max(0, pos - 40), pos + 20))}` : '';
			return { error: `run: \`calls\` must be an array of objects, not a string. It didn't parse as JSON either: ${message}${near}` };
		}
	}
	return Array.isArray(items) && items.length > 0
		? { items }
		: { error: 'run needs a non-empty `calls` array of { tool, step, ...arguments } items' };
}

/** Escape control characters (raw newlines, tabs) that appear inside JSON string literals. */
function escapeRawControlChars(json: string): string {
	let out = '';
	let inString = false;
	for (let i = 0; i < json.length; i++) {
		const c = json[i];
		if (inString) {
			if (c === '\\') { out += c + (json[++i] ?? ''); continue; }
			if (c === '"') inString = false;
			else if (c < ' ') { out += JSON.stringify(c).slice(1, -1); continue; }
		} else if (c === '"') inString = true;
		out += c;
	}
	return out;
}

/** The `run` item a nested call was expanded from. Inverse of `expandRunCalls`. */
export function runItem(call: ToolCall): unknown {
	return call.function.name ? { tool: call.function.name, ...call.function.arguments } : call.function.arguments;
}

/** Checks whether a result is pending, defined as whether it has structured data or stored text. */
export function isPending(result: ToolResult | undefined): boolean {
	return !result || (result.data === undefined && result.content === undefined);
}

function hasStep(call: ToolCall): boolean {
	const step = (call.function.arguments as any)?.step;
	return typeof step === 'number' ? Number.isFinite(step)
		: typeof step === 'string' && step.trim() !== '' && Number.isFinite(Number(step));
}

/** Declared execution step of a call. Unlabelled or unparseable calls share step 0. */
export function stepOf(call: ToolCall): number {
	return hasStep(call) ? Number((call.function.arguments as any).step) : 0;
}

/**
 * Calls grouped into execution steps, in execution order. Several `run` calls
 * in one turn form one chain, ordered by (run call, step); calls without a
 * parent (native mode, old chats) come first, grouped by their `step` arg
 * (absent = 0).
 */
export function executionSteps(calls: ToolCall[]): ToolCall[][] {
	const runIndex = new Map<string, number>();
	for (const c of calls) if (c.parent !== undefined && !runIndex.has(c.parent)) runIndex.set(c.parent, runIndex.size + 1);
	const groups = new Map<string, { key: [number, number]; calls: ToolCall[] }>();
	for (const c of calls) {
		const key: [number, number] = [c.parent === undefined ? 0 : runIndex.get(c.parent)!, stepOf(c)];
		const id = key.join(':');
		if (!groups.has(id)) groups.set(id, { key, calls: [] });
		groups.get(id)!.calls.push(c);
	}
	return [...groups.values()]
		.sort((a, b) => (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]))
		.map(g => g.calls);
}

/**
 * Run tool calls from the API: concurrent within a step, steps in order (see
 * `executionSteps`); a failure skips all later steps.
 *
 * Results are pushed to `ctx.onResult` as they land (including streaming
 * partials via `ctx.emit`) and returned once every call has settled or been
 * skipped.
 */
export async function applyToolCalls(toolCalls: ToolCall[], ctx: ToolContext): Promise<ToolResultItem[]> {
	if (!toolCalls || toolCalls.length === 0) return [];

	const results: ToolResultItem[] = [];
	const push = (item: ToolResultItem) => { results.push(item); ctx.onResult?.(item); };

	const processOne = async (call: ToolCall) => {
		const name = call.function.name;
		const id = call.id;
		const fail = (error: string) => push({ tool_call_id: id, name, data: { ok: false, error } });

		if (call.parent !== undefined) {
			if (!name) return fail('Each run item needs a `tool` naming one of the available tools');
			if (name === RUN_TOOL) return fail('run calls cannot be nested');
			if (!hasStep(call)) return fail(`${name}: missing \`step\``);
		} else if (name === RUN_TOOL) {
			// Well-formed but unexpanded = nesting is off; falls through to "Unknown tool".
			const parsed = runItems(call);
			if ('error' in parsed) return fail(parsed.error);
		}
		if (ctx.enabledTools && ctx.enabledTools[name] !== true) return fail(`Unknown tool ${name}`);
		const mod = toolModules[name];
		if (!mod) return fail(`Unknown tool: ${name}`);
		if (mod.available === false) return fail(`${name} is only available in the desktop app`);

		try {
			const callCtx: ToolContext = {
				...ctx,
				emit: (data: ToolData) => ctx.onResult?.({ tool_call_id: id, name, data }),
			};
			const data = await mod.execute(call, callCtx);
			push({ tool_call_id: id, name, data: { ...data, ok: data.ok ?? !isFailed(data) } });
		} catch (error: any) {
			// Safety net — modules handle their own expected failures
			fail(`${name} error: ${error?.message || error}`);
		}
	};

	const steps = executionSteps(toolCalls);
	let failed: ToolCall[] = [];
	for (const [k, step] of steps.entries()) {
		if (failed.length) {
			for (const call of step) {
				const error = `Skipped (step ${k + 1} of ${steps.length}): ${failed.map(f => failureLabel(f, call, toolCalls)).join(', ')} failed`;
				push({ tool_call_id: call.id, name: call.function.name, data: { ok: false, skipped: true, error } });
			}
			continue;
		}
		await Promise.all(step.map(processOne));
		failed = step.filter(c => results.some(r => r.tool_call_id === c.id && isFailed(r.data)));
	}

	return results;
}

/** A failed call as the skipped call's model sees it: by `[i]` within its `run` call, else by name. */
function failureLabel(failed: ToolCall, skipped: ToolCall, calls: ToolCall[]): string {
	const name = failed.function.name || 'run item';
	if (failed.parent === undefined) return name;
	const i = calls.filter(c => c.parent === failed.parent).indexOf(failed);
	return `[${i}] ${name}${failed.parent === skipped.parent ? '' : ' of an earlier run call'}`;
}
