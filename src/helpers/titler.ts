import type { ChatMessage, Options, Provider, ProviderConfig, TitlerSettings } from './types';
import { streamChatCompletion } from './streaming';
import { messagesToMarkdown } from './transcript';

/** Output cap for a title; the samplers' max_tokens overrides it. */
export const TITLER_MAX_TOKENS = 64;

// Generates a short chat title by sending a preview transcript to the configured
// titler model. Uses streamChatCompletion but only collects the content and
// returns it when done. Returns a cleaned single-line title, or throws on error.
export async function generateTitle(opts: {
	messages: ChatMessage[];
	settings: TitlerSettings;
	providers: Record<Provider, ProviderConfig>;
	signal?: AbortSignal;
}): Promise<string> {
	const { messages, settings, providers } = opts;
	if (!settings.model.trim()) throw new Error('No titler model configured');
	if (!messages.length) throw new Error('Nothing to title');

	const provider = providers[settings.provider];
	if (!provider) throw new Error(`Unknown titler provider: ${settings.provider}`);

	const transcript = messagesToMarkdown(messages, 'preview');
	const reqMessages = [
		{ role: 'system', content: settings.prompt },
		{ role: 'user', content: `<transcript>\n${transcript}\n</transcript>\n\nplease write a title` },
	];

	const requestOptions: Options = {
		stream: true,
		max_tokens: TITLER_MAX_TOKENS,
		...settings.samplers,
		...(settings.reasoning && { reasoning: settings.reasoning }),
	};

	let content = '';
	let error: string | undefined;
	const result = await streamChatCompletion(
		settings.model,
		reqMessages,
		requestOptions,
		provider.apiKey,
		'Nugram',
		opts.signal ?? new AbortController().signal,
		settings.provider,
		provider.url,
		provider.apiType,
		c => { content += c; },
		undefined,
		e => { error = e; },
		undefined,
		undefined,
		{}, // no tools
	);
	if (!result.success) throw new Error(error || result.error || 'Title generation failed');

	return cleanTitle(content);
}

// Strip surrounding quotes/whitespace and collapse to a single line.
function cleanTitle(raw: string): string {
	let t = raw.trim().replace(/\s*\n\s*/g, ' ').trim();
	t = t.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '').trim();
	return t;
}
