import type { UsageData } from './streaming';
import type { FileContentData } from './fileContent';
import { isTauri } from './platform';

export type cacheType = 'none' | 'smart';
export type cacheLength = '5m' | '1h';
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type ToolApprove = 'off' | 'chat' | 'always';
export type BuiltinProvider = "zai" | "or" | "nano" | "anth_local" | "fireworks" | "neuralwatt";
export type Provider = string;

export interface Prompt {
	name: string;
	content: string;
	role: Role;
	position: number;
	enabled: boolean;
	modelTrigger?: string;
}

export interface Config {
	name: string;
	prompts: Prompt[];
	modelSamplers?: { trigger: string; options: Partial<Options> }[];
	// Per-config reasoning and tools
	reasoning?: Options['reasoning'];
	preserveReasoning?: Options['preserve_reasoning'];
	reasoningPrefill?: { enabled: boolean; content: string };
	tools?: Record<string, boolean>;
}

export interface ChatMeta {
	// NOTE: macros could destroy info if they reference values from a different context,
	// but these tend to be few so we include them. Revisit if this becomes an issue.
	macros: Record<string, string>;
	configName: string;
	cut: number;
	theme: string;
	tools: Record<string, boolean>;
	model: string;
	provider: Provider;
	sendMode?: 'loop' | 'single';
	loreId?: string;
	chatFolder?: string;
	toolApprove?: ToolApprove;
	toolApproveOutside?: ToolApprove;
}

export interface FileAttachment {
	id: string;
	path: string;
	/** Body length, for the input's token estimate — bodies aren't loaded to count them. */
	chars: number;
	truncated?: boolean | undefined;
	/** Present only on request/export copies; persisted bodies live in the attachment store. */
	data?: FileContentData | undefined;
}

export interface ChatMessage {
	role: Role;
	content: string[];
	thinking?: string[] | undefined;
	thinking_signature?: string[] | undefined;
	temporary?: boolean | undefined;
	currentVersionIndex: number;
	tool_call_id?: string[] | undefined;
	ids?: string[] | undefined;
	/** Per version: image attachment ids (see attachments.ts) or literal data:/http urls */
	images?: string[][] | undefined;
	/** Per version: immutable text-file snapshots stored outside the message row. */
	files?: FileAttachment[][] | undefined;
	tool_calls?: ToolCall[][] | undefined;
	tool_results?: ToolResult[][] | undefined;
	models?: string[] | undefined; // Model used for this message, if applicable
	providers?: string[] | undefined; // Provider key used for this message, if applicable
	usage?: UsageData[] | undefined; // Usage data for each version
	timing?: MessageTiming[] | undefined; // Timing data for each version
	_dbId?: number | undefined; // SQLite row id (Tauri only, stable across edits)
}

export interface MessageTiming {
	time_to_first_token?: number | undefined; // Time to first token in milliseconds
	tokens_per_second?: number | undefined; // Tokens per second
	reasoning_time?: number | undefined; // Time spent reasoning in milliseconds
	message_time?: number | undefined; // Time spent on regular tokens in milliseconds
	createdAt?: number | undefined; // Unix ms timestamp when this version was created
	editedAt?: number | undefined; // Unix ms timestamp when this version was last manually edited
}

export interface ProviderConfig {
	url: string;
	apiKey: string;
	enabled: boolean;
	name?: string; // Display name (used for custom providers)
}

export interface ExtraBodyRule {
	providerPattern: string;
	modelPattern: string;
	body: string;
}

export interface Options {
	stream?: boolean;
	temperature?: number | string;
	top_k?: number;
	top_p?: number | string;
	min_p?: number;
	repetition_penalty?: number | string;
	usage?: { include: boolean };
	reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
	preserve_reasoning?: 'off' | 'interleaved' | 'full';
	random_seed?: boolean;
	/** Arbitrary JSON bodies (per rule) deep-merged into the request body when provider/model patterns match. */
	extra_body?: ExtraBodyRule[];
}

export type Message =
	| {
		role: Role;
		content: string | ContentPart[];
		name?: string;
		thinking?: string;
		thinking_signature?: string;
	} | {
		role: 'tool';
		content: string | ContentPart[];
		tool_call_id: string;
		name?: string;
	};

