import { Setter } from "solid-js";
import type { ChatMessage } from './types';
import { getMessageContent } from './messages';
import { LoreEntry, readLoreEntries } from "./lore";
import { vitalBuckets, matchVitalTopic, pickTopics, wordList, pickWords } from './tools/pools';
export { playSound } from './sounds';

export function loadFromStorage<T>(key: string, defaultValue: T, parseJson: boolean = true, onError?: Setter<string | null>): T {
	try {
		const stored = localStorage.getItem(key);
		if (!stored) return defaultValue;
		
		if (parseJson) {
			const result = JSON.parse(stored) as T;
			// Treat parsed falsy values (null, undefined, "") as missing — but preserve
			// legitimate falsy primitives like false and 0.
			if (!result && result !== false && result !== 0) return defaultValue;
			return result;
		}
		else return stored as unknown as T;
		
	} catch (error) {
		const msg = `Failed to parse ${key} from localStorage: ` + (error instanceof Error ? error.message : String(error));
		console.error(msg, error);
		onError?.(msg);
		if (error instanceof SyntaxError) {
			localStorage.removeItem(key);
		}
		return defaultValue;
	}
}

export function d_txt(content: string, filename: string, type = 'text/plain') {
	const blob = new Blob([content], { type });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

export function reLore(content: string, messages: ChatMessage[], lore: LoreEntry[]) {
	// Match @name, @[name with spaces], @ref[name with spaces], @ref 123 (for message refs)
	const entries = content.match(/@(?:ref\s*)?(?:\[[^\]]*\]|[\w+\/\-]+)/g)?.map(m => m.slice(1));
	let toShow = false;

	const results = [...new Set(entries)]?.map(entry => {
		// Handle @ref <number> for message references
	if (/^ref\s*\d+$/i.test(entry) && messages[Number(entry.match(/\d+/)![0])]) {
			toShow = true;
			const msgContent = getMessageContent(messages[Number(entry.match(/\d+/)![0])])
				.split('\n')
				.map(line => `> ${line}`)
				.join('\n');

			return `The user has referenced past message ${entry}. This is for reference, it is not from the current scene.\n\n${msgContent}`;
		}

		// Strip brackets and optional 'ref' prefix for lookup
		const cleanEntry = entry.replace(/^ref\s*/, '').replace(/^\[|\]$/g, '');

		// Find lore entry by name (exact match or prefix match)
		const matchedEntries = readLoreEntries(lore, [{ name: cleanEntry }]);
		if (matchedEntries.length > 0) {
			return matchedEntries.map(e => 
				`<lore name="${e.name}"${e.description ? ` description="${e.description}"` : ''}>\n${e.content}\n</lore>`
			).join('\n\n');
		}

		return null;
	}).filter(Boolean);

	if (toShow && entries?.length && !results?.length)
		return `<lore>\nNo lore entries found for: ${entries.join(', ')}\n</lore>`;
	if (!results?.length) return null;

	const message = results.length === 1 ? results[0] : results.join('\n\n---\n\n');
	return `(auto tool response, not an actual user message)\n\n${message}`;
}

/** Macro keys derived from the environment (agents.md, skill folders) rather than typed by
 *  the user — never persisted with the chat, always re-scanned. */
export const DERIVED_MACROS = ['agents', 'local_skills', 'global_skills', 'widgets'];

export function msgVars(content: string, macros?: Record<string, string>, model?: string, chatFolder?: string, chatId?: string): string {

	const topics = vitalBuckets();
	if (topics)
		content = content.replace(/@@topic\b(?::([a-z]+))?/gi, (match, prefix?: string) => {
			const category = prefix ? matchVitalTopic(prefix) : undefined;
			if (prefix && !category) return match;
			return pickTopics(topics, 1, category)[0] ?? match;
		});
	const words = wordList();

	if (words)
		content = content.replace(/@@word\b/gi, () => pickWords(words, 1)[0] ?? '@@word');
	
	let result = content
		.replace(/@@time/ig, new Date().toLocaleTimeString())
		.replace(/@@date/ig, new Date().toLocaleDateString())
		.replace(/@@model/ig, model || '')
		.replace(/@@folder/ig, chatFolder || '')
		.replace(/@@id/ig, chatId || '');

	if (macros) {
		for (const [k, v] of Object.entries(macros)) {
			if (!k) continue;
			const re = new RegExp(`@@${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
			result = result.replace(re, v);
		}
	}
	
	return result;
}
