/**
 * Tests for the bundled pool helpers (src/helpers/tools/pools.ts).
 * The asset files themselves aren't loaded — parsing and sampling are
 * exercised against small fixtures. Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { parseVital, bucketize, topicNames, matchTopic, pickTopics, pickWords, pickMixed } from '../src/helpers/tools/pools';

const RAW = [
	'Arts\tMona Lisa',
	'Arts\tHamlet',
	'Arts\tOrigami',
	'History\tBattle of Waterloo',
	'History\tRenaissance',
	'People\tAda Lovelace',
	'',
].join('\n');

const rows = parseVital(RAW);
const buckets = bucketize(rows);

describe('parseVital', () => {
	test('parses topic\ttitle lines, skips empty ones', () => {
		expect(rows).toHaveLength(6);
		expect(rows[0]).toEqual({ topic: 'Arts', title: 'Mona Lisa' });
	});
});

describe('topicNames', () => {
	test('unique and sorted', () => {
		expect(topicNames(rows)).toEqual(['Arts', 'History', 'People']);
	});
});

describe('matchTopic', () => {
	test('case-insensitive prefix', () => {
		expect(matchTopic(buckets, 'arts')).toBe('Arts');
		expect(matchTopic(buckets, 'HIST')).toBe('History');
		expect(matchTopic(buckets, 'p')).toBe('People');
	});
	test('unknown prefix', () => {
		expect(matchTopic(buckets, 'zulu')).toBeUndefined();
	});
});

describe('pickTopics', () => {
	const zero = () => 0;

	test('within a category, unique, capped at the bucket size', () => {
		expect(pickTopics(buckets, 2, 'Arts', zero)).toHaveLength(2);
		expect(pickTopics(buckets, 10, 'Arts', zero)).toHaveLength(3);
		expect(pickTopics(buckets, 2, 'Nowhere', zero)).toHaveLength(0);
	});

	test('without a category, spreads across topics', () => {
		const picked = pickTopics(buckets, 3, undefined, zero);
		expect(picked).toHaveLength(3);
		// zero rng: Fisher-Yates + round-robin walks one title per topic
		const topicsOf = picked.map(t => rows.find(r => r.title === t)!.topic);
		expect(new Set(topicsOf).size).toBe(3);
	});

	test('never duplicates a title', () => {
		const picked = pickTopics(buckets, 3, 'Arts', () => 0.9999); // always last element
		expect(new Set(picked).size).toBe(picked.length);
	});

	test('asks for more than exist without looping forever', () => {
		expect(pickTopics(buckets, 100, undefined, zero).length).toBeLessThanOrEqual(6);
	});
});

const WORDS = ['angst', 'brittle', 'catharsis', 'dire', 'echo', 'frost'];

describe('pickWords', () => {
	test('unique, capped at list size', () => {
		const three = pickWords(WORDS, 3, () => 0.5);
		expect(three).toHaveLength(3);
		expect(new Set(three).size).toBe(3);
		expect(pickWords(WORDS, 100).length).toBe(WORDS.length);
		for (const w of pickWords(WORDS, 3)) expect(WORDS).toContain(w);
	});
});

describe('pickMixed', () => {
	const zero = () => 0;

	test('~2 topics per word once count reaches 3', () => {
		expect(pickMixed(buckets, WORDS, 3, undefined, zero)).toEqual({ topics: expect.any(Array), words: expect.any(Array) });
		const three = pickMixed(buckets, WORDS, 3, undefined, zero);
		expect(three.topics).toHaveLength(2);
		expect(three.words).toHaveLength(1);
		const nine = pickMixed(buckets, WORDS, 9, undefined, zero);
		expect(nine.topics).toHaveLength(6);
		expect(nine.words).toHaveLength(3);
	});

	test('below 3 is all topics', () => {
		expect(pickMixed(buckets, WORDS, 2, undefined, zero).words).toHaveLength(0);
	});

	test('category scopes the topics only', () => {
		const mixed = pickMixed(buckets, WORDS, 3, 'History', zero);
		for (const t of mixed.topics)
			expect(rows.find(r => r.title === t)!.topic).toBe('History');
	});
});
