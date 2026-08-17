/**
 * Tool registry and dispatcher. Each tool is a self-contained module
 * (schema + execute + optional renderers) implementing `ToolModule`;
 * this file wires them into the schema list sent to the API and the
 * generic execution loop.
 */
import type { Tool, ToolCall, ToolData, ToolResult } from '../types';
import type { ToolContext, ToolModule, ToolResultItem } from './types';
import { editFileTool } from './editFile';
import { shellTool } from './shell';
import { spawnAgentTool } from './spawnAgent';
import { readFileTool } from './readFile';
import { randomNumberTool } from './randomNumber';
import { createTimerTool } from './timer';
import { grepLoreTool, readLoreEntriesTool, editLoreEntryTool } from './lore';
import { webSearchTool, fetchUrlTool } from './web';

export { updateFetchUrlTool, updateWebSearchTool } from './web';
export { updateSpawnAgentTool } from './spawnAgent';
export type { ToolContext, ToolModule, ToolResultItem, ToolRenderProps } from './types';

/** Registry order defines sidebar and API ordering (desktop tools first). */
const ordered: ToolModule[] = [
	editFileTool, shellTool, spawnAgentTool, readFileTool,
	randomNumberTool, createTimerTool, grepLoreTool, readLoreEntriesTool, editLoreEntryTool,
	webSearchTool, fetchUrlTool,
];

/**
 * Optional ordering parameter, injected into every schema rather than written
 * per tool. Definitions are mutated in place because they are live objects —
 * `updateWebSearchTool` and friends rewrite them at runtime.
 */
const STEP_PARAM = {
	type: 'integer',
	description: 'Dependent sequential step group. Default: 0. Use to optimistically chain calls'
};

for (const m of ordered) {
	const params = m.definition.function.parameters as { properties?: Record<string, any> };
	(params.properties ??= {}).step = STEP_PARAM;
}

export const toolModules: Record<string, ToolModule> = Object.fromEntries(ordered.map(m => [m.definition.function.name, m]));
// Legacy name of grep_lore — renders old chats and tolerates hallucinated calls.
toolModules.search_lore = grepLoreTool;

/** Tool schemas advertised to the API on this platform. */
export const tools: Tool[] = ordered.filter(m => m.available !== false).map(m => m.definition);

// Formatting is pure and data objects are replaced wholesale on every update,
// so results can be cached by data identity — buildRequest re-walks the whole
// history on every send.
const formatCache = new WeakMap<object, string>();

/** The model-facing text of a result: the stored override, else formatted data. */
export function resolveContent(result: ToolResult): string {
	if (result.content !== undefined) return result.content;
	const data = result.data;
	if (!data) return '';
	const cached = formatCache.get(data);
	if (cached !== undefined) return cached;
	let text: string;
	try {
		text = data.error !== undefined ? data.error : (toolModules[result.name]?.format(data) ?? '');
	} catch (e) {
		// A formatter must never break the request; fall back to something legible.
		console.error(`format ${result.name} failed:`, e);
		text = data.error ?? JSON.stringify(data);
	}
	formatCache.set(data, text);
	return text;
}

/** A result is pending while it has neither structured data nor stored text. */
export function isPending(result: ToolResult | undefined): boolean {
	return !result || (result.data === undefined && result.content === undefined);
}

/** Declared execution step of a call. Unlabelled or unparseable calls share step 0. */
export function stepOf(call: ToolCall): number {
	const step = Number((call.function.arguments as any)?.step);
	return Number.isFinite(step) ? step : 0;
}

const isFailure = (item: ToolResultItem) => item.data.ok === false || item.data.error !== undefined;

/**
 * Run tool calls from the API. Concurrent within sequential steps. A failure skips future steps.
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

		if (ctx.enabledTools && ctx.enabledTools[name] !== true) return fail(`Unknown tool ${name}`);
		const mod = toolModules[name];
		if (!mod) return fail(`Unknown tool: ${name}`);
		if (mod.available === false) return fail(`${name} is only available in the desktop app`);

		try {
			const callCtx: ToolContext = {
				...ctx,
				emit: (data: ToolData) => ctx.onResult?.({ tool_call_id: id, name, data }),
			};
			push({ tool_call_id: id, name, data: await mod.execute(call, callCtx) });
		} catch (error: any) {
			// Safety net — modules handle their own expected failures
			fail(`${name} error: ${error?.message || error}`);
		}
	};

	const steps = [...new Set(toolCalls.map(stepOf))].sort((a, b) => a - b);
	for (const step of steps) {
		await Promise.all(toolCalls.filter(c => stepOf(c) === step).map(processOne));

		const failed = results.filter(isFailure);
		if (failed.length === 0) continue;

		const names = [...new Set(failed.map(f => f.name))].join(', ');
		for (const call of toolCalls.filter(c => stepOf(c) > step))
			push({
				tool_call_id: call.id,
				name: call.function.name,
				data: { ok: false, skipped: true, error: `Skipped: step ${step} failed (${names})` }
			});
		break;
	}

	return results;
}
