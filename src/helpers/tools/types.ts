import type { Component } from 'solid-js';
import type { SetStoreFunction } from 'solid-js/store';
import type { Backend } from '../backend';
import type { LoreEntry } from '../lore';
import type { ChatMessage, Fold, Provider, Tool, ToolCall, ToolData, ToolResult } from '../types';

/** Messages, the cut index, and the folded spans. */
export interface ChatSnapshot { messages: ChatMessage[]; cut: number; folds?: Fold[] | undefined }

/** Everything a tool's execute() may need from the running session. */
export interface ToolContext {
	lore?: LoreEntry[] | undefined;
	setLore?: SetStoreFunction<LoreEntry[]> | undefined;
	chatFolder?: string | undefined;
	chatId?: string | undefined;
	/** Where the shell and file tools do their work. */
	backend: Backend;
	model?: string | undefined;
	provider?: Provider | undefined;
	/** Key for per-session shell state on the backend (previous output, cancellation). */
	shellSession?: string | undefined;
	/** Tool selection. When undefined, all tools run; otherwise only `true` entries run. */
	enabledTools?: Record<string, boolean> | undefined;
	/** Runs a spawn_agent call. Absent when the tool is unavailable (web build, or in a sub-agent). */
	spawnAgent?: ((args: any, callId?: string, parentChat?: ChatSnapshot) => Promise<string>) | undefined;
	requestPermission?: ((toolCall: ToolCall) => Promise<true | string>) | undefined;
	/** Withdraws a pending permission prompt by call id, resolving it as denied. */
	dismissPermission?: ((id: string) => void) | undefined;
	/** Aborted when the call's result is no longer needed (the run_js run that made it has ended). Tools that can stop early should stop on it. */
	signal?: AbortSignal | undefined;
	/** Snapshot id of the last run_js run in the visible history; read when the run leaves the queue and starts. */
	latestJsState?: (() => string | undefined) | undefined;
	/** The chat up to this turn, for run_js's `chat()`. */
	chatMessages?: (() => ChatSnapshot) | undefined;
	/** Widget instance ids used anywhere in the chat, every message version included (`show_widget`). */
	usedWidgetIds?: (() => Set<string>) | undefined;
	/** On a re-run, the data of the result being replaced. */
	previous?: ToolData | undefined;
	/** Folds a span of the chat (the `fold` tool). Absent when unavailable (sub-agents, compaction). */
	fold?: ((id: string, args: { from?: unknown; to?: unknown; note?: unknown }) => Fold | { error: string }) | undefined;
	/** A sub-agent's spawning chat, copied at spawn time, for `chat({ parent: true })`. */
	parentChat?: ChatSnapshot | undefined;
	/** Receives each finished (and streaming-partial) result as it arrives. */
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
	/** Tools that must be able to run for this one to be offered, e.g. run_js for `fold`, which needs `chat()` to find indices. */
	requires?: string[];
	/**
	 * Safe to execute again with edited arguments: no side effects, and `execute` needs
	 * nothing from the session beyond `ToolContext`. The user can then edit the call and re-run it.
	 */
	rerunnable?: boolean;
	execute: (call: ToolCall, ctx: ToolContext) => Promise<ToolData>;
	/** Backend-specific schema, e.g. naming the remote's shell. Default: `definition`. */
	describe?: (backend: Backend, model?: string, provider?: Provider) => Tool;
	/**
	 * Render the model-facing text from structured data. Must be pure and total:
	 * it runs on persisted data, possibly long after execution. Never called for
	 * `{ error }` data (handled centrally) or for stored `content` overrides.
	 */
	format: (data: ToolData) => string;
	/**
	 * Compact TS-like type of the `data` run_js snippets may rely on, beyond the
	 * `ok` every result carries. Treated as an API: list only stable fields.
	 */
	returns?: string;
	/** Chip body for the collapsed tool header. Default: tool name. */
	Summary?: Component<ToolRenderProps>;
	/** Calls this call made itself (run_js), shown as fainter chips below its own in the collapsed header. */
	nested?: (result?: ToolResult) => { call: ToolCall; result?: ToolResult | undefined }[];
	/** Expanded args view. Default: inline key/value pairs. */
	Args?: Component<ToolRenderProps>;
	/**
	 * Expanded result view, rendered from `result.data`. Like `format`, it is
	 * never called for `{ error }` data (rendered centrally as text) or for
	 * results carrying a `content` override — `LegacyResult` handles those.
	 */
	Result?: Component<{ data: ToolData }>;
	/** Always-visible view below the tool block, unaffected by collapse. Not called for `{ error }` data or `content` overrides. */
	Inline?: Component<{ data: ToolData }>;
	/** View for stored text: user edits and results from before structured data existed. */
	LegacyResult?: Component<{ content: string }>;
	/** Failure detection for chip styling when `data.ok` is absent (legacy results, malformed args). */
	failed?: (call: ToolCall, result?: ToolResult) => boolean;
}
