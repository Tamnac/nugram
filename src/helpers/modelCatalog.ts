/**
 * Model lists for every provider, shared by all ModelPicker instances.
 *
 * Builtins use their own endpoints (or a hardcoded list); custom providers are asked for
 * `{base}/models`. Lists live in a plain signal so Fuse indexes raw objects, not store proxies.
 */
import { createSignal } from 'solid-js';
import Fuse, { type Expression, type FuseResultMatch, type IFuseOptions } from 'fuse.js';
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

let fuse: Fuse<ModelEntry> | undefined;
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

/** Provider URLs point at the completion endpoint; the model list sits next to it. */
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
 * The provider's own list. Providers without one borrow OpenRouter's (it carries most models),
 * so ids can still be found by search; the entries are relabeled to the asking provider.
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
	fuse = undefined;
}

/** Only terms starting with a letter or digit are tried as provider names, others would be extended-search operators. */
const providerTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(term => /^[a-z0-9]/.test(term));

/** Providers with a word starting with a query term, e.g. `or`, `open`, `anth`. */
export function mentionedProviders(query: string): Provider[] {
	const terms = providerTerms(query).filter(term => term.length >= 2);
	return Object.keys(providerWords).filter(p => terms.some(term => providerWords[p]!.some(w => w.startsWith(term))));
}

/**
 * Names and ids match fuzzily. Providers match by exact word prefix (`^term`), so `gpt` doesn't hit "nanogpt"
 * and `openai` doesn't hit "openrouter", and weigh enough to rank the named provider's models first.
 */
const FUSE_OPTIONS: IFuseOptions<ModelEntry> = {
	keys: [{ name: 'name', weight: 2 }, 'id', { name: 'provider', weight: 10, getFn: m => providerWords[m.provider] ?? [m.provider] }],
	ignoreLocation: true,
	threshold: 0.4,
	includeMatches: true,
	useExtendedSearch: true,
};

/** A search result, with inclusive character ranges of `entryLabel` to highlight. */
export type SearchHit = ModelEntry & { highlight?: [number, number][] };

/** Fuse also reports stray single letters, so only the longest run per matched term is kept. */
function labelHighlight(entry: ModelEntry, matches: readonly FuseResultMatch[] = []): [number, number][] {
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

/** Every whitespace-separated term has to match one of name, id or provider. */
function toExpression(query: string): Expression {
	return {
		$and: query.split(/\s+/).filter(Boolean).map(term => ({
			$or: [{ name: term }, { id: term }, ...providerTerms(term).map(t => ({ provider: `^${t}` }))],
		})),
	};
}

/**
 * Fuzzy search across the given providers. A single provider without its own list searches OpenRouter's,
 * so naming that provider in the query finds nothing.
 */
export function searchModels(query: string, providers: Provider[], limit = 50): SearchHit[] {
	const expression = toExpression(query);
	const [only] = providers;
	if (providers.length === 1 && !lists()[only!]?.length)
		return searchIndex(expression, ['or'], limit).map(m => ({ ...m, provider: only! }));
	return searchIndex(expression, providers, limit);
}

function searchIndex(expression: Expression, providers: Provider[], limit: number): SearchHit[] {
	fuse ??= new Fuse(Object.values(lists()).flat(), FUSE_OPTIONS);
	const wanted = new Set(providers);
	const out: SearchHit[] = [];
	for (const { item, matches } of fuse.search(expression)) {
		if (!wanted.has(item.provider)) continue;
		out.push({ ...item, highlight: labelHighlight(item, matches) });
		if (out.length >= limit) break;
	}
	return out;
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

export function pushRecent(entry: ModelEntry) {
	const next = [entry, ...recents().filter(m => m.provider !== entry.provider || m.id !== entry.id)].slice(0, 20);
	setRecents(next);
	try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); }
	catch (e) { console.warn('Failed to save recent models:', e); }
}
