/** web_search and fetch_url: provider selection (Kagi/Parallel), API calls and schemas. */
import { httpFetch, isTauri } from '../platform';
import { errMsg } from './shared';
import type { ToolModule } from './types';

const EXTRACT_LIMIT = 30000;
const FETCH_LIMIT = 30000;

/** Whichever extract API is configured, honouring the user's preference. */
export function extractProvider(): { name: 'kagi' | 'parallel'; key: string } | null {
	return utilityProvider('extract');
}

/** Provider selection shared between extract and web_search. */
export function utilityProvider(kind: 'extract' | 'search'): { name: 'kagi' | 'parallel'; key: string } | null {
	const kagi = localStorage.getItem('kagiKey')?.trim();
	const parallel = localStorage.getItem('parallelKey')?.trim();
	const pref = localStorage.getItem(`${kind}Provider`);
	if (pref === 'parallel' && parallel) return { name: 'parallel', key: parallel };
	if (pref === 'kagi' && kagi) return { name: 'kagi', key: kagi };
	if (kagi) return { name: 'kagi', key: kagi };
	if (parallel) return { name: 'parallel', key: parallel };
	return null;
}

export function searchMode(): 'turbo' | 'basic' | 'advanced' {
	const m = localStorage.getItem('parallelSearchMode');
	if (m === 'turbo' || m === 'basic' || m === 'advanced') return m;
	return 'basic';
}

async function extractKagi(url: string, key: string, signal: AbortSignal): Promise<string> {
	const response = await httpFetch('https://kagi.com/api/v1/extract', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${key}` },
		body: JSON.stringify({ pages: [{ url }] }),
		credentials: 'omit',
		signal
	});
	const json = await response.json();
	if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join('; '));
	return json.data?.[0]?.markdown ?? '';
}

/** https://docs.parallel.ai/api-reference/extract/extract */
async function extractParallel(url: string, key: string, objective: string | undefined, signal: AbortSignal): Promise<string> {
	const response = await httpFetch('https://api.parallel.ai/v1/extract', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-api-key': key },
		body: JSON.stringify({
			urls: [url],
			objective: objective || undefined,
			advanced_settings: { full_content: { max_chars_per_result: EXTRACT_LIMIT } }
		}),
		credentials: 'omit',
		signal
	});
	const json = await response.json();
	if (json.type === 'error') throw new Error(json.error?.message || `request failed (${response.status})`);
	const result = json.results?.[0];
	if (!result) {
		const err = json.errors?.[0];
		throw new Error(err ? `${err.error_type}${err.http_status_code ? ` ${err.http_status_code}` : ''}` : 'no results');
	}
	// Excerpts (objective-focused) are the fallback when full content isn't available
	return result.full_content || (result.excerpts ?? []).join('\n\n[...]\n\n');
}

const WEB_SEARCH_LIMIT = 15000;
const WEB_SEARCH_RESULT_CAP = 15;

type SearchResult = { url: string; title?: string | null; date?: string | null; text: string };

/**
 * Multiple queries produce one merged ranked list rather than a list per query
 * (that's how Parallel works), so the header spells the merge out to stop models
 * hunting for per-query result blocks.
 */
function formatWebSearchResults(queries: string[], provider: string, results: SearchResult[]): string {
	const header = queries.length > 1
		? `(${provider}) merged queries:\n${queries.map(q => `- ${q}`).join('\n')}`
		: `(${provider}) query: ${queries[0]}`;
	if (!results.length) return `No results — ${header}`;
	let total = 0;
	const kept: SearchResult[] = [];
	for (const r of results) {
		const lineLen = r.text.length + (r.title?.length ?? 0) + r.url.length + 20;
		// The first result is always kept, so the limit is a target rather than a guarantee
		if (total + lineLen > WEB_SEARCH_LIMIT && kept.length) break;
		kept.push(r);
		total += lineLen;
		if (kept.length >= WEB_SEARCH_RESULT_CAP) break;
	}
	const more = results.length - kept.length;
	let out = `Search results ${header}\n\n`;
	for (let i = 0; i < kept.length; i++) {
		const r = kept[i];
		out += `${i + 1}. ${r.title || 'Untitled'} — ${r.url}${r.date ? ` (${r.date})` : ''}\n${r.text}\n\n`;
	}
	if (more > 0) out += `(${more} more results omitted)\n`;
	return out.trimEnd();
}

async function searchKagi(query: string, after: string | undefined, key: string, signal: AbortSignal): Promise<SearchResult[]> {
	const response = await httpFetch('https://kagi.com/api/v1/search', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${key}` },
		body: JSON.stringify({
			query,
			workflow: 'search',
			format: 'json',
			filters: after ? { after } : undefined
		}),
		credentials: 'omit',
		signal
	});
	const json = await response.json();
	// Search errors come back under `error`, unlike extract's `errors`
	const errs = json.error ?? json.errors;
	if (errs?.length) throw new Error([errs].flat().map((e: any) => e?.message || e?.code || e).join('; '));
	if (!response.ok) throw new Error(`request failed (${response.status})`);

	const results: SearchResult[] = [];
	for (const r of json.data?.search || []) {
		results.push({ url: r.url, title: r.title, date: r.time, text: r.snippet || '' });
	}
	if (json.data?.direct_answer?.length) {
		for (const a of json.data.direct_answer) {
			results.unshift({ url: a.url || '', title: a.title || 'Direct answer', date: a.time, text: a.snippet || '' });
		}
	}
	return results;
}

