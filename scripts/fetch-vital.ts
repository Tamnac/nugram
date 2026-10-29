/**
 * One-time data fetch: builds src/assets/vital5.tsv from English Wikipedia's
 * Vital Articles data shards (Wikipedia:Vital articles/data/A.json .. Z.json).
 * Each shard is a JSON object of title -> {level, topic, section}; we keep the
 * level-5 entries (~50k articles) with their top-level topic as the category.
 * Re-run to refresh; commit the result. `bun scripts/fetch-vital.ts`
 */
import { writeFileSync } from 'node:fs';

const API = 'https://en.wikipedia.org/w/api.php';
const OUT = 'src/assets/vital5.tsv';
const UA = 'openrouter-chat vital5 dataset (one-time scrape; contact: repo issues)';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Entry = { level: number; topic?: string; section?: string };

const rows: [topic: string, title: string][] = [];
const shards = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'others'];

for (const shard of shards) {
	const url = `${API}?${new URLSearchParams({
		format: 'json', action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
		titles: `Wikipedia:Vital articles/data/${shard}.json`,
	})}`;
	let res!: Response;
	for (let attempt = 1; ; attempt++) {
		res = await fetch(url, { headers: { 'user-agent': UA } });
		if (res.ok) break;
		if (attempt > 5) throw new Error(`api ${res.status} for shard ${shard}`);
		await sleep(1000 * attempt ** 2);
	}
	const data = await res.json();
	const page = Object.values<any>(data.query.pages)[0];
	const content = page?.revisions?.[0]?.slots?.main?.['*'];
	if (!content) continue; // shard doesn't exist
	const parsed: Record<string, Entry> = JSON.parse(content);
	for (const [title, e] of Object.entries(parsed))
		if (e.level === 5 && e.topic && !title.includes('\t')) rows.push([e.topic, title]);
	console.log(`${shard}: ${rows.length} level-5 so far`);
	await sleep(300);
}

// The shards trail the live ~50k list pages; ~40k is expected.
if (rows.length < 30000) throw new Error(`only got ${rows.length} rows, expected ~40k — aborting`);

rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
writeFileSync(OUT, rows.map(r => r.join('\t')).join('\n') + '\n');

const sections = new Map<string, number>();
for (const [s] of rows) sections.set(s, (sections.get(s) ?? 0) + 1);
console.log(`\nwrote ${rows.length} rows to ${OUT}`);
for (const [s, n] of sections) console.log(`  ${n.toString().padStart(5)}  ${s}`);
