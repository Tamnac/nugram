import type { ChatMessage, ChatMeta, MessageTiming, ToolCall, ToolResult } from './types';
import type { UsageData } from './streaming';

export interface ScopedStats {
	totalCost: number;
	pricedRequests: number;
	tokenRequests: number;
	promptTokens: number;
	messageTokens: number;
	reasoningTokens: number;
}

export interface ChatStats {
	/** Totals across every version of every message */
	all: ScopedStats;
	/** Totals for only the currently-active version of each message */
	current: ScopedStats;
	totalRequests: number;
	totalMessages: number;
	totalVersions: number;
	models: string[];
}

function emptyScope(): ScopedStats {
	return { totalCost: 0, pricedRequests: 0, tokenRequests: 0, promptTokens: 0, messageTokens: 0, reasoningTokens: 0 };
}

function addUsage(scope: ScopedStats, usage: UsageData) {
	const p = usage.prompt_tokens || 0;
	const m = usage.message_tokens || 0;
	const r = usage.reasoning_tokens || 0;
	scope.promptTokens += p;
	scope.messageTokens += m;
	scope.reasoningTokens += r;
	if (p + m + r > 0) scope.tokenRequests++;
	const cost = (usage.prompt_cost || 0) + (usage.message_cost || 0);
	scope.totalCost += cost;
	if (cost > 0) scope.pricedRequests++;
}

export function computeChatStats(messages: ChatMessage[]): ChatStats {
	const all = emptyScope();
	const current = emptyScope();
	let totalRequests = 0;
	let totalMessages = 0;
	let totalVersions = 0;
	const modelSet = new Set<string>();

	for (const msg of messages) {
		const versions = getMessageVersionCount(msg);
		totalMessages++;
		totalVersions += versions;

		if (msg.role === 'assistant') {
			totalRequests++;
			const vi = msg.currentVersionIndex || 0;
			if (msg.usage) {
				for (let i = 0; i < msg.usage.length; i++) {
					const usage = msg.usage[i];
					if (!usage) continue;
					addUsage(all, usage);
					if (i === vi) addUsage(current, usage);
				}
			}
		}

		if (msg.models) {
			for (const m of msg.models) if (m) modelSet.add(m);
		}
	}

	return {
		all,
		current,
		totalRequests,
		totalMessages,
		totalVersions,
		models: Array.from(modelSet).sort(),
	};
}

export function getMessageContent(message: ChatMessage): string {
	const index = message.currentVersionIndex || 0;
	return message.content[index] || '';
}

export function getMessageThinking(message: ChatMessage): string | undefined {
	if (!message.thinking) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.thinking[index]?.trimStart();
}

export function getMessageThinkingSignature(message: ChatMessage): string | undefined {
	if (!message.thinking_signature) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.thinking_signature[index];
}

export function getMessageToolCalls(message: ChatMessage): ToolCall[] | undefined {
	if (!message.tool_calls) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.tool_calls[index];
}

export function getMessageToolResults(message: ChatMessage): ToolResult[] | undefined {
	if (!message.tool_results) return undefined;
	const index = message.currentVersionIndex || 0;
	return message.tool_results[index];
}

export function getMessageVersionCount(message: ChatMessage): number {
	return message.content.length;
}

export function insertAtIndex<T>(arr: T[] | undefined, index: number, value: T, defaultValue: T): T[] {
	const result: T[] = new Array(index + 1);
	for (let i = 0; i < index; i++)
		result[i] = arr?.[i] ?? defaultValue;
	result[index] = value;
	return result;
}

export function addMessageVersion(
	message: ChatMessage,
	updates: {
		content: string;
		thinking?: string;
		model?: string;
		provider?: string;
		id?: string;
		tool_call_id?: string;
		tool_calls?: ToolCall[];
		timing?: MessageTiming;
		usage?: UsageData;
	}
): ChatMessage {
	const idx = message.content.length;

	return {
		...message,
		content: [...message.content, updates.content],
		thinking: updates.thinking !== undefined ? insertAtIndex(message.thinking, idx, updates.thinking, '') : message.thinking,
		ids: updates.id !== undefined ? insertAtIndex(message.ids, idx, updates.id, '') : message.ids,
		models: updates.model !== undefined ? insertAtIndex(message.models, idx, updates.model.replace(/^accounts\/fireworks\/\w+\//, ''), '') : message.models,
		providers: updates.provider !== undefined ? insertAtIndex(message.providers, idx, updates.provider, '') : message.providers,
		tool_call_id: updates.tool_call_id !== undefined ? insertAtIndex(message.tool_call_id, idx, updates.tool_call_id, '') : message.tool_call_id,
		tool_calls: updates.tool_calls !== undefined ? insertAtIndex(message.tool_calls, idx, updates.tool_calls, []) : message.tool_calls,
		timing: insertAtIndex(message.timing, idx, { ...updates.timing, createdAt: Date.now() }, {}),
		usage: updates.usage !== undefined ? insertAtIndex(message.usage, idx, updates.usage, { prompt_tokens: 0, message_tokens: 0, reasoning_tokens: 0, prompt_cost: 0, message_cost: 0 }) : message.usage,
		currentVersionIndex: idx,
	};
}

/** Backfill missing tool results for orphaned tool calls (e.g. app closed during pending permission) */
export function repairOrphanedToolCalls(msgs: ChatMessage[]): boolean {
	let repaired = false;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const msg = msgs[i];
		if (!msg.tool_calls) continue;
		for (let v = 0; v < msg.tool_calls.length; v++) {
			const calls = msg.tool_calls[v];
			if (!calls?.length) continue;
			const results = msg.tool_results?.[v] || [];
			const resultIds = new Set(results.map(r => r.tool_call_id));
			const missing = calls.filter(tc => !resultIds.has(tc.id));
			if (missing.length > 0) {
				const patch: ToolResult[] = missing.map(tc => ({
					tool_call_id: tc.id,
					name: tc.function.name,
					content: 'Tool call failed: application closed unexpectedly'
				}));
				if (!msg.tool_results) msg.tool_results = [];
				while (msg.tool_results.length <= v) msg.tool_results.push([]);
				msg.tool_results[v] = [...results, ...patch];
				repaired = true;
			}
		}
	}
	return repaired;
}
