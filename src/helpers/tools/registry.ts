/**
 * Tool lookups shared by the dispatcher, the views and run_js. Imports no tool
 * modules, so those can use it without an import cycle; `tools/index.ts` fills
 * `toolModules`.
 */
import type { ToolData, ToolResult } from '../types';
import type { ToolModule } from './types';

export const RUN_TOOL = 'run';
export const RUN_JS_TOOL = 'run_js';

export const toolModules: Record<string, ToolModule> = {};

/** Whether a call failed: no result, `ok: false`, an error, or denied by the user. */
export const isFailed = (data: ToolData | undefined) => !data || data.ok === false || data.error !== undefined || !!data.denied;

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
