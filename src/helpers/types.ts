import type { UsageData } from './streaming';
import type { FileContentData } from './fileContent';
import { isTauri } from './platform';

export type cacheType = 'none' | 'smart';
export type cacheLength = '5m' | '1h';
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type ToolApprove = 'off' | 'chat' | 'always';
export type BuiltinProvider = "zai" | "or" | "nano" | "anth_local" | "fireworks" | "neuralwatt";
export type Provider = string;
/** Which OpenAI-compatible protocol a provider speaks. Absent = chat completions. */
export type ApiType = 'completions' | 'responses';

export function isGpt56OrLater(model: string): boolean {
	const match = model.match(/(?:^|[/:])gpt-(\d+)(?:\.(\d+))?/i);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	return major > 5 || (major === 5 && minor >= 6);
}

export interface Prompt {
	name: string;
	content: string;
	role: Role;
	position: number;
	enabled: boolean;
	modelTrigger?: string;
}

/** How much prior reasoning is sent back; see buildRequestMessages. */
export type PreserveReasoning = 'off' | 'interleaved' | 'clipped' | 'full';

export interface Config {
	name: string;
	prompts: Prompt[];
	modelSamplers?: { trigger: string; options: Partial<Options> }[];
	// Per-config reasoning and tools
	reasoning?: Options['reasoning'];
	preserveReasoning?: PreserveReasoning;
	reasoningPrefill?: { enabled: boolean; content: string };
	tools?: Record<string, boolean>;
	/** Named spawn_agent configurations available to chats using this config. */
	agentPresets?: AgentPreset[];
	toolMode?: ToolMode;
	/** Legacy: `false` meant native tool calls; read by `toolModeOf` when `toolMode` is unset. */
	nestTools?: boolean;
}

/**
 * How tools are offered to the model (see `sentTools`): each as its own tool,
 * wrapped in the single `run` tool, or only through run_js.
 */
export type ToolMode = 'native' | 'run' | 'js';

export const toolModeOf = (config: Config | undefined): ToolMode =>
	config?.toolMode ?? (config?.nestTools === false ? 'native' : 'run');

export interface ChatMeta {
	// NOTE: macros could destroy info if they reference values from a different context,
	// but these tend to be few so we include them. Revisit if this becomes an issue.
	macros: Record<string, string>;
	configName: string;
	cut: number;
	theme: string;
	/** Legacy: the full tool selection, written by older versions. Migrated to `toolOverrides` on load. */
	tools?: Record<string, boolean>;
	/** Tools this chat sets differently from its config. */
	toolOverrides?: Record<string, boolean>;
	model: string;
	provider: Provider;
	sendMode?: 'loop' | 'single';
	/** Auto-compact context in loop mode. Folder-inherited; absent/false = off. */
	autoCompact?: boolean;
	loreId?: string;
	/** Project folder; also the `chat_folder` column. Meaningless across backends — cleared on switch. */
	chatFolder?: string;
	/** Folder on this machine whose images messages reference by name (see helpers/imageFolder.ts). */
	imageFolder?: string;
	toolApprove?: ToolApprove;
	toolApproveOutside?: ToolApprove;
	/** Per-chat backdrop shown behind the conversation. */
	background?: BackgroundSettings;
	/** Where tools run: absent/'local' = this machine, else an SshBackendConfig id. Own `backend` column. */
	backend?: string;
	/** Unsent input. Its attachment ids count as references when pruning. */
	draft?: ChatDraft;
}

export interface ChatDraft {
	text: string;
	images: string[];
	files: FileAttachment[];
	role: Role;
}

/** A tool call waiting for the user's approval. `chatName` is set for a sub-agent's. */
export interface PendingPermission {
	id: string;
	toolCall: any;
	resolve: (result: true | string) => void;
	outside?: boolean;
	chatName?: string | undefined;
}

export interface SshBackendConfig {
	/** Stable id ('ssh:<slug>') */
	id: string;
	label: string;
	/** [user@]host[:port]; host may be a ~/.ssh/config alias. */
	host: string;
	user?: string | undefined;
	port?: number | undefined;
	/** Explicit private key path; beats ssh-config IdentityFile and ~/.ssh/id_* defaults. */
	keyPath?: string | undefined;
	keyPassphrase?: string | undefined;
	password?: string | undefined;
}

export interface BackgroundSettings {
	/** Attachment id (helpers/attachments.ts) holding the original-quality image. */
	image: string;
	/** Original file name, for display. */
	name?: string;
	/** How much of the theme background color is overlaid, 0-1. */
	dim: number;
	/** Blur radius in px. */
	blur: number;
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
	/** Per version: Responses API reasoning items (item id + opaque blob) for rehydration. */
	reasoning_enc?: ReasoningEnc[][] | undefined;
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
	estimated_tokens?: number | undefined; // Output tokens estimated from the streamed text, for providers that report none
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
	apiType?: ApiType; // Request/streaming format; builtins are chat completions
}