export type ContentPart = TextContent | ImageContentPart;
type TextContent = {
	type: 'text';
	text: string;
};
type ImageContentPart = {
	type: 'image_url';
	image_url: {
		url: string;
		detail?: string;
	};
};

export type FunctionDescription = {
	description?: string;
	name: string;
	parameters: object; // JSON Schema object
};
export type Tool = {
	type: 'function';
	function: FunctionDescription;
};
export type ToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: {} };
	/** UI-only: real matched line per edit (edit_file), stamped after applying. Never sent to the API. */
	_matchedLines?: (number | undefined)[];
};
/**
 * A tool result. `data` is the source of truth: the text sent to the model is
 * produced from it by the tool's `format`. `content` is an override, set only
 * when the user edits a result or when loading chats written before `data`
 * existed; when present it wins. Exactly one is normally set — use
 * `resolveContent` rather than reading either directly.
 */
export interface ToolResult {
	tool_call_id: string;
	name: string;
	data?: ToolData | undefined;
	content?: string | undefined;
}
/**
 * Structured tool output. `error` short-circuits formatting; `ok: false` marks failure in the UI.
 * `images` is the shared convention for pictures the model should see — attachment refs, sent
 * alongside the result text.
 */
export type ToolData = { ok?: boolean; error?: string; images?: string[] } & Record<string, any>;

// ── Sub-agents (spawn_agent) ───────────────────────────────────────────

export interface AgentModelRef {
	model: string;
	provider: Provider;
	/** Optional system prompt when this tier is used (no preset). '' = inherit chat prompts. */
	prompt?: string;
}

export interface AgentPreset {
	name: string;
	/** Surfaced to the model in the spawn_agent tool description. */
	description: string;
	/** '' or 'self' = parent's model; 'lite'|'medium'|'ultra' = tier; anything else = explicit model id (uses `provider`). */
	model: string;
	provider?: Provider;
	/** System prompt for the agent. Empty = inherit the parent's prompt messages. */
	prompt: string;
	/** Tool selection. Undefined = inherit the parent's. */
	tools?: Record<string, boolean> | undefined;
	maxTurns?: number | undefined;
}

export interface AgentSettings {
	models: Record<'lite' | 'medium' | 'ultra', AgentModelRef>;
	presets: AgentPreset[];
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	models: {
		lite: { model: '', provider: 'or' },
		medium: { model: '', provider: 'or' },
		ultra: { model: '', provider: 'or' },
	},
	presets: [],
};

// ── Auto-titler ────────────────────────────────────────────────────────

export interface TitlerSettings {
	model: string;
	provider: Provider;
	/** System prompt sent to the titler model. */
	prompt: string;
	/** Auto-title once a chat reaches this many messages. 0 = manual only. */
	autoAfter: number;
}

export const DEFAULT_TITLER_PROMPT = 'You name conversations. Given a transcript, reply with a concise, specific title of 2-5 words. Reply with only the title: no quotes, no punctuation, no preamble.';

export const DEFAULT_TITLER_SETTINGS: TitlerSettings = {
	model: '',
	provider: 'or',
	prompt: DEFAULT_TITLER_PROMPT,
	autoAfter: 0,
};

export const DEFAULT_PROVIDERS: Record<Provider, ProviderConfig> = {
	zai: { url: "https://api.z.ai/api/coding/paas/v4/chat/completions", apiKey: '', enabled: true },
	nano: { url: "https://nano-gpt.com/api/v1/chat/completions", apiKey: '', enabled: true },
	or: { url: "https://openrouter.ai/api/v1/chat/completions", apiKey: '', enabled: true },
	anth_local: { url: (import.meta.env.DEV && !isTauri) ? "/anth-local/v1/chat/completions" : "http://localhost:8084/v1/chat/completions", apiKey: '', enabled: false },
	fireworks: { url: "https://api.fireworks.ai/inference/v1/chat/completions", apiKey: '', enabled: true },
	neuralwatt: { url: "https://api.neuralwatt.com/v1/chat/completions", apiKey: '', enabled: true }
};

export const providerNames: Record<BuiltinProvider, string> = {
	zai: 'Z.AI',
	nano: 'NanoGPT',
	or: 'OpenRouter',
	anth_local: 'Anthropic Local',
	fireworks: 'Fireworks',
	neuralwatt: 'Neuralwatt'
};
