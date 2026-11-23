import { describe, test, expect, afterEach } from 'bun:test';
import { preSendCheck, postResponseCheck, latestCheck, checkHistory, shouldNotifyMiss, snapshotRequest, _internal } from '../src/helpers/cacheGuard';
import type { UsageData } from '../src/helpers/streaming';
import type { Message } from '../src/helpers/types';

const usage = (cached?: number, prompt = 1000): UsageData => ({
	prompt_tokens: prompt,
	message_tokens: 10,
	reasoning_tokens: 0,
	prompt_cost: 0,
	message_cost: 0,
	...(cached !== undefined ? { cached_tokens: cached } : {}),
});

const big = 'lorem ipsum '.repeat(500); // ~5.5k chars, well clear of rounding noise

const chat = (...contents: string[]): Message[] => contents.map(c => ({ role: 'user' as const, content: c }));

const orClaude = { model: 'claude-sonnet-4', provider: 'or' as const, cacheLength: '5m' as const, cacheEnabled: true };
const orGpt = { model: 'gpt-4o', provider: 'or' as const, cacheLength: '5m' as const, cacheEnabled: true };

let n = 0;
const chatId = () => `test-${++n}`;
// Request id of the last send. Tests answer one request at a time, so one slot reads
// like the old per-chat API; the overlapping-sends test keeps its ids apart explicitly.
let t = 0;

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

function advance(ms: number) {
	const now = Date.now();
	Date.now = () => now + ms;
}

describe('snapshotRequest', () => {
	test('identical requests hash identically; edits diverge', () => {
		const a = snapshotRequest(chat(big, big, big), 'gpt-4o');
		const b = snapshotRequest(chat(big, big, big), 'gpt-4o');
		const c = snapshotRequest(chat(big, big + 'x', big), 'gpt-4o');
		expect(a.hashes).toEqual(b.hashes);
		expect(a.hashes[0]).toBe(c.hashes[0]);
		expect(a.hashes[1]).not.toBe(c.hashes[1]);
		expect(a.total).toBeGreaterThan(1000);
	});
});

