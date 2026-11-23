/**
 * Prompt-cache health checker.
 *
 * Before each send, the built request is hashed and compared with the chat's earlier
 * request(s) for that model (the baselines). The provider should serve the longest
 * matching prefix from cache, so that prefix's share of the estimated prompt is the
 * expected cached share. After the response, the API-reported share (cached_tokens /
 * prompt_tokens) is divided by the expected share. Comparing two fractions means
 * our estimate and the provider's tokenizer never have to agree on absolute counts.
 *
 * Whether a provider's cache key includes the reasoning config is not something we can
 * know, so a request that changes it is measured against both candidate baselines and
 * keeps only what both hypotheses guarantee; see preSendCheck.
 */

import { createSignal } from 'solid-js';
import { estTokensFromLength, estImageChars, dataUrlImageDims } from './tokens';
import type { UsageData } from './streaming';
import { isGpt56OrLater } from './types';
import type { Message, Provider, Tool, cacheLength } from './types';

// Verdict thresholds for the API-reported cached share divided by the expected share.
export const GREEN_RATIO = 0.9;
export const AMBER_RATIO = 0.4;

const MAX_BASELINES = 50; // LRU cap across chats
const MAX_MODELS_PER_CHAT = 6; // switching models keeps the previous ones' baselines
const MAX_EFFORTS_PER_MODEL = 3; // effort names (minimal/low/medium/high) beyond these add little
const BASELINE_MAX_AGE = 24 * 3600e3; // provider caches expire within a day in practice
const HISTORY_SIZE = 10;
const MISS_NOTICE_AGE = 10 * 60e3;
// Providers cache in blocks (128 to 1024 tokens), so the cached count usually trails
// the expected one by up to a block on short prompts. Only larger shortfalls notify.
export const NOTICE_MIN_SHORTFALL = 1000;

const CLAUDE_RE = /claude|sonnet|opus|fable|mythos|haiku/i;
const EXPLICIT_CACHE_PROVIDERS: Provider[] = ['or', 'anth_local', 'nano'];

export type CacheVerdict = 'none' | 'hit' | 'partial' | 'miss' | 'unknown';

export interface CacheCheck {
	time: number;
	model: string;
	estPrompt: number;           // client-estimated total prompt tokens
	expected: number | null;     // est tokens expected from cache; null if there is no comparable baseline
	expectReason: string | null; // why nothing or zero is expected ('cache TTL expired', ...)
	divergedAt: number | null;   // number of leading request messages that match the baseline
	cached: number | null;       // API-reported cached tokens; null if not reported
	promptTokens: number | null; // API-reported prompt tokens
	ratio: number | null;        // cached / expected
	verdict: CacheVerdict;
	missNotificationAllowed: boolean;
	/** The previous request for this model used a different reasoning effort, so the
	 *  expected share is uncertain and a miss is not worth a notice. */
	effortChanged: boolean;
	ttlMs: number | null;        // explicit cache TTL (Claude only), for the UI countdown
}

interface Snapshot {
	hashes: number[];
	cumTokens: number[]; // cumulative estimated tokens, inclusive per message
	total: number;
	toolsHash: number; // tool definitions precede the messages; changing them invalidates the whole cache
}

interface Baseline extends Snapshot {
	requestId: number; // monotonic per process; tells which send produced this snapshot
	time: number;
	ttlMs: number | null;
	model: string;
	provider: Provider;
	reasoningEffort?: string | undefined;
	lastCachedAt?: number | undefined;
}

interface Pending {
	chatId: string;
	baseline: Baseline;
	expected: number | null;
	expectReason: string | null;
	divergedAt: number | null;
	estTotal: number;
	model: string;
	time: number;
	ttlMs: number | null;
	missNotificationAllowed: boolean;
	effortChanged: boolean;
}

// chatId -> `${provider}\0${model}` -> reasoning effort -> that shape's last successful request.
// Keying by effort keeps a baseline for every effort the chat has used; the model's
// most recent baseline (any effort) is the last entry, see mostRecent.
const baselines = new Map<string, Map<string, Map<string, Baseline>>>();
// request id -> the check waiting for that request's response. Ids are per request, not
// per chat, so overlapping sends in one chat each keep their own.
const pendings = new Map<number, Pending>();
let nextRequestId = 1;

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

/** Hashes each message of the built request and estimates cumulative token counts.
 *  Estimates match the input counter (input.tsx), images included. Request parts
 *  contain inlined data URLs, so image dimensions are read from their headers. */
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

const modelKey = (provider: Provider, model: string) => `${provider}\0${model}`;
const effortKey = (effort: string | undefined) => effort ?? '';

/** The chat's baselines for one model, by reasoning effort; undefined when there are
 *  none left after dropping the stale ones. */
