import type { Component } from 'solid-js';
import type { SetStoreFunction } from 'solid-js/store';
import type { LoreEntry } from '../lore';
import type { Tool, ToolCall, ToolData, ToolResult } from '../types';

/** Everything a tool's execute() may need from the running session. */
export interface ToolContext {
	lore?: LoreEntry[] | undefined;
	setLore?: SetStoreFunction<LoreEntry[]> | undefined;
	chatFolder?: string | undefined;
	chatId?: string | undefined;
	/** Key for per-session shell state in the Tauri backend (previous output, cancellation). */
	shellSession?: string | undefined;
	/** Tool selection: undefined = all enabled; defined = only `true` entries run. */
	enabledTools?: Record<string, boolean> | undefined;
	/** Runs a spawn_agent call. Absent = tool unavailable (web build, or a sub-agent). */
	spawnAgent?: ((args: any, callId?: string) => Promise<string>) | undefined;
	requestPermission?: ((toolCall: ToolCall) => Promise<true | string>) | undefined;
	timers?: {
		setActive: (active: boolean) => void;
		setRemaining: (remaining: number) => void;
		setReady: (ready: boolean) => void;
		setDuration: (duration: number) => void;
	} | undefined;
	/** Receives each finished (and streaming-partial) result as it lands. */
	onResult?: ((item: ToolResultItem) => void) | undefined;
	/** Stream partial data for the current call. Bound per-call by the dispatcher. */
	emit?: ((data: ToolData) => void) | undefined;
}

export type ToolResultItem = {
	tool_call_id: string;
	name: string;
	data: ToolData;
};

export interface ToolRenderProps {
	call: ToolCall;
	result?: ToolResult | undefined;
}

/** A tool: schema, execution, model-facing formatting and rendering, in one place. */
export interface ToolModule {
	definition: Tool;
	/** False when the tool doesn't exist on this platform (web build). */
	available?: boolean;
	execute: (call: ToolCall, ctx: ToolContext) => Promise<ToolData>;
	/**
	 * Render the model-facing text from structured data. Must be pure and total:
	 * it runs on persisted data, possibly long after execution. Never called for
	 * `{ error }` data (handled centrally) or for stored `content` overrides.
	 */
	format: (data: ToolData) => string;
	/** Chip body for the collapsed tool header. Default: tool name. */
	Summary?: Component<ToolRenderProps>;
	/** Expanded args view. Default: inline key/value pairs. */
	Args?: Component<ToolRenderProps>;
	/**
	 * Expanded result view, rendered from `result.data`. Like `format`, it is
	 * never called for `{ error }` data (rendered centrally as text) or for
	 * results carrying a `content` override — `LegacyResult` handles those.
	 */
	Result?: Component<{ data: ToolData }>;
	/** View for stored text: user edits and results from before structured data existed. */
	LegacyResult?: Component<{ content: string }>;
	/** Failure detection for chip styling when `data.ok` is absent (legacy results, malformed args). */
	failed?: (call: ToolCall, result?: ToolResult) => boolean;
}