describe('preSendCheck / postResponseCheck', () => {
	test('first tracked request has no expectation', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		const check = postResponseCheck(t, usage(500))!;
		expect(check.expected).toBeNull();
		expect(check.expectReason).toBe('first tracked request');
		expect(check.verdict).toBe('none');
	});

	test('identical follow-up expects the full prompt back from cache', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage());

		t = preSendCheck(id, orGpt, chat(big, big, big)); // appended one message, prefix intact
		const snap = snapshotRequest(chat(big, big, big), 'gpt-4o');
		const check = postResponseCheck(t, usage())!;
		expect(check.expected).toBe(snap.cumTokens[1]);
		expect(check.divergedAt).toBe(2);
		expect(check.expectReason).toBeNull();
	});

	test('verdicts follow the cached/expected ratio', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage());

		// identical resend => expected share = 100%; use the estimate as the API
		// total so cached share equals the fraction of est we feed in
		const est = snapshotRequest(chat(big, big), orGpt.model).total;
		const round = (cachedFrac: number) => {
			t = preSendCheck(id, orGpt, chat(big, big));
			return postResponseCheck(t, usage(Math.round(est * cachedFrac), est))!;
		};

		expect(round(1).verdict).toBe('hit');
		expect(round(0.5).verdict).toBe('partial');
		expect(round(0.1).verdict).toBe('miss');
	});

	test('missing cached_tokens field is unknown, not a miss', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage());
		t = preSendCheck(id, orGpt, chat(big, big));
		expect(postResponseCheck(t, usage(undefined))!.verdict).toBe('unknown');
	});

	test('editing the first message clears the expected cache', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage());

		t = preSendCheck(id, orGpt, chat(big + 'edited', big));
		const check = postResponseCheck(t, usage(0))!;
		expect(check.expected).toBe(0);
		expect(check.expectReason).toBe('prefix changed from the first message');
		expect(check.divergedAt).toBe(0);
		expect(check.verdict).toBe('none'); // anticipated rebuild, not an alert
	});

	test('mid-history edit limits expectation to the shared prefix', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big, big, big));
		postResponseCheck(t, usage());

		t = preSendCheck(id, orGpt, chat(big, big, big + 'x', big));
		const check = postResponseCheck(t, usage())!;
		expect(check.divergedAt).toBe(2);
		expect(check.expected).toBe(snapshotRequest(chat(big, big, big), orGpt.model).cumTokens[1]);
	});

	test('another model has no baseline yet', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage());

		t = preSendCheck(id, { ...orGpt, model: 'deepseek-v3' }, chat(big, big));
		const check = postResponseCheck(t, usage())!;
		expect(check.expected).toBeNull();
		expect(check.expectReason).toBe('no tracked request for this model');
	});

	test('returning to a model reuses its earlier baseline', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage());

		const deepseek = { ...orGpt, model: 'deepseek-v3' };
		t = preSendCheck(id, deepseek, chat(big, big, big));
		postResponseCheck(t, usage());

		t = preSendCheck(id, orGpt, chat(big, big, big));
		const snap = snapshotRequest(chat(big, big, big), orGpt.model);
		const check = postResponseCheck(t, usage(snap.cumTokens[1]!, snap.total))!;
		expect(check.model).toBe(orGpt.model);
		expect(check.expected).toBe(snapshotRequest(chat(big, big), orGpt.model).cumTokens[1]);
		expect(check.divergedAt).toBe(2);
		expect(check.verdict).toBe('hit');
	});

	test('each chat keeps a bounded number of model baselines, newest first', () => {
		const id = chatId();
		const models = Array.from({ length: _internal.MAX_MODELS_PER_CHAT + 1 }, (_, i) => `model-${i}`);
		for (const model of models) {
			t = preSendCheck(id, { ...orGpt, model }, chat(big));
			postResponseCheck(t, usage());
		}
		const first = models[0]!;
		t = preSendCheck(id, { ...orGpt, model: first }, chat(big));
		expect(postResponseCheck(t, usage())!.expectReason).toBe('no tracked request for this model');
		const last = models[models.length - 1]!;
		t = preSendCheck(id, { ...orGpt, model: last }, chat(big));
		expect(postResponseCheck(t, usage())!.expected).toBeGreaterThan(0);
	});

	test('claude: cache TTL expiry clears expectation; other models ignore it', () => {
		const id = chatId();
		t = preSendCheck(id, orClaude, chat(big, big));
		postResponseCheck(t, usage());

		advance(6 * 60e3); // past the 5m TTL
		t = preSendCheck(id, orClaude, chat(big, big));
		const expired = postResponseCheck(t, usage(0))!;
		expect(expired.expected).toBe(0);
		expect(expired.expectReason).toBe('cache TTL expired');
		expect(expired.verdict).toBe('none');

		const id2 = chatId();
		t = preSendCheck(id2, orGpt, chat(big, big));
		postResponseCheck(t, usage());

		advance(6 * 60e3);
		t = preSendCheck(id2, orGpt, chat(big, big));
		const check = postResponseCheck(t, usage(0))!;
		expect(check.expected).toBeGreaterThan(0);
		expect(check.verdict).toBe('miss');
	});

	test('implicit cache misses stay visible but stop notifying 10 minutes after the last cached response', () => {
		const id = chatId();
		const msgs = chat(big, big);
		t = preSendCheck(id, orGpt, msgs);
		postResponseCheck(t, usage(500));

		advance(9 * 60e3);
		t = preSendCheck(id, orGpt, msgs);
		const recent = postResponseCheck(t, usage(0))!;
		expect(recent.verdict).toBe('miss');
		expect(recent.missNotificationAllowed).toBe(true);

		advance(2 * 60e3);
		t = preSendCheck(id, orGpt, msgs);
		const stale = postResponseCheck(t, usage(0))!;
		expect(stale.expected).toBeGreaterThan(0);
		expect(stale.verdict).toBe('miss');
		expect(stale.missNotificationAllowed).toBe(false);

		t = preSendCheck(id, orGpt, msgs);
		postResponseCheck(t, usage(500));
		t = preSendCheck(id, orGpt, msgs);
		expect(postResponseCheck(t, usage(0))!.missNotificationAllowed).toBe(true);
	});

	test('explicit cache lifetimes keep miss notifications beyond 10 minutes', () => {
		const id = chatId();
		const ctx = { ...orClaude, cacheLength: '1h' as const };
		t = preSendCheck(id, ctx, chat(big, big));
		postResponseCheck(t, usage(500));
		advance(11 * 60e3);
		t = preSendCheck(id, ctx, chat(big, big));
		const check = postResponseCheck(t, usage(0))!;
		expect(check.verdict).toBe('miss');
		expect(check.missNotificationAllowed).toBe(true);
	});

	test('GPT-5.6 explicit retention keeps miss notifications after 10 minutes', () => {
		const id = chatId();
		const ctx = { ...orGpt, model: 'gpt-5.6' };
		t = preSendCheck(id, ctx, chat(big, big));
		postResponseCheck(t, usage(500));
		advance(11 * 60e3);
		t = preSendCheck(id, ctx, chat(big, big));
		expect(postResponseCheck(t, usage(0))!.missNotificationAllowed).toBe(true);
	});

	test('disabled caching does not exempt a model with an explicit lifetime', () => {
		const id = chatId();
		const ctx = { ...orClaude, cacheLength: '1h' as const };
		t = preSendCheck(id, ctx, chat(big, big));
		postResponseCheck(t, usage(500));
		advance(11 * 60e3);
		t = preSendCheck(id, { ...ctx, cacheEnabled: false }, chat(big, big));
		expect(postResponseCheck(t, usage(0))!.missNotificationAllowed).toBe(false);
	});

	test('baselines are LRU-capped and pruned by age', () => {
		for (let i = 0; i < 60; i++) {
			const id = chatId();
			t = preSendCheck(id, orGpt, chat(big));
			postResponseCheck(t, usage());
		}
		expect(_internal.baselines.size).toBeLessThanOrEqual(50);

		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big));
		postResponseCheck(t, usage());
		advance(_internal.BASELINE_MAX_AGE + 1);
		t = preSendCheck(id, orGpt, chat(big));
		expect(postResponseCheck(t, usage())!.expectReason).toBe('first tracked request');
	});

	test('tool definitions are part of the snapshot', () => {
		const tool = { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } };
		const withTools = snapshotRequest(chat(big), 'gpt-4o', [tool]);
		const without = snapshotRequest(chat(big), 'gpt-4o');
		expect(withTools.total).toBeGreaterThan(without.total);
		expect(withTools.toolsHash).not.toBe(without.toolsHash);
		expect(withTools.toolsHash).not.toBe(0);
		expect(without.toolsHash).toBe(0);
	});

	test('tool definition change busts the whole expected cache', () => {
		const tool = { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } };
		const id = chatId();
		t = preSendCheck(id, { ...orGpt, tools: [tool] }, chat(big, big));
		postResponseCheck(t, usage());

		t = preSendCheck(id, { ...orGpt, tools: [{ ...tool, function: { ...tool.function, description: 'changed' } }] }, chat(big, big));
		const check = postResponseCheck(t, usage(0))!;
		expect(check.expected).toBe(0);
		expect(check.expectReason).toBe('tool definitions changed');
		expect(check.verdict).toBe('none');
	});

	test('a reasoning effort the chat never sent under expects no cache', () => {
		const id = chatId();
		t = preSendCheck(id, { ...orGpt, reasoningEffort: 'high' }, chat(big, big));
		postResponseCheck(t, usage());

		// Same prompt, new effort: the provider may or may not key its cache on the effort,
		// so nothing is expected and neither outcome is news.
		t = preSendCheck(id, { ...orGpt, reasoningEffort: 'low' }, chat(big, big));
		const check = postResponseCheck(t, usage(0))!;
		expect(check.expected).toBe(0);
		expect(check.expectReason).toBe('reasoning effort changed');
		expect(check.divergedAt).toBe(0);
		expect(check.effortChanged).toBe(true);
		expect(check.verdict).toBe('none');

		// ...and a cache served anyway reads as a hit
		t = preSendCheck(id, { ...orGpt, reasoningEffort: 'max' }, chat(big, big));
		expect(postResponseCheck(t, usage(900))!.verdict).toBe('hit');

		// the next request under that effort is measured as usual
		t = preSendCheck(id, { ...orGpt, reasoningEffort: 'max' }, chat(big, big, big));
		const next = postResponseCheck(t, usage())!;
		expect(next.effortChanged).toBe(false);
		expect(next.expected).toBe(snapshotRequest(chat(big, big, big), orGpt.model).cumTokens[1]);
	});

	test('toggling back to an effort keeps its baseline and expects the safe share', () => {
		const id = chatId();
		const high = { ...orGpt, reasoningEffort: 'high' };
		const low = { ...orGpt, reasoningEffort: 'low' };
		t = preSendCheck(id, high, chat(big, big));
		postResponseCheck(t, usage(0));
		t = preSendCheck(id, low, chat(big, big, big));
		postResponseCheck(t, usage(0));

		// High's own baseline covers 2 messages, the previous (low) request covers 3. Only
		// the shorter one holds under both cache-key hypotheses.
		t = preSendCheck(id, high, chat(big, big, big, big));
		const check = postResponseCheck(t, usage(0))!;
		expect(check.divergedAt).toBe(2);
		expect(check.expected).toBe(snapshotRequest(chat(big, big), orGpt.model).cumTokens[1]);
		expect(check.effortChanged).toBe(true);
		expect(shouldNotifyMiss(check)).toBe(false);

		// Once the effort has a current baseline again, misses are announced as before
		const msgs = chat(big, big, big, big, big);
		t = preSendCheck(id, high, msgs);
		const next = postResponseCheck(t, usage(0, snapshotRequest(msgs, orGpt.model).total))!;
		expect(next.effortChanged).toBe(false);
		expect(next.verdict).toBe('miss');
		expect(shouldNotifyMiss(next)).toBe(true);
	});

	test('a response without usage still consumes the pending check', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big));
		expect(postResponseCheck(t, undefined)).toBeUndefined();
		expect(_internal.pendings.has(t)).toBe(false);
	});

	test('overlapping sends keep their own pending checks', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage());

		// Two requests are in flight; the second one's response arrives first and must be
		// measured against its own prompt, not the other request's.
		t = preSendCheck(id, orGpt, chat(big, big, big));
		const second = preSendCheck(id, orGpt, chat(big, big, big, big));

		const secondCheck = postResponseCheck(second, usage())!;
		expect(secondCheck.estPrompt).toBe(snapshotRequest(chat(big, big, big, big), orGpt.model).total);
		const firstCheck = postResponseCheck(t, usage())!;
		expect(firstCheck.estPrompt).toBe(snapshotRequest(chat(big, big, big), orGpt.model).total);
		expect(_internal.pendings.size).toBe(0);
	});

	test('an older request finishing last does not replace the newer baseline', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(t, usage(500));

		t = preSendCheck(id, orGpt, chat(big, big, big));
		const second = preSendCheck(id, orGpt, chat(big, big, big, big));
		postResponseCheck(second, usage(500)); // the newer request resolves first
		postResponseCheck(t, usage(0));        // the older one finishes later, cache cold

		const msgs = chat(big, big, big, big, big);
		t = preSendCheck(id, orGpt, msgs);
		const check = postResponseCheck(t, usage())!;
		expect(check.divergedAt).toBe(4);
		expect(check.expected).toBe(snapshotRequest(chat(big, big, big, big), orGpt.model).cumTokens[3]);

		// and the last hit keeps counting for the notice recency rule
		expect(_internal.getBaseline(id, orGpt.provider, orGpt.model)!.lastCachedAt).toBeDefined();
	});

	test('an unknown request id resolves nothing', () => {
		expect(postResponseCheck(123456, usage())).toBeUndefined();
	});

	test('only successful streams replace the baseline, even without usage', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big));
		expect(_internal.baselines.has(id)).toBe(false);
		postResponseCheck(t, usage(500), false);
		expect(_internal.baselines.has(id)).toBe(false);
		expect(_internal.pendings.has(t)).toBe(false);

		t = preSendCheck(id, orGpt, chat(big));
		postResponseCheck(t, undefined, true);
		const baseline = _internal.getBaseline(id, orGpt.provider, orGpt.model);
		expect(baseline).toBeDefined();
		t = preSendCheck(id, orGpt, chat('failed replacement'));
		postResponseCheck(t, undefined, false);
		expect(_internal.getBaseline(id, orGpt.provider, orGpt.model)).toBe(baseline);

		t = preSendCheck(id, orGpt, chat(big));
		expect(postResponseCheck(t, usage(500), true)!.expected).toBeGreaterThan(0);
	});

	test('retention changes use the previous successful request lifetime', () => {
		for (const [previous, current, expired] of [['5m', '1h', true], ['1h', '5m', false]] as const) {
			const id = chatId();
			t = preSendCheck(id, { ...orClaude, cacheLength: previous }, chat(big));
			postResponseCheck(t, usage());
			advance(6 * 60e3);
			t = preSendCheck(id, { ...orClaude, cacheLength: current }, chat(big));
			const check = postResponseCheck(t, usage(0))!;
			expect(check.expected === 0).toBe(expired);
			expect(_internal.getBaseline(id, orClaude.provider, orClaude.model)!.ttlMs).toBe(current === '1h' ? 3600e3 : 300e3);
		}
	});

	test('external image URLs with the same length have distinct fingerprints', () => {
		const image = (url: string): Message[] => [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }];
		const a = snapshotRequest(image('https://example.com/a.png'), orGpt.model);
		const b = snapshotRequest(image('https://example.com/b.png'), orGpt.model);
		expect(a.hashes[0]).not.toBe(b.hashes[0]);
		expect(a.hashes).toEqual(snapshotRequest(image('https://example.com/a.png'), orGpt.model).hashes);
	});

	test('message name participates in the hash', () => {
		const withName: Message[] = [{ role: 'user', content: big, name: 'alice' }];
		const without: Message[] = [{ role: 'user', content: big }];
		expect(snapshotRequest(withName, 'gpt-4o').hashes[0]).not.toBe(snapshotRequest(without, 'gpt-4o').hashes[0]);
	});

	test('check history keys are capped like baselines', () => {
		for (let i = 0; i < 60; i++) {
			const id = chatId();
			t = preSendCheck(id, orGpt, chat(big));
			postResponseCheck(t, usage());
		}
		expect(Object.keys(checkHistory()).length).toBeLessThanOrEqual(50);
	});

	test('history keeps the last 10 checks per chat', () => {
		const id = chatId();
		for (let i = 0; i < 15; i++) {
			t = preSendCheck(id, orGpt, chat(big));
			postResponseCheck(t, usage());
		}
		expect(checkHistory()[id]!.length).toBe(_internal.HISTORY_SIZE);
		expect(latestCheck(id)!.model).toBe(orGpt.model);
	});
});

