/**
 * Prompt-cache health checker.
 *
 * Before each send, the built request is hashed and compared against the last
 * baseline for the chat: the longest matching prefix is what the provider's
 * cache should replay, so its share of the prompt becomes the expectation. After
 * the response, the API-reported cached share (cached_tokens / prompt_tokens) is
 * compared against that expected share — ratio-of-ratios, so estimator vs
 * tokenizer scale differences cancel out and estimates never meet API counts
 * directly.
 */

import { createSignal } from 'solid-js';
import { estTokensFromLength, estImageChars, dataUrlImageDims } from './tokens';
import type { UsageData } from './streaming';
import { isGpt56OrLater } from './types';
import type { Message, Provider, Tool, cacheLength } from './types';

// Verdict thresholds — actual cached share (API) over expected cached share (est).
export const GREEN_RATIO = 0.9;
export const AMBER_RATIO = 0.4;

const MAX_BASELINES = 50; // LRU cap across chats
const BASELINE_MAX_AGE = 24 * 3600e3; // caches don't outlive a day in practice
const HISTORY_SIZE = 10;
const MISS_NOTICE_AGE = 10 * 60e3;

const CLAUDE_RE = /claude|sonnet|opus|fable|mythos|haiku/i;
const EXPLICIT_CACHE_PROVIDERS: Provider[] = ['or', 'anth_local', 'nano'];

export type CacheVerdict = 'none' | 'hit' | 'partial' | 'miss' | 'unknown';

export interface CacheCheck {
	time: number;
	model: string;
	estPrompt: number;           // client-estimated total prompt tokens
	expected: number | null;     // est tokens expected from cache; null = no expectation
	expectReason: string | null; // why there is no/zero expectation ('TTL expired', ...)
	divergedAt: number | null;   // request messages still matching the baseline prefix
	cached: number | null;       // API-reported cached tokens; null = not reported
	promptTokens: number | null; // API-reported prompt tokens
	ratio: number | null;        // cached / expected
	verdict: CacheVerdict;
	missNotificationAllowed: boolean;
	ttlMs: number | null;        // explicit cache TTL (Claude only), for the UI countdown
}

interface Snapshot {
	hashes: number[];
	cumTokens: number[]; // cumulative estimated tokens, inclusive per message
	total: number;
	toolsHash: number; // tool definitions lead the prompt; a change there busts everything
}

interface Baseline extends Snapshot {
	time: number;
	ttlMs: number | null;
	model: string;
	provider: Provider;
	reasoningEffort?: string | undefined;
	lastCachedAt?: number | undefined;
}

interface Pending {
	baseline: Baseline;
	expected: number | null;
	expectReason: string | null;
	divergedAt: number | null;
	estTotal: number;
	model: string;
	time: number;
	ttlMs: number | null;
	missNotificationAllowed: boolean;
}

const baselines = new Map<string, Baseline>();
const pendings = new Map<string, Pending>();

const [checkHistory, setCheckHistory] = createSignal<Record<string, CacheCheck[]>>({});

export function latestCheck(chatId: string): CacheCheck | undefined {
	const list = checkHistory()[chatId];
	return list?.[list.length - 1];
}

export { checkHistory };

/** Text content and image urls of a request message. */
function contentParts(m: Message): { text: string; imageUrls: string[] } {
	if (typeof m.content === 'string') return { text: m.content, imageUrls: [] };
	let text = '';
	const imageUrls: string[] = [];
	for (const p of m.content) {
		if (p.type === 'text') text += p.text;
		else imageUrls.push(p.image_url.url);
	}
	return { text, imageUrls };
}

function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** FNV-1a over message content. Inline images use data-URL length to avoid
 *  hashing megabytes; external image URLs are hashed in full. */
