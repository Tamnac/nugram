/**
 * Bundled corpora for random generation, shared by the random_topics tool and
 * the @@topic/@@word macros:
 *   - Wikipedia Vital Articles Level 5 (~40k curated articles in 11 topics),
 *     built by scripts/fetch-vital.ts into assets/vital5.tsv (topic\ttitle).
 *   - ~19k frequency-ranked English content words, built by
 *     scripts/fetch-words.ts into assets/words.txt (one per line).
 */

export interface TopicRow {
	topic: string;
	title: string;
}

export type TopicBuckets = Map<string, string[]>;

export function parseVital(raw: string): TopicRow[] {
	const rows: TopicRow[] = [];
	for (const line of raw.split('\n')) {
		const tab = line.indexOf('\t');
		if (tab > 0) rows.push({ topic: line.slice(0, tab), title: line.slice(tab + 1) });
	}
	return rows;
}

export function bucketize(rows: TopicRow[]): TopicBuckets {
	const buckets: TopicBuckets = new Map();
	for (const { topic, title } of rows) {
		const bucket = buckets.get(topic);
		if (bucket) bucket.push(title);
		else buckets.set(topic, [title]);
	}
	return buckets;
}

/** Topic names present in the rows, alphabetical. */
export function topicNames(rows: TopicRow[]): string[] {
	return [...new Set(rows.map(r => r.topic))].sort();
}

/** Case-insensitive prefix match against the topic names of these buckets. */
export function matchTopic(buckets: TopicBuckets, prefix: string): string | undefined {
	const needle = prefix.trim().toLowerCase();
	return [...buckets.keys()].find(t => t.toLowerCase().startsWith(needle));
}

function shuffled<T>(arr: T[], rng: () => number): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

/**
 * Without a category, draws round-robin across shuffled topics; with one, draws within it.
 * Returns fewer than `count` if the category can't supply that many.
 */
export function pickTopics(buckets: TopicBuckets, count: number, category?: string, rng: () => number = Math.random): string[] {
	const lists = category
		? [buckets.get(category) ?? []]
		: shuffled([...buckets.values()], rng);
	const pools = lists.map(l => shuffled(l, rng));

	const out: string[] = [];
	while (out.length < count) {
		let added = false;
		for (const pool of pools) {
			if (out.length >= count) break;
			const title = pool.pop();
			if (title === undefined) continue;
			out.push(title);
			added = true;
		}
		if (!added) break;
	}
	return out;
}

export function pickWords(words: string[], count: number, rng: () => number = Math.random): string[] {
	return shuffled(words, rng).slice(0, count);
}

/** Roughly 2 topics per word; a `count` below 3 is all topics. */
export function pickMixed(buckets: TopicBuckets, words: string[], count: number, category?: string, rng: () => number = Math.random): { topics: string[]; words: string[] } {
	const nWords = count >= 3 ? Math.round(count / 3) : 0;

	return {
		topics: pickTopics(buckets, count - nWords, category, rng),
		words: pickWords(words, nWords, rng),
	};
}

let buckets: TopicBuckets | undefined;
let names: string[] | undefined;
let words: string[] | undefined;
let loadPromise: Promise<void> | undefined;

/** Loads the bundled corpora once. Never rejects; safe to fire and forget. */
export function loadPools(): Promise<void> {
	loadPromise ??= Promise.all([
		import('../../assets/vital5.tsv?raw'),
		import('../../assets/words.txt?raw'),
	])
	.then(([vital, word]) => {
		const rows = parseVital(vital.default);
		buckets = bucketize(rows);
		names = topicNames(rows);
		words = word.default.split('\n').filter(Boolean);
	})
	.catch(err => {
		console.error('pools failed to load:', err);
		loadPromise = undefined;
	});
	return loadPromise;
}

/** Sync accessors — empty until loadPools() has resolved. */
export const vitalBuckets = (): TopicBuckets | undefined => buckets;
export const vitalTopicNames = (): string[] => names ?? [];
export const matchVitalTopic = (prefix: string): string | undefined =>
	buckets ? matchTopic(buckets, prefix) : undefined;
export const wordList = (): string[] | undefined => words;