function modelBaselines(chatId: string, provider: Provider, model: string): Map<string, Baseline> | undefined {
	const perChat = baselines.get(chatId);
	const key = modelKey(provider, model);
	const byEffort = perChat?.get(key);
	if (!perChat || !byEffort) return;
	const now = Date.now();
	for (const [effort, b] of byEffort)
		if (now - b.time > BASELINE_MAX_AGE) byEffort.delete(effort);
	if (byEffort.size > 0) return byEffort;
	perChat.delete(key);
	if (perChat.size === 0) baselines.delete(chatId);
}

/** The baseline this model stored most recently, whatever effort it used (baselines are
 *  reinserted on store, so this is the previous request for the model). */
function mostRecent(byEffort: Map<string, Baseline>): Baseline | undefined {
	return [...byEffort.values()].pop();
}

/** The chat's baseline for one model and reasoning effort. */
function getBaseline(chatId: string, provider: Provider, model: string, effort?: string): Baseline | undefined {
	return modelBaselines(chatId, provider, model)?.get(effortKey(effort));
}

function storeBaseline(chatId: string, b: Baseline) {
	let perChat = baselines.get(chatId);
	if (!perChat) {
		perChat = new Map();
		baselines.set(chatId, perChat);
	}
	const key = modelKey(b.provider, b.model);
	let byEffort = perChat.get(key);
	if (!byEffort) {
		byEffort = new Map();
		perChat.set(key, byEffort);
	}
	const effort = effortKey(b.reasoningEffort);
	const existing = byEffort.get(effort);
	// An older request that finishes after a newer one must not replace its baseline
	if (existing) {
		if (existing.requestId > b.requestId) return;
		if (existing.lastCachedAt !== undefined && (b.lastCachedAt === undefined || existing.lastCachedAt > b.lastCachedAt))
			b.lastCachedAt = existing.lastCachedAt;
	}
	byEffort.delete(effort);
	byEffort.set(effort, b);
	while (byEffort.size > MAX_EFFORTS_PER_MODEL) byEffort.delete(byEffort.keys().next().value!);
	perChat.delete(key);
	perChat.set(key, byEffort);
	while (perChat.size > MAX_MODELS_PER_CHAT) perChat.delete(perChat.keys().next().value!);
	baselines.delete(chatId);
	baselines.set(chatId, perChat); // LRU touch
	while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value!);
}

interface Expectation {
	expected: number;
	expectReason: string | null;
	divergedAt: number;
}

/** What the provider should serve from cache if this baseline's request is the one it
 *  still holds for this prompt: the shared prefix share, unless a request-shape change
 *  (tools, TTL) rules out reuse entirely. */
function expectationFrom(prev: Baseline, snap: Snapshot): Expectation {
	if (prev.toolsHash !== snap.toolsHash) return { expected: 0, expectReason: 'tool definitions changed', divergedAt: 0 };
	let common = 0;
	while (common < prev.hashes.length && common < snap.hashes.length && prev.hashes[common] === snap.hashes[common]) common++;
	if (prev.ttlMs !== null && Date.now() - prev.time > prev.ttlMs)
		return { expected: 0, expectReason: 'cache TTL expired', divergedAt: common };
	return { expected: common > 0 ? snap.cumTokens[common - 1]! : 0, expectReason: common === 0 ? 'prefix changed from the first message' : null, divergedAt: common };
}

export interface PreSendContext {
	model: string;
	provider: Provider;
	cacheLength: cacheLength;
	cacheEnabled: boolean;
	/** The tool definitions sent with this request (see sentTools in tools). */
	tools?: Tool[];
	/** Changing it may rule out cache reuse, depending on whether the provider's cache
	 *  key includes the reasoning config; see preSendCheck. */
	reasoningEffort?: string | undefined;
}

/** Call with the fully built request, just before it's sent. Returns the id to pass to
 *  postResponseCheck once it resolves. */