function hashMessage(m: Message): number {
	let h = 0x811c9dc5;
	const mix = (s: string) => {
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
	};
	const { text, imageUrls } = contentParts(m);
	mix(m.role);
	mix(text);
	const any = m as any;
	for (const url of imageUrls) mix('\0' + (url.startsWith('data:') ? url.length : url));
	mix(`#${imageUrls.length}`);
	if (any.thinking) mix(any.thinking);
	if (any.name) mix(any.name);
	if (any.tool_calls) mix(JSON.stringify(any.tool_calls));
	if (any.tool_call_id) mix(any.tool_call_id);
	return h >>> 0;
}

/** Hash and weight the built request. Token estimates mirror the input counter
 *  (input.tsx), images included — request parts carry inlined data URLs, so image
 *  dimensions can be sniffed from their headers instead of guessed. */
export function snapshotRequest(msgs: Message[], model: string, toolDefs?: Tool[]): Snapshot {
	const hashes: number[] = [], cumTokens: number[] = [];
	// Tool definitions are a separate request-body field, sent ahead of the messages
	const toolsJson = toolDefs?.length ? JSON.stringify(toolDefs) : '';
	const toolsHash = toolsJson ? hashString(toolsJson) : 0;
	let chars = toolsJson.length;
	for (const m of msgs) {
		hashes.push(hashMessage(m));
		const { text, imageUrls } = contentParts(m);
		chars += text.length + 5; // +5 per-message overhead, mirrors input.tsx
		for (const url of imageUrls) chars += estImageChars(dataUrlImageDims(url), model);
		const any = m as any;
		if (any.tool_calls)
			for (const tc of any.tool_calls)
				chars += tc.function.name.length + (typeof tc.function.arguments === 'string' ? tc.function.arguments.length : JSON.stringify(tc.function.arguments).length);
		if (any.thinking) chars += any.thinking.length;
		cumTokens.push(estTokensFromLength(chars, model));
	}
	return { hashes, cumTokens, total: estTokensFromLength(chars, model), toolsHash };
}

function getBaseline(chatId: string): Baseline | undefined {
	const b = baselines.get(chatId);
	if (!b) return;
	if (Date.now() - b.time > BASELINE_MAX_AGE) {
		baselines.delete(chatId);
		return;
	}
	baselines.delete(chatId);
	baselines.set(chatId, b); // LRU touch
	return b;
}

function storeBaseline(chatId: string, b: Baseline) {
	baselines.delete(chatId);
	baselines.set(chatId, b);
	while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value!);
}

export interface PreSendContext {
	model: string;
	provider: Provider;
	cacheLength: cacheLength;
	cacheEnabled: boolean;
	/** The tool definitions sent with this request (see sentTools in tools). */
	tools?: Tool[];
	/** Reasoning config is part of the provider's cache lineage — an effort change
	 *  invalidates reuse even when the prompt bytes are identical. */
	reasoningEffort?: string | undefined;
}