async function searchParallel(
	queries: string[],
	objective: string | undefined,
	after: string | undefined,
	key: string,
	sessionId: string | undefined,
	signal: AbortSignal
): Promise<SearchResult[]> {
	const response = await httpFetch('https://api.parallel.ai/v1/search', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-api-key': key },
		body: JSON.stringify({
			search_queries: queries,
			objective: objective || undefined,
			mode: searchMode(),
			session_id: sessionId || undefined,
			advanced_settings: after ? { source_policy: { after_date: after } } : undefined
		}),
		credentials: 'omit',
		signal
	});
	const json = await response.json();
	if (json.type === 'error') throw new Error(json.error?.message || `request failed (${response.status})`);
	if (!response.ok) throw new Error(`request failed (${response.status})`);
	return (json.results || []).map((r: any) => ({
		url: r.url,
		title: r.title,
		date: r.publish_date,
		text: (r.excerpts ?? []).join('\n\n[...]\n\n')
	}));
}

const OBJECTIVE_PARAM = {
	type: 'string',
	description: 'Extract mode only: what you are looking for on the page. May be used to focus the extracted content'
};

const AFTER_PARAM = {
	type: 'string',
	description: 'Optional date (YYYY-MM-DD) limiting results to content published/updated on or after it'
};

const SEARCH_QUERY_PARAM = {
	type: 'string',
	description: 'Search query. Can include Kagi operators such as site:example.com or -site:reddit.com'
};

const SEARCH_QUERIES_PARAM = {
	type: 'array',
	items: { type: 'string' },
	description: '2-3 concise keyword queries, 3-6 words each'
};

const SEARCH_OBJECTIVE_PARAM = {
	type: 'string',
	description: 'The underlying question or goal driving the search. Self-contained enough to convey intent'
};

export const webSearchTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'web_search',
			// description and query params are provider-specific — see updateWebSearchTool
			description: 'Search the web.',
			parameters: {
				type: 'object',
				properties: {
					query: SEARCH_QUERY_PARAM,
					after: AFTER_PARAM
				},
				required: ['query']
			}
		}
	},

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		const provider = utilityProvider('search');
		if (!provider) return { ok: false, reason: 'no_provider', error: 'Error: no search API key configured (set a Kagi or Parallel key in sidebar → Providers)' };
		// Models sometimes send the other provider's query param — accept either shape
		const queries: string[] = Array.isArray(args?.search_queries) ? args.search_queries.filter(Boolean) : [];
		if (!queries.length && args?.query) queries.push(args.query);
		if (!queries.length) return { ok: false, reason: 'invalid_args', error: 'Error: no search query provided' };
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 45000);
		try {
			const results = provider.name === 'parallel'
				? await searchParallel(queries, args.objective, args.after, provider.key, ctx.chatId, controller.signal)
				: await searchKagi(queries.join(' '), args.after, provider.key, controller.signal);
			return { queries, provider: provider.name === 'parallel' ? 'Parallel' : 'Kagi', results };
		} catch (error: any) {
			const timedOut = error.name === 'AbortError';
			return {
				ok: false,
				reason: timedOut ? 'timeout' : 'request_failed',
				error: `Search error: ${timedOut ? 'Request timed out (45s)' : errMsg(error)}`
			};
		} finally {
			clearTimeout(timeoutId);
		}
	},

	format: data => formatWebSearchResults(data.queries, data.provider, data.results) || '(no results)',

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>search <code>{args.query || args.search_queries?.join(' · ')}</code></span>;
	},

	Args: props => {
		const args = props.call.function.arguments as any;
		return (
			<>
				{args.query ? <><span style={{ opacity: '0.6' }}>query </span><span>{args.query}</span></> : null}
				{args.search_queries?.length ? <><span style={{ opacity: '0.6' }}>queries </span><span>{args.search_queries.join(' · ')}</span></> : null}
				{args.objective ? <div style={{ opacity: '0.6' }}>{args.objective}</div> : null}
				{args.after ? <span style={{ opacity: '0.5', 'font-size': '0.85em' }}>after {args.after}</span> : null}
			</>
		);
	},
};