describe('shouldNotifyMiss', () => {
	// A miss with a controllable shortfall: the request repeats the baseline, so the
	// whole prompt is expected from cache, and the API reports `cached` of it.
	function missWith(cachedFrac: number, text = big) {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(text));
		postResponseCheck(t, usage());
		const est = snapshotRequest(chat(text), orGpt.model).total;
		t = preSendCheck(id, orGpt, chat(text));
		return postResponseCheck(t, usage(Math.round(est * cachedFrac), est))!;
	}

	test('a shortfall within cache block rounding stays out of the notices', () => {
		// ~300 est tokens expected, a third of them reported cached
		const check = missWith(0.1, 'lorem ipsum '.repeat(100));
		expect(check.verdict).toBe('miss');
		expect(check.missNotificationAllowed).toBe(true);
		expect(shouldNotifyMiss(check)).toBe(false);
	});

	test('a large shortfall notifies', () => {
		const check = missWith(0.1);
		expect(check.verdict).toBe('miss');
		expect(shouldNotifyMiss(check)).toBe(true);
	});

	test('checks without a comparable baseline never notify', () => {
		const id = chatId();
		t = preSendCheck(id, orGpt, chat(big, big));
		const first = postResponseCheck(t, usage(0))!;
		expect(first.expected).toBeNull();
		expect(shouldNotifyMiss(first)).toBe(false);
	});

	test('a zero prompt_tokens report falls back to the estimate', () => {
		const check = missWith(0);
		const zero = { ...check, promptTokens: 0 };
		expect(shouldNotifyMiss(zero)).toBe(true);
	});

	test('the recency rule still suppresses stale implicit-cache misses', () => {
		const id = chatId();
		const msgs = chat(big, big);
		t = preSendCheck(id, orGpt, msgs);
		postResponseCheck(t, usage(500));
		advance(11 * 60e3);
		t = preSendCheck(id, orGpt, msgs);
		const check = postResponseCheck(t, usage(0))!;
		expect(check.verdict).toBe('miss');
		expect(shouldNotifyMiss(check)).toBe(false);
	});
});