/** Call with the fully built request, just before it's sent. */
export function preSendCheck(chatId: string, ctx: PreSendContext, msgs: Message[]): void {
	const snap = snapshotRequest(msgs, ctx.model, ctx.tools);
	const prev = getBaseline(chatId);

	let expected: number | null = null;
	let expectReason: string | null = null;
	let divergedAt: number | null = null;

	// GPT-5.6 has a documented 30-minute minimum lifetime; Claude's explicit
	// cache lifetime comes from the selected retention setting.
	const ttlMs = isGpt56OrLater(ctx.model)
		? 1800e3
		: CLAUDE_RE.test(ctx.model) && EXPLICIT_CACHE_PROVIDERS.includes(ctx.provider)
			? ctx.cacheLength === '1h' ? 3600e3 : 300e3
			: null;

	if (!prev) {
		expectReason = 'first tracked request';
	} else if (prev.model !== ctx.model || prev.provider !== ctx.provider) {
		expectReason = 'model or provider changed';
	} else if (prev.reasoningEffort !== ctx.reasoningEffort) {
		expected = 0;
		expectReason = 'reasoning effort changed';
		divergedAt = 0;
	} else if (prev.toolsHash !== snap.toolsHash) {
		expected = 0;
		expectReason = 'tool definitions changed';
		divergedAt = 0;
	} else {
		let common = 0;
		while (common < prev.hashes.length && common < snap.hashes.length && prev.hashes[common] === snap.hashes[common]) common++;
		divergedAt = common;
		if (prev.ttlMs !== null && Date.now() - prev.time > prev.ttlMs) {
			expected = 0;
			expectReason = 'cache TTL expired';
		} else {
			expected = common > 0 ? snap.cumTokens[common - 1] : 0;
			if (common === 0) expectReason = 'prefix changed from the first message';
		}
	}

	const time = Date.now();
	const sameModel = prev?.model === ctx.model && prev.provider === ctx.provider;
	const lastCachedAt = sameModel ? prev.lastCachedAt : undefined;
	const missNotificationAllowed = (ctx.cacheEnabled && ttlMs !== null) || lastCachedAt === undefined || time - lastCachedAt <= MISS_NOTICE_AGE;
	const baseline: Baseline = { ...snap, time, ttlMs, model: ctx.model, provider: ctx.provider, reasoningEffort: ctx.reasoningEffort, lastCachedAt };
	pendings.set(chatId, { baseline, expected, expectReason, divergedAt, estTotal: snap.total, model: ctx.model, time, ttlMs, missNotificationAllowed });
}

/** Call when the response (or failure) resolves. Returns the verdict for alerting. */
export function postResponseCheck(chatId: string, usage: UsageData | undefined, success = true): CacheCheck | undefined {
	const p = pendings.get(chatId);
	pendings.delete(chatId);
	if (!p) return;
	if (success) storeBaseline(chatId, p.baseline);
	if (!usage) return;

	const cached = typeof usage.cached_tokens === 'number' ? usage.cached_tokens : null;
	const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
	if (success && cached !== null && cached > 0) p.baseline.lastCachedAt = Date.now();

	let ratio: number | null = null;
	let verdict: CacheVerdict;
	if (cached === null) verdict = 'unknown';
	else if (p.expected === null) verdict = 'none';
	else if (p.expected === 0) verdict = cached > 0 ? 'hit' : 'none'; // anticipated rebuild
	else {
		// Ratio-of-ratios: client-estimated prefix share vs API-reported cached share.
		// Comparing fractions keeps estimator/tokenizer scale differences out of it.
		const expectedFrac = p.estTotal > 0 ? p.expected / p.estTotal : 0;
		const actualFrac = cached / (promptTokens || p.estTotal || 1);
		ratio = expectedFrac > 0 ? actualFrac / expectedFrac : null;
		verdict = ratio !== null && ratio >= GREEN_RATIO ? 'hit' : ratio !== null && ratio >= AMBER_RATIO ? 'partial' : 'miss';
	}

	const check: CacheCheck = {
		time: p.time,
		model: p.model,
		estPrompt: p.estTotal,
		expected: p.expected,
		expectReason: p.expectReason,
		divergedAt: p.divergedAt,
		cached,
		promptTokens,
		ratio,
		verdict,
		missNotificationAllowed: p.missNotificationAllowed,
		ttlMs: p.ttlMs,
	};
	setCheckHistory(h => {
		const next = { ...h, [chatId]: [...(h[chatId] ?? []), check].slice(-HISTORY_SIZE) };
		const keys = Object.keys(next);
		if (keys.length > MAX_BASELINES) {
			const oldestFirst = keys.sort((a, b) => (next[a]![next[a]!.length - 1]?.time ?? 0) - (next[b]![next[b]!.length - 1]?.time ?? 0));
			for (const k of oldestFirst.slice(0, keys.length - MAX_BASELINES)) delete next[k];
		}
		return next;
	});
	return check;
}

/** Test introspection. */
export const _internal = { baselines, pendings, BASELINE_MAX_AGE, HISTORY_SIZE };