export function preSendCheck(chatId: string, ctx: PreSendContext, msgs: Message[]): number {
	const snap = snapshotRequest(msgs, ctx.model, ctx.tools);
	const byEffort = modelBaselines(chatId, ctx.provider, ctx.model);
	const sameEffort = byEffort?.get(effortKey(ctx.reasoningEffort));
	const latest = byEffort && mostRecent(byEffort);
	const effortChanged = latest !== undefined && effortKey(latest.reasoningEffort) !== effortKey(ctx.reasoningEffort);

	// GPT-5.6 has a documented 30-minute minimum lifetime; Claude's explicit
	// cache lifetime comes from the selected retention setting.
	const ttlMs = isGpt56OrLater(ctx.model)
		? 1800e3
		: CLAUDE_RE.test(ctx.model) && EXPLICIT_CACHE_PROVIDERS.includes(ctx.provider)
			? ctx.cacheLength === '1h' ? 3600e3 : 300e3
			: null;

	// The same-effort baseline and the model's previous request are two hypotheses about
	// what the provider still holds: its cache key may or may not include the reasoning
	// config. Expect only what both guarantee, so neither hypothesis produces a false miss.
	const candidates = [sameEffort, latest === sameEffort ? undefined : latest];
	let best: Expectation | undefined;
	for (const b of candidates) {
		if (!b) continue;
		const e = expectationFrom(b, snap);
		if (!best || e.expected < best.expected) best = e;
	}

	// A reasoning effort the chat never sent under: one hypothesis says nothing can come
	// back from cache, the other says the previous request's baseline covers this prompt.
	// Expect nothing, and let a served cache show up as a hit.
	const freshEffort = effortChanged && !sameEffort;
	const expected = freshEffort ? 0 : best?.expected ?? null;
	const expectReason = freshEffort
		? 'reasoning effort changed'
		: best
			? best.expectReason
			: baselines.has(chatId) ? 'no tracked request for this model' : 'first tracked request';
	const divergedAt = freshEffort ? 0 : best?.divergedAt ?? null;

	const time = Date.now();
	const lastCachedAt = latest?.lastCachedAt;
	const missNotificationAllowed = (ctx.cacheEnabled && ttlMs !== null) || lastCachedAt === undefined || time - lastCachedAt <= MISS_NOTICE_AGE;
	const requestId = nextRequestId++;
	const baseline: Baseline = { ...snap, requestId, time, ttlMs, model: ctx.model, provider: ctx.provider, reasoningEffort: ctx.reasoningEffort, lastCachedAt };
	pendings.set(requestId, { chatId, baseline, expected, expectReason, divergedAt, estTotal: snap.total, model: ctx.model, time, ttlMs, missNotificationAllowed, effortChanged });
	return requestId;
}

/** Call when that request's response (or failure) resolves. Returns the verdict for alerting. */
export function postResponseCheck(requestId: number, usage: UsageData | undefined, success = true): CacheCheck | undefined {
	const p = pendings.get(requestId);
	pendings.delete(requestId);
	if (!p) return;
	if (success) storeBaseline(p.chatId, p.baseline);
	if (!usage) return;

	const cached = typeof usage.cached_tokens === 'number' ? usage.cached_tokens : null;
	const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
	if (success && cached !== null && cached > 0) {
		// Stamp whichever baseline is live for this shape, so a hit is never rolled back
		const live = getBaseline(p.chatId, p.baseline.provider, p.baseline.model, p.baseline.reasoningEffort);
		(live ?? p.baseline).lastCachedAt = Date.now();
	}

	let ratio: number | null = null;
	let verdict: CacheVerdict;
	if (cached === null) verdict = 'unknown';
	else if (p.expected === null) verdict = 'none';
	else if (p.expected === 0) verdict = cached > 0 ? 'hit' : 'none'; // a cache rebuild was expected
	else {
		// API-reported cached share divided by the estimated prefix share. Comparing
		// fractions cancels the scale difference between our estimate and the tokenizer.
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
		missNotificationAllowed: p.missNotificationAllowed && !p.effortChanged,
		effortChanged: p.effortChanged,
		ttlMs: p.ttlMs,
	};
	setCheckHistory(h => {
		const next = { ...h, [p.chatId]: [...(h[p.chatId] ?? []), check].slice(-HISTORY_SIZE) };
		const keys = Object.keys(next);
		if (keys.length > MAX_BASELINES) {
			const oldestFirst = keys.sort((a, b) => (next[a]![next[a]!.length - 1]?.time ?? 0) - (next[b]![next[b]!.length - 1]?.time ?? 0));
			for (const k of oldestFirst.slice(0, keys.length - MAX_BASELINES)) delete next[k];
		}
		return next;
	});
	return check;
}

/** The expectation in API-token space, which is where cached_tokens is reported. */
export function expectedCachedTokens(check: CacheCheck): number | null {
	if (check.expected === null || check.estPrompt <= 0) return null;
	return check.expected / check.estPrompt * (check.promptTokens || check.estPrompt);
}

/** A miss earns a notice only when the shortfall is bigger than provider cache block
 *  rounding. Short prompts trail their expectation by a block without anything
 *  actually being wrong. */
export function shouldNotifyMiss(check: CacheCheck): boolean {
	if (check.verdict !== 'miss' || !check.missNotificationAllowed || check.cached === null) return false;
	const expected = expectedCachedTokens(check);
	return expected !== null && expected - check.cached >= NOTICE_MIN_SHORTFALL;
}

/** Test introspection. */
export const _internal = { baselines, pendings, getBaseline, BASELINE_MAX_AGE, MAX_MODELS_PER_CHAT, MAX_EFFORTS_PER_MODEL, HISTORY_SIZE };
