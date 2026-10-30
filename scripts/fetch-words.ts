/**
 * One-time data fetch: builds src/assets/words.txt, a frequency-ranked list of
 * English content words for creative prompts. Sources:
 *   - OpenSubtitles 2018 50k frequency list (CC-BY-SA, hermitdave/FrequencyWords)
 *     — subtitle dialogue skews toward spoken, emotional, narrative vocabulary.
 *   - hunspell en dictionary (wooorm/dictionaries), used as a filter only:
 *     lowercase-only entries are real words, capitalized ones are proper nouns,
 *     which the flat frequency list can't distinguish.
 * Keeps ranks 350+, 3+ lowercase letters, dictionary-confirmed, minus stopwords.
 * Re-run to refresh; commit the result. `bun scripts/fetch-words.ts`
 */
import { writeFileSync } from 'node:fs';

const FREQ = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt';
const DICT = 'https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.dic';
const OUT = 'src/assets/words.txt';
const MIN_RANK = 350;

const STOPWORDS = new Set(
	('i me my we our you your he him his she her it its they them their who whom this that these those ' +
	'a an the and but or if because as until while of at by for with about between into through during ' +
	'before after above below from up down off over again then once here there when where why how all any ' +
	'both each few more most other some such own same too very only just also still even than so not no ' +
	'whatever whenever wherever however therefore perhaps probably maybe anyway cannot rather quite ' +
	'instead else soon often always usually together already everybody somebody anybody nobody someone ' +
	'everyone anyone something anything everything nothing somewhere anywhere everywhere nowhere ' +
	'mine yours ours theirs himself herself itself ourselves themselves myself yourself toward towards upon').split(' ')
);

async function text(url: string): Promise<string> {
	const res = await fetch(url, { headers: { 'user-agent': 'openrouter-chat wordlist dataset (one-time fetch)' } });
	if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
	return res.text();
}

const dict = new Set(
	(await text(DICT)).split('\n').slice(1)
		.map(l => l.split('/')[0]!)
		.filter(w => /^[a-z]+$/.test(w))
);

const words = (await text(FREQ)).split('\n')
	.slice(MIN_RANK - 1)
	.map(l => l.split(' ')[0]!)
	.filter(w => /^[a-z]{3,}$/.test(w) && dict.has(w) && !STOPWORDS.has(w));

if (words.length < 10000) throw new Error(`only got ${words.length} words, expected ~18k — aborting`);

writeFileSync(OUT, words.join('\n') + '\n');
console.log(`${words.length} words → ${OUT}`);
