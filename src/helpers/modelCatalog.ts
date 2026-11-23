/**
 * Model lists for every provider, shared by all ModelPicker instances.
 *
 * Builtins use their own endpoints (or a hardcoded list); custom providers are asked for
 * `{base}/models`. Lists are kept in a plain signal so Fuseter indexes plain objects, not store proxies.
 */
import { createSignal } from 'solid-js';
import { Fuseter, type FuseterMatch, type FuseterOptions } from 'fuseter/js';
import type { Provider, ProviderConfig } from './types';
import { DEFAULT_PROVIDERS, providerNames } from './types';
import { httpFetch } from './platform';

export interface ModelEntry {
	provider: Provider;
	id: string;
	name?: string | undefined;
	description?: string | undefined;
}

const ZAI_MODELS = ['glm-5.2', 'glm-5.1', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-x', 'glm-4.5-airx', 'glm-4.5-flash', 'glm-4-32b-0414-128k'];

const ANTH_LOCAL_MODELS = [
	'claude-fable-5-1',
	'claude-fable-5',
	'claude-opus-5-5',
	'claude-opus-5', 
	'claude-opus-4-8', 
	'claude-opus-4-7', 
	'claude-opus-4-6', 
	'opus-4-5',
	'claude-sonnet-5', 
	'claude-sonnet-5-5', 
	'claude-sonnet-4-6', 
	'sonnet-4-5', 
	'claude-haiku-5-5', 
	'haiku-4-5', 
	'opus-4-1',
];

/** Providers with a hardcoded list instead of a fetched one. */
export const STATIC_PROVIDERS: Provider[] = ['zai', 'anth_local'];

const [lists, setLists] = createSignal<Record<Provider, ModelEntry[]>>({
	zai: ZAI_MODELS.map(id => ({ provider: 'zai', id })),
	anth_local: ANTH_LOCAL_MODELS.map(id => ({ provider: 'anth_local', id })),
});
export const modelLists = lists;

let fuse: Fuseter<ModelEntry> | undefined;
const byId = new WeakMap<ModelEntry[], Map<string, ModelEntry>>();

function setList(provider: Provider, list: ModelEntry[]) {
	setLists(prev => ({ ...prev, [provider]: list }));
	fuse = undefined;
}

// ── Fetching ─────────────────────────────────────────────────────────

const fetchedWith: Record<Provider, string> = {};

/** Fetches each enabled provider's list once per url + key. Safe to call from every picker. */
export function ensureModels(providers: Record<Provider, ProviderConfig>) {
	indexProviderNames(providers);
	for (const [key, cfg] of Object.entries(providers)) {
		if (!cfg.enabled || STATIC_PROVIDERS.includes(key)) continue;
		const signature = `${cfg.url}|${cfg.apiKey}`;
		if (fetchedWith[key] === signature) continue;
		const fetcher = key in DEFAULT_PROVIDERS ? builtinFetchers[key] : fetchOpenAIModels;
		if (!fetcher || (needsKey.has(key) && !cfg.apiKey)) continue;
		fetchedWith[key] = signature;
		fetcher(key, cfg)
			.then(list => fetchedWith[key] === signature && list.length && setList(key, list))
			.catch(e => {
				if (fetchedWith[key] !== signature) return;
				delete fetchedWith[key];
				console.warn(`Failed to fetch ${key} models:`, e);
			});
	}
}

async function getJson(url: string, apiKey?: string) {
	const res = await httpFetch(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

const needsKey = new Set<Provider>(['fireworks', 'neuralwatt']);

const builtinFetchers: Record<Provider, (key: Provider, cfg: ProviderConfig) => Promise<ModelEntry[]>> = {
	or: async () => (await getJson('https://openrouter.ai/api/v1/models')).data.map((m: any) => ({
		provider: 'or', id: m.id, name: m.name, description: m.description,
	})),
	nano: async () => (await getJson('https://nano-gpt.com/api/v1/models?detailed=true')).data.map((m: any) => ({
		provider: 'nano', id: m.id, name: m.name, description: m.description,
	})),
	fireworks: async (_, cfg) => {
		const data = await getJson('https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue', cfg.apiKey);
		return [
			...data.models.map((m: any) => ({
				provider: 'fireworks', id: m.name || m.id, name: m.displayName, description: m.description,
			})),
			{ provider: 'fireworks', id: 'accounts/fireworks/routers/kimi-k2p5-turbo', name: 'Kimi K2.5 Turbo', description: 'FirePass only, (supposedly) faster Kimi K2.5' },
			{ provider: 'fireworks', id: 'accounts/fireworks/routers/glm-5-fast', name: 'GLM 5.0 Fast', description: 'FirePass only, (supposedly) faster GLM 5' },
		];
	},
	neuralwatt: async (_, cfg) => (await getJson('https://api.neuralwatt.com/v1/models', cfg.apiKey)).data.map((m: any) => ({
		provider: 'neuralwatt', id: m.id, name: m.metadata?.display_name, description: m.metadata?.description,
	})),
};

/** Provider URLs point at the completion endpoint; the model list is at `/models` under the same base path. */
export function modelsUrl(url: string) {
	return url.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|responses)$/, '') + '/models';
}

async function fetchOpenAIModels(key: Provider, cfg: ProviderConfig): Promise<ModelEntry[]> {
	const data = await getJson(modelsUrl(cfg.url), cfg.apiKey);
	const models: any[] = Array.isArray(data) ? data : data.data ?? data.models ?? [];
	return models.filter(m => m?.id || m?.name).map(m => ({
		provider: key,
		id: m.id ?? m.name,
		name: m.display_name ?? m.metadata?.display_name,
		description: m.description,
	}));
}

// ── Lookup & search ──────────────────────────────────────────────────

/**
 * The provider's own list. Providers without one use OpenRouter's (which lists most models),
 * so ids can still be found by search; the entries' `provider` is set to the requested one.
 */
export function providerModels(provider: Provider): ModelEntry[] {
	const all = lists();
	if (all[provider]?.length) return all[provider];
	return (all.or ?? []).map(m => ({ ...m, provider }));
}

function findModel(provider: Provider, id: string): ModelEntry | undefined {
	const all = lists();
	const list = all[provider]?.length ? all[provider] : all.or;
	if (!list) return undefined;
	let index = byId.get(list);
	if (!index) byId.set(list, index = new Map(list.map(m => [m.id, m])));
	return index.get(id);
}

/** Display name without the vendor: `MoonshotAI: Kimi K3` and `moonshotai/kimi-k3` both lose the prefix. */
export function entryLabel(entry: ModelEntry): string {
	if (entry.name && entry.name !== entry.id) return entry.name.replace(/^[^:/]+:\s+/, '');
	return entry.id.split('/').pop() || entry.id;
}

export function modelLabel(provider: Provider, id: string): string {
	return entryLabel(findModel(provider, id) ?? { provider, id });
}

export function providerLabel(provider: Provider, providers: Record<Provider, ProviderConfig>): string {
	return providers[provider]?.name || (providerNames as Record<string, string>)[provider] || provider;
}

/**
 * Lowercased words of each provider's key and display name (`anth_local` → anth_local, anth, local, anthropic),
 * so queries like `or fable` or `anth opus` can name the provider.
 */
let providerWords: Record<Provider, string[]> = {};

function indexProviderNames(providers: Record<Provider, ProviderConfig>) {
	const next: Record<Provider, string[]> = {};
	for (const key of Object.keys(providers)) {
		const text = `${key} ${providerLabel(key, providers)}`.toLowerCase();
		next[key] = [...new Set([key.toLowerCase(), ...text.split(/[^a-z0-9]+/).filter(Boolean)])];
	}
	if (JSON.stringify(next) === JSON.stringify(providerWords)) return;
	providerWords = next;
}

/** Only terms starting with a letter or digit are tried as provider names. */
const providerTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(term => /^[a-z0-9]/.test(term));

/** Providers with a word starting with a query term, e.g. `or`, `open`, `anth`. */
export function mentionedProviders(query: string): Provider[] {
	const terms = providerTerms(query).filter(term => term.length >= 2);
	return Object.keys(providerWords).filter(p => terms.some(term => providerWords[p]!.some(w => w.startsWith(term))));
}

/** Names and ids match fuzzily; providers are matched separately (see `searchIndex`). */
const FUSE_OPTIONS: FuseterOptions = {
	keys: [{ name: 'name', weight: 2 }, 'id'],
	threshold: 0.4,
	includeScore: true,
	includeMatches: true,
};

/** A search result, with inclusive character ranges of `entryLabel` to highlight. */
export type SearchHit = ModelEntry & { highlight?: [number, number][] };

/** Fuzzy matching also reports stray single letters, so only the longest run per matched term is kept. */
function labelHighlight(entry: ModelEntry, matches: readonly FuseterMatch[] = []): [number, number][] {
	const label = entryLabel(entry);
	const out: [number, number][] = [];
	for (const { value, indices } of matches) {
		if (!value?.endsWith(label) || !indices.length) continue;
		const offset = value.length - label.length;
		const [start, end] = indices.reduce((a, b) => b[1] - b[0] > a[1] - a[0] ? b : a);
		if (end - start < 1 || end < offset) continue;
		out.push([Math.max(start, offset) - offset, end - offset]);
	}
	return out;
}

/**
 * Fuzzy search across the given providers. For a single provider without its own list, OpenRouter's list
 * is searched; its entries have provider `or` while matching, so naming that provider in the query finds nothing.
 */
export function searchModels(query: string, providers: Provider[], limit = 50): SearchHit[] {
	const terms = query.split(/\s+/).filter(Boolean);
	const [only] = providers;
	if (providers.length === 1 && !lists()[only!]?.length)
		return searchIndex(terms, ['or'], limit).map(m => ({ ...m, provider: only! }));
	return searchIndex(terms, providers, limit);
}

interface Candidate { entry: ModelEntry; score: number; highlight: [number, number][] }

/**
 * Every term has to match the entry's name or id fuzzily, or start a word of its provider (`gpt` doesn't hit
 * "nanogpt", `openai` doesn't hit "openrouter"). A provider match scores 0, and a fuzzy match on a term that names
 * some provider is penalized, so the named provider's models rank first.
 */
function searchIndex(terms: string[], providers: Provider[], limit: number): SearchHit[] {
	if (!terms.length) return [];
	fuse ??= Fuseter.createSync(Object.values(lists()).flat(), FUSE_OPTIONS);
	const wanted = new Set(providers);
	let candidates: Candidate[] = Object.values(lists()).flat()
		.filter(entry => wanted.has(entry.provider))
		.map(entry => ({ entry, score: 0, highlight: [] }));
	for (const term of terms) {
		const fuzzy = new Map(fuse.search(term).map(r => [r.item, r]));
		const prefixes = providerTerms(term);
		const namesProvider = mentionedProviders(term).length > 0;
		const next: Candidate[] = [];
		for (const c of candidates) {
			const hit = fuzzy.get(c.entry);
			const named = prefixes.some(t => providerWords[c.entry.provider]?.some(w => w.startsWith(t)));
			if (!hit && !named) continue;
			next.push({
				entry: c.entry,
				score: c.score + (named ? 0 : (hit!.score ?? 0) + (namesProvider ? 1 : 0)),
				highlight: hit ? [...c.highlight, ...labelHighlight(c.entry, hit.matches)] : c.highlight,
			});
		}
		candidates = next;
	}
	return candidates.sort((a, b) => a.score - b.score).slice(0, limit)
		.map(({ entry, highlight }) => ({ ...entry, highlight }));
}

// ── Recents ──────────────────────────────────────────────────────────

const RECENTS_KEY = 'recentModels';

function loadRecents(): ModelEntry[] {
	try {
		const stored = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
		return Array.isArray(stored)
			? stored.filter(m => m?.id && m?.provider).map(m => ({ provider: m.provider, id: m.id, name: m.name, description: m.description }))
			: [];
	} catch (e) {
		console.warn('Failed to load recent models:', e);
		return [];
	}
}

const [recents, setRecents] = createSignal<ModelEntry[]>(loadRecents());
export const recentModels = recents;

/**
 * Model to switch to when a provider is picked without choosing a model: its last recent, else a static
 * list's first entry. Fetched lists have no meaningful order, so they only contribute recents.
 */
export function defaultModelFor(provider: Provider): string | undefined {
	return recents().find(m => m.provider === provider)?.id
		?? (STATIC_PROVIDERS.includes(provider) ? lists()[provider]?.[0]?.id : undefined);
}

export function pushRecent(entry: ModelEntry) {
	const next = [entry, ...recents().filter(m => m.provider !== entry.provider || m.id !== entry.id)].slice(0, 20);
	setRecents(next);
	try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); }
	catch (e) { console.warn('Failed to save recent models:', e); }
}
