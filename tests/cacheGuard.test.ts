import { describe, test, expect, afterEach } from 'bun:test';
import { preSendCheck, postResponseCheck, latestCheck, checkHistory, snapshotRequest, _internal } from '../src/helpers/cacheGuard';
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

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

function advance(ms: number) {
	const t = Date.now();
	Date.now = () => t + ms;
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
		preSendCheck(id, orGpt, chat(big, big));
		const check = postResponseCheck(id, usage(500))!;
		expect(check.expected).toBeNull();
		expect(check.expectReason).toBe('first tracked request');
		expect(check.verdict).toBe('none');
	});

	test('identical follow-up expects the full prompt back from cache', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(id, usage());

		preSendCheck(id, orGpt, chat(big, big, big)); // appended one message, prefix intact
		const snap = snapshotRequest(chat(big, big, big), 'gpt-4o');
		const check = postResponseCheck(id, usage())!;
		expect(check.expected).toBe(snap.cumTokens[1]);
		expect(check.divergedAt).toBe(2);
	});

	test('verdicts follow the cached/expected ratio', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(id, usage());

		// identical resend => expected share = 100%; use the estimate as the API
		// total so cached share equals the fraction of est we feed in
		const est = snapshotRequest(chat(big, big), orGpt.model).total;
		const round = (cachedFrac: number) => {
			preSendCheck(id, orGpt, chat(big, big));
			return postResponseCheck(id, usage(Math.round(est * cachedFrac), est))!;
		};

		expect(round(1).verdict).toBe('hit');
		expect(round(0.5).verdict).toBe('partial');
		expect(round(0.1).verdict).toBe('miss');
	});

	test('missing cached_tokens field is unknown, not a miss', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(id, usage());
		preSendCheck(id, orGpt, chat(big, big));
		expect(postResponseCheck(id, usage(undefined))!.verdict).toBe('unknown');
	});

	test('editing the first message clears the expected cache', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(id, usage());

		preSendCheck(id, orGpt, chat(big + 'edited', big));
		const check = postResponseCheck(id, usage(0))!;
		expect(check.expected).toBe(0);
		expect(check.expectReason).toBe('prefix changed from the first message');
		expect(check.divergedAt).toBe(0);
		expect(check.verdict).toBe('none'); // anticipated rebuild, not an alert
	});

	test('mid-history edit limits expectation to the shared prefix', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big, big, big, big));
		postResponseCheck(id, usage());

		preSendCheck(id, orGpt, chat(big, big, big + 'x', big));
		const check = postResponseCheck(id, usage())!;
		expect(check.divergedAt).toBe(2);
		expect(check.expected).toBe(snapshotRequest(chat(big, big, big), orGpt.model).cumTokens[1]);
	});

	test('model change resets expectation', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big, big));
		postResponseCheck(id, usage());

		preSendCheck(id, { ...orGpt, model: 'deepseek-v3' }, chat(big, big));
		const check = postResponseCheck(id, usage())!;
		expect(check.expected).toBeNull();
		expect(check.expectReason).toBe('model or provider changed');
	});

	test('claude: cache TTL expiry clears expectation; other models ignore it', () => {
		const id = chatId();
		preSendCheck(id, orClaude, chat(big, big));
		postResponseCheck(id, usage());

		advance(6 * 60e3); // past the 5m TTL
		preSendCheck(id, orClaude, chat(big, big));
		const expired = postResponseCheck(id, usage(0))!;
		expect(expired.expected).toBe(0);
		expect(expired.expectReason).toBe('cache TTL expired');
		expect(expired.verdict).toBe('none');

		const id2 = chatId();
		preSendCheck(id2, orGpt, chat(big, big));
		postResponseCheck(id2, usage());

		advance(6 * 60e3);
		preSendCheck(id2, orGpt, chat(big, big));
		const check = postResponseCheck(id2, usage(0))!;
		expect(check.expected).toBeGreaterThan(0);
		expect(check.verdict).toBe('miss');
	});

	test('implicit cache misses stay visible but stop notifying 10 minutes after the last cached response', () => {
		const id = chatId();
		const msgs = chat(big, big);
		preSendCheck(id, orGpt, msgs);
		postResponseCheck(id, usage(500));

		advance(9 * 60e3);
		preSendCheck(id, orGpt, msgs);
		const recent = postResponseCheck(id, usage(0))!;
		expect(recent.verdict).toBe('miss');
		expect(recent.missNotificationAllowed).toBe(true);

		advance(2 * 60e3);
		preSendCheck(id, orGpt, msgs);
		const stale = postResponseCheck(id, usage(0))!;
		expect(stale.expected).toBeGreaterThan(0);
		expect(stale.verdict).toBe('miss');
		expect(stale.missNotificationAllowed).toBe(false);

		preSendCheck(id, orGpt, msgs);
		postResponseCheck(id, usage(500));
		preSendCheck(id, orGpt, msgs);
		expect(postResponseCheck(id, usage(0))!.missNotificationAllowed).toBe(true);
	});

	test('explicit cache lifetimes keep miss notifications beyond 10 minutes', () => {
		const id = chatId();
		const ctx = { ...orClaude, cacheLength: '1h' as const };
		preSendCheck(id, ctx, chat(big, big));
		postResponseCheck(id, usage(500));
		advance(11 * 60e3);
		preSendCheck(id, ctx, chat(big, big));
		const check = postResponseCheck(id, usage(0))!;
		expect(check.verdict).toBe('miss');
		expect(check.missNotificationAllowed).toBe(true);
	});

	test('GPT-5.6 explicit retention keeps miss notifications after 10 minutes', () => {
		const id = chatId();
		const ctx = { ...orGpt, model: 'gpt-5.6' };
		preSendCheck(id, ctx, chat(big, big));
		postResponseCheck(id, usage(500));
		advance(11 * 60e3);
		preSendCheck(id, ctx, chat(big, big));
		expect(postResponseCheck(id, usage(0))!.missNotificationAllowed).toBe(true);
	});

	test('disabled caching does not exempt a model with an explicit lifetime', () => {
		const id = chatId();
		const ctx = { ...orClaude, cacheLength: '1h' as const };
		preSendCheck(id, ctx, chat(big, big));
		postResponseCheck(id, usage(500));
		advance(11 * 60e3);
		preSendCheck(id, { ...ctx, cacheEnabled: false }, chat(big, big));
		expect(postResponseCheck(id, usage(0))!.missNotificationAllowed).toBe(false);
	});

	test('baselines are LRU-capped and pruned by age', () => {
		for (let i = 0; i < 60; i++) {
			const id = chatId();
			preSendCheck(id, orGpt, chat(big));
			postResponseCheck(id, usage());
		}
		expect(_internal.baselines.size).toBeLessThanOrEqual(50);

		const id = chatId();
		preSendCheck(id, orGpt, chat(big));
		postResponseCheck(id, usage());
		advance(_internal.BASELINE_MAX_AGE + 1);
		preSendCheck(id, orGpt, chat(big));
		expect(postResponseCheck(id, usage())!.expectReason).toBe('first tracked request');
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
		preSendCheck(id, { ...orGpt, tools: [tool] }, chat(big, big));
		postResponseCheck(id, usage());

		preSendCheck(id, { ...orGpt, tools: [{ ...tool, function: { ...tool.function, description: 'changed' } }] }, chat(big, big));
		const check = postResponseCheck(id, usage(0))!;
		expect(check.expected).toBe(0);
		expect(check.expectReason).toBe('tool definitions changed');
		expect(check.verdict).toBe('none');
	});

	test('reasoning effort change busts the whole expected cache', () => {
		const id = chatId();
		preSendCheck(id, { ...orGpt, reasoningEffort: 'high' }, chat(big, big));
		postResponseCheck(id, usage());

		preSendCheck(id, { ...orGpt, reasoningEffort: 'low' }, chat(big, big));
		const check = postResponseCheck(id, usage(0))!;
		expect(check.expected).toBe(0);
		expect(check.expectReason).toBe('reasoning effort changed');
		expect(check.divergedAt).toBe(0);
		expect(check.verdict).toBe('none');

		// same effort keeps the prefix expectation
		preSendCheck(id, { ...orGpt, reasoningEffort: 'low' }, chat(big, big));
		expect(postResponseCheck(id, usage())!.expected).toBeGreaterThan(0);
	});

	test('a response without usage still consumes the pending check', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big));
		expect(postResponseCheck(id, undefined)).toBeUndefined();
		expect(_internal.pendings.has(id)).toBe(false);
	});

	test('only successful streams replace the baseline, even without usage', () => {
		const id = chatId();
		preSendCheck(id, orGpt, chat(big));
		expect(_internal.baselines.has(id)).toBe(false);
		postResponseCheck(id, usage(500), false);
		expect(_internal.baselines.has(id)).toBe(false);
		expect(_internal.pendings.has(id)).toBe(false);

		preSendCheck(id, orGpt, chat(big));
		postResponseCheck(id, undefined, true);
		const baseline = _internal.baselines.get(id);
		expect(baseline).toBeDefined();
		preSendCheck(id, orGpt, chat('failed replacement'));
		postResponseCheck(id, undefined, false);
		expect(_internal.baselines.get(id)).toBe(baseline);

		preSendCheck(id, orGpt, chat(big));
		expect(postResponseCheck(id, usage(500), true)!.expected).toBeGreaterThan(0);
	});

	test('retention changes use the previous successful request lifetime', () => {
		for (const [previous, current, expired] of [['5m', '1h', true], ['1h', '5m', false]] as const) {
			const id = chatId();
			preSendCheck(id, { ...orClaude, cacheLength: previous }, chat(big));
			postResponseCheck(id, usage());
			advance(6 * 60e3);
			preSendCheck(id, { ...orClaude, cacheLength: current }, chat(big));
			const check = postResponseCheck(id, usage(0))!;
			expect(check.expected === 0).toBe(expired);
			expect(_internal.baselines.get(id)!.ttlMs).toBe(current === '1h' ? 3600e3 : 300e3);
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
			preSendCheck(id, orGpt, chat(big));
			postResponseCheck(id, usage());
		}
		expect(Object.keys(checkHistory()).length).toBeLessThanOrEqual(50);
	});

	test('history keeps the last 10 checks per chat', () => {
		const id = chatId();
		for (let i = 0; i < 15; i++) {
			preSendCheck(id, orGpt, chat(big));
			postResponseCheck(id, usage());
		}
		expect(checkHistory()[id]!.length).toBe(_internal.HISTORY_SIZE);
		expect(latestCheck(id)!.model).toBe(orGpt.model);
	});
});