export interface ExtraBodyRule {
	providerPattern: string;
	modelPattern: string;
	body: string;
}

/**
 * Patterns are case-insensitive regexes. The provider pattern is tested against both the
 * provider key (`or`) and its display name (`OpenRouter`), the model pattern against the
 * raw model id. Empty patterns match. Throws on invalid regex.
 */
export function extraBodyRuleMatches(rule: ExtraBodyRule, provider: Provider, providerLabel: string, model: string): boolean {
	const providerPat = rule.providerPattern?.trim() ?? '';
	if (providerPat) {
		let re: RegExp;
		try { re = new RegExp(providerPat, 'i'); } catch (e: any) { throw new Error(`Invalid provider pattern in extra body args: ${e.message}`); }
		if (!re.test(provider) && !re.test(providerLabel)) return false;
	}
	const modelPat = rule.modelPattern?.trim() ?? '';
	if (modelPat) {
		let re: RegExp;
		try { re = new RegExp(modelPat, 'i'); } catch (e: any) { throw new Error(`Invalid model pattern in extra body args: ${e.message}`); }
		if (!re.test(model)) return false;
	}
	return true;
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
	preserve_reasoning?: PreserveReasoning;
	random_seed?: boolean;
	/** Arbitrary JSON bodies (per rule) deep-merged into the request body when provider/model patterns match. See extraBodyRuleMatches. */
	extra_body?: ExtraBodyRule[];
}

export type Message =
	| {
		role: Role;
		content: string | ContentPart[];
		name?: string;
		thinking?: string;
		thinking_signature?: string;
		reasoning_enc?: ReasoningEnc[] | undefined;
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

/** A Responses API reasoning item's opaque round-trip blob (encrypted_content + item id + summary parts). */
export interface ReasoningEnc {
	id?: string;
	encrypted_content: string;
	/** The item's own summary parts, round-tripped verbatim (one summary_text part per entry). */
	summary?: string[] | undefined;
}

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
	/** Arguments as parsed. Malformed `run` items keep the raw item, which may not be an object. */
	function: { name: string; arguments: {} };
	/** UI-only: real matched line per edit (edit_file), stamped after applying. Never sent to the API. */
	_matchedLines?: (number | undefined)[];
	/** Id of the `run` call this call was expanded from; requests re-nest by it. */
	parent?: string | undefined;
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

/**
 * Per-tier / per-preset settings layered over the spawning chat's config.
 * Undefined fields inherit from the chat (or from the referenced tier, for presets).
 */
export interface AgentOverrides {
	/** Single system prompt. Empty = inherit the chat's prompt messages. */
	prompt?: string | undefined;
	reasoning?: Options['reasoning'] | undefined;
	preserveReasoning?: PreserveReasoning | undefined;
	reasoningPrefill?: { enabled: boolean; content: string } | undefined;
	/** Sampler overrides (temperature, top_p, top_k, min_p, repetition_penalty). Unset fields inherit. */
	samplers?: Partial<Options> | undefined;
	/** Undefined = the chat's. */
	toolMode?: ToolMode | undefined;
}

export interface AgentModelRef extends AgentOverrides {
	model: string;
	provider: Provider;
	/** Tool selection. Undefined = inherit the chat's. */
	tools?: Record<string, boolean> | undefined;
	maxTurns?: number | undefined;
}

export interface AgentPreset extends AgentOverrides {
	name: string;
	/** Surfaced to the model in the spawn_agent tool description. */
	description: string;
	/** '' or 'self' = parent's model; 'lite'|'medium'|'ultra' = tier; anything else = explicit model id (uses `provider`). */
	model: string;
	provider?: Provider;
	/** Tool selection. Undefined = inherit the parent's. */
	tools?: Record<string, boolean> | undefined;
	maxTurns?: number | undefined;
}

/** Prompt for agents on the parent's own model (`self`), unless a preset sets its own. */
export interface AgentSelfSettings {
	inheritPrompt: boolean;
	prompt: string;
}

export interface AgentSettings {
	models: Record<'lite' | 'medium' | 'ultra', AgentModelRef>;
	/** Absent in settings saved before this existed: treated as inheriting the chat's prompts. */
	self?: AgentSelfSettings;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
	models: {
		lite: { model: '', provider: 'or' },
		medium: { model: '', provider: 'or' },
		ultra: { model: '', provider: 'or' },
	},
	self: { inheritPrompt: true, prompt: '' },
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

export const themeNames: Record<string, string> = {
	fantasy: 'Fantasy',
	scifi: 'Sci-Fi',
	modern: 'Modern'
};

/** Themes that no longer exist (or were never set) fall back to the default. */
export const normalizeTheme = (theme: string | undefined) => theme && theme in themeNames ? theme : 'modern';

export const providerNames: Record<BuiltinProvider, string> = {
	zai: 'Z.AI',
	nano: 'NanoGPT',
	or: 'OpenRouter',
	anth_local: 'Anthropic Local',
	fireworks: 'Fireworks',
	neuralwatt: 'Neuralwatt'
};
