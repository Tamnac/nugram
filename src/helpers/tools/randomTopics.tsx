import type { ToolModule } from './types';
import { httpFetch } from '../platform';
import { loadPools, vitalBuckets, vitalTopicNames, matchVitalTopic, wordList, pickTopics, pickWords, pickMixed } from './pools';

/** Uniform random article titles from all of Wikipedia (~7M articles). */
async function randomWikipediaTitles(count: number): Promise<string[]> {
	const url = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({
		format: 'json', formatversion: '2', action: 'query',
		generator: 'random', grnnamespace: '0', grnlimit: String(count),
	})}`;
	const res = await httpFetch(url, { headers: { 'user-agent': 'openrouter-chat random_topics' } });
	if (!res.ok) throw new Error(`wikipedia api ${res.status}`);
	const data = await res.json();
	return Object.values<any>(data.query?.pages ?? {}).map((p: any) => p.title);
}

export const randomTopicsTool: ToolModule = {
	rerunnable: true,
	returns: '{ topics: string[], words: string[] }',
	definition: {
		type: 'function',
		function: {
			name: 'random_topics',
			description: "Get a few random topics and words",
			parameters: {
				type: 'object',
				properties: {
					count: {
						type: 'integer',
						description: 'number of items, 1-10, 3 if not specified'
					},
					pool: {
						type: 'string',
						enum: ['mixed', 'vital', 'words', 'random'],
						description: "mixed (default): 2:1 vital:words. 'vital': Wikipedia Vitals titles, categorized. 'words': words only. 'random': random articles from all of Wikipedia, more obscure."
					},
					category: {
						type: 'string',
						description: 'For vital pool only; prefix of a topic: Arts, Biology & health, Everyday life, Geography, History, Mathematics, People, Philosophy and religion, Physical sciences, Society and social sciences, Technology'
					}
				},
			}
		}
	},

	async execute(call) {
		const args = call.function.arguments as any;
		const count = Math.max(1, Math.min(10, Math.trunc(args?.count) || 3));
		const pool = args?.pool ?? 'mixed';

		if (pool === 'random') return { topics: await randomWikipediaTitles(count), words: [] };
		if (!['vital', 'words', 'mixed'].includes(pool)) throw new Error(`unknown pool "${pool}"`);

		await loadPools();
		const buckets = vitalBuckets();
		const words = wordList();
		if (!buckets || !words) throw new Error('topic list failed to load');
		let category: string | undefined;
		if (args?.category?.trim() && pool !== 'words') {
			category = matchVitalTopic(args.category);
			if (!category)
				throw new Error(`unknown category "${args.category}" — topics: ${vitalTopicNames().join(', ')}`);
		}
		if (pool === 'words') return { topics: [], words: pickWords(words, count) };
		if (pool === 'vital') return { topics: pickTopics(buckets, count, category), words: [] };
		return pickMixed(buckets, words, count, category);
	},

	// Interleave topics and words ~2:1; pure function of the stored data.
	format: data => {
		const topics = (data.topics as string[]) ?? [];
		const words = (data.words as string[]) ?? [];
		const lines: string[] = [];
		let t = 0, w = 0;
		while (t < topics.length || w < words.length) {
			for (let i = 0; i < 2 && t < topics.length; i++) lines.push(topics[t++]!);
			if (w < words.length) lines.push(words[w++]!);
		}
		return lines.join('  \n');
	},

	Summary: props => {
		const args = props.call.function.arguments as any;
		if (args.pool === 'words') return <span>words <code>{args.count ?? 3}</code></span>;
		const tag = args.pool === 'random' ? ' all'
			: args.category ? ` (${args.category})`
			: args.pool === 'mixed' || !args.pool ? ' mixed'
			: ' vitals';
		return <span>topics <code>{args.count ?? 3}</code>{tag}</span>;
	},
};