export const fetchUrlTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'fetch_url',
			description: `Read a URL with a GET request.${isTauri ? ' For API calls needing auth headers, another method or a request body, write a script and run it with shell.' : ' Note: some sites may block browser requests due to CORS.'}`,
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'The URL to fetch'
					},
					mode: {
						type: 'string',
						enum: ['raw', 'extract'],
						description: 'raw (default): response body as text, for already raw text, api endpoints etc. extract: returns clean markdown of html webpages.'
					},
					objective: OBJECTIVE_PARAM
				},
				required: ['url']
			}
		}
	},

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		const extract = args?.mode === 'extract';
		const label = extract ? 'Extract' : 'Fetch';
		let provider: { name: 'kagi' | 'parallel'; key: string } | null = null;
		if (extract) {
			provider = extractProvider();
			if (!provider) return { ok: false, reason: 'no_provider', error: 'Error: no extract API key configured (set a Kagi or Parallel key in sidebar → Providers)' };
		}
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30000);
		try {
			if (extract) {
				const md = provider!.name === 'parallel'
					? await extractParallel(args.url, provider!.key, args.objective, controller.signal)
					: await extractKagi(args.url, provider!.key, controller.signal);
				return { mode: 'extract', url: args.url, body: md.slice(0, EXTRACT_LIMIT), truncated: md.length > EXTRACT_LIMIT };
			}
			// Raw mode — plain GET
			const response = await httpFetch(args.url, { credentials: 'omit', signal: controller.signal });
			const text = await response.text();
			return {
				mode: 'raw',
				url: args.url,
				status: response.status,
				statusText: response.statusText,
				body: text.slice(0, FETCH_LIMIT),
				truncated: text.length > FETCH_LIMIT
			};
		} catch (error: any) {
			const timedOut = error.name === 'AbortError';
			return {
				ok: false,
				reason: timedOut ? 'timeout' : 'request_failed',
				error: `${label} error: ${timedOut ? 'Request timed out (30s)' : errMsg(error)}`
			};
		} finally {
			clearTimeout(timeoutId);
		}
	},

	format: data => {
		const body = data.body + (data.truncated ? '\n...[truncated]' : '');
		if (data.mode === 'extract') return body || '(no content extracted)';
		return `Status: ${data.status} ${data.statusText}\n\n${body}`;
	},

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>{args.mode === 'extract' ? 'extract' : 'fetch'} <code>{args.url}</code></span>;
	},

	Args: props => {
		const args = props.call.function.arguments as any;
		return (
			<>
				<span style={{ opacity: '0.6' }}>{args.mode === 'extract' ? 'extract' : 'GET'} </span>
				<span style={{ opacity: '0.8' }}>{args.url}</span>
				{args.mode === 'extract' && args.objective ? <div style={{ opacity: '0.6' }}>{args.objective}</div> : null}
			</>
		);
	},
};

/**
 * `objective` is a Parallel-only feature (Kagi's extract API ignores it), so only
 * advertise it when Parallel is the active extractor. Mutates the shared tool
 * object; call whenever the extract provider or its API keys change.
 */
export function updateFetchUrlTool() {
	const props = (fetchUrlTool.definition.function.parameters as any).properties;
	if (extractProvider()?.name === 'parallel') props.objective = OBJECTIVE_PARAM;
	else delete props.objective;
}

/**
 * The two search backends take different inputs, so only advertise the active
 * one's: Kagi takes a single operator-aware `query`, Parallel takes keyword
 * `search_queries` plus an `objective` used to rank and compress excerpts.
 * Mutates the shared tool object; call whenever the search provider or its keys change.
 */
export function updateWebSearchTool() {
	const params = webSearchTool.definition.function.parameters as any;
	const props = params.properties;

	if (utilityProvider('search')?.name === 'parallel') {
		delete props.query;
		props.search_queries = SEARCH_QUERIES_PARAM;
		props.objective = SEARCH_OBJECTIVE_PARAM;
		params.required = ['search_queries'];
		webSearchTool.definition.function.description = 'Search the web. Returns ranked URLs with excerpts. Give an objective plus 2-3 keyword queries for best results.';
	} else {
		delete props.search_queries;
		delete props.objective;
		props.query = SEARCH_QUERY_PARAM;
		params.required = ['query'];
		webSearchTool.definition.function.description = 'Search the web. Returns ranked URLs with snippets. Supports Kagi operators like site:, -site: and quoted phrases.';
	}
}

updateFetchUrlTool();
updateWebSearchTool();
