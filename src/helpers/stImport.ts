// SillyTavern imports: chat files (.jsonl) and character cards (.png / .json).
// Pure conversion, shared by the app (chat import) and scripts/ (convert_card.ts).
import type { ChatMessage, ChatMeta, Config, Prompt, Role } from './types';
import type { LoreEntry } from './lore';

/** Convert {{macro}} → @@macro for the app's substitution format. */
export function convertSTMacros(content: string): string {
	return content
		.replace(/\{\{(\w+)\}\}/g, '@@$1')
		.replace(/<USER>/gi, '@@user')
		.replace(/<BOT>/gi, '@@char');
}

//#  Chats

interface STExtra {
	reasoning?: string;
	model?: string;
	time_to_first_token?: number;
	reasoning_duration?: number;
}

interface STSwipeInfo {
	gen_started?: string;
	gen_finished?: string;
	extra?: STExtra;
}

interface STMessage extends STSwipeInfo {
	is_user?: boolean;
	is_system?: boolean;
	mes?: string;
	swipes?: string[];
	swipe_id?: number;
	swipe_info?: STSwipeInfo[];
}

interface STChatHeader {
	user_name?: string;
	character_name?: string;
}

function convertSTMessage(m: STMessage): ChatMessage {
	const content = m.swipes?.length ? m.swipes : [m.mes ?? ''];

	// Messages without swipe_info keep their info at the top level
	const infos: STSwipeInfo[] = m.swipe_info?.length ? m.swipe_info : [m];
	const perSwipe = content.map((_, i) => infos[i] ?? {});

	const thinking = perSwipe.map(i => i.extra?.reasoning ?? '');
	const models = perSwipe.map(i => i.extra?.model ?? '');
	const timing = perSwipe.map(i => {
		const t: NonNullable<ChatMessage['timing']>[number] = {};
		const ttft = i.extra?.time_to_first_token;
		const reasoning = i.extra?.reasoning_duration;
		if (ttft != null) t.time_to_first_token = ttft;
		if (reasoning != null) t.reasoning_time = reasoning;
		if (i.gen_started && i.gen_finished) {
			const total = Date.parse(i.gen_finished) - Date.parse(i.gen_started);
			if (!isNaN(total)) t.message_time = Math.max(total - (reasoning ?? 0), 0);
		}
		const started = i.gen_started ? Date.parse(i.gen_started) : NaN;
		if (!isNaN(started)) t.createdAt = started;
		return t;
	});

	const swipeId = m.swipe_id ?? 0;
	const msg: ChatMessage = {
		role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
		content,
		currentVersionIndex: swipeId < content.length ? swipeId : 0,
	};
	if (thinking.some(t => t !== '')) msg.thinking = thinking;
	if (models.some(x => x !== '')) msg.models = models;
	if (timing.some(t => Object.keys(t).length > 0)) msg.timing = timing;
	return msg;
}

/**
 * A SillyTavern chat (.jsonl: a header line, then one message per line).
 * Swipes become message versions; per-swipe reasoning, model and timing are kept.
 * The header's names become the `user` and `char` macros.
 */
export function parseSTChat(text: string): { messages: ChatMessage[]; meta: Partial<ChatMeta> } {
	const entries = text.split('\n').flatMap((line, i): (STMessage & STChatHeader)[] => {
		if (!line.trim()) return [];
		try {
			return [JSON.parse(line)];
		} catch {
			throw new Error(`Line ${i + 1} is not valid JSON, so this is not a SillyTavern chat file`);
		}
	});

	const header = entries[0] && !('mes' in entries[0]) && !('swipes' in entries[0]) ? entries.shift() : undefined;
	if (!entries.length) throw new Error('File contains no messages');
	if (!entries.every(e => typeof e.mes === 'string' || Array.isArray(e.swipes)))
		throw new Error('Not a SillyTavern chat file: messages need a "mes" field');

	const macros: Record<string, string> = {};
	if (header?.character_name) macros.char = header.character_name;
	if (header?.user_name) macros.user = header.user_name;
	return { messages: entries.map(convertSTMessage), meta: { macros } };
}

//#  Character cards

/** The fields of a card (V1 flat, V2 and V3 `data`) that this converter uses. */
export interface STCard {
	name: string;
	description?: string;
	personality?: string;
	scenario?: string;
	first_mes?: string;
	mes_example?: string;
	system_prompt?: string;
	post_history_instructions?: string;
	alternate_greetings?: string[];
	character_book?: {
		entries?: { name?: string; comment?: string; keys?: string[]; content?: string }[];
	};
}

/** The card JSON in a PNG: base64 in a tEXt chunk keyed `ccv3` (V3) or `chara` (V1/V2). */
export function cardFromPng(png: Uint8Array): unknown {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const latin1 = new TextDecoder('latin1');
	const found: Record<string, string> = {};
	for (let at = 8; at + 8 <= png.length;) {
		const length = view.getUint32(at);
		const type = latin1.decode(png.subarray(at + 4, at + 8));
		if (type === 'tEXt') {
			const data = png.subarray(at + 8, at + 8 + length);
			const nul = data.indexOf(0);
			found[latin1.decode(data.subarray(0, nul))] = latin1.decode(data.subarray(nul + 1));
		}
		at += 12 + length;
	}
	const encoded = found.ccv3 ?? found.chara;
	if (!encoded) throw new Error('No character data in this PNG (expected a "chara" or "ccv3" text chunk)');
	return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))));
}

export function parseSTCard(raw: unknown): STCard {
	const root = raw as { data?: unknown } | null;
	const card = (root && typeof root.data === 'object' ? root.data : raw) as Partial<STCard> | null;
	if (!card || typeof card.name !== 'string') throw new Error('Not a character card: no "name" field');
	return card as STCard;
}

export interface ConvertedCard {
	/** Import in the config menu (sidebar → Config → Import). */
	config: Config;
	/** Greeting and alternates as versions of one assistant message, plus the `char` and `user` macros. Import with the top bar's upload button. */
	chat: { messages: ChatMessage[]; configName: string; macros: Record<string, string> };
	/** From the card's embedded lorebook; empty when it has none. */
	lore: LoreEntry[];
}

/**
 * `mes_example` as chat turns: blocks split by `<START>`, turns started by a `{{user}}:` or `{{char}}:` line.
 * Without any such line the text stays one system prompt.
 */
function exampleChatPrompts(card: STCard): Prompt[] {
	const example = card.mes_example?.trim();
	if (!example) return [];

	const speaker = new RegExp(`^\\s*(\\{\\{user\\}\\}|<USER>|\\{\\{char\\}\\}|<BOT>|${card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*:\\s?(.*)$`, 'i');
	const blocks = example.split(/<START>/i).map(block => {
		const turns: { role: Role; lines: string[] }[] = [];
		for (const line of block.split('\n')) {
			const match = speaker.exec(line);
			if (match) turns.push({ role: /user/i.test(match[1]!) ? 'user' : 'assistant', lines: [match[2]!] });
			else turns.at(-1)?.lines.push(line);
		}
		return turns;
	}).filter(turns => turns.length);

	const system = (name: string, content: string): Prompt => ({ name, content, role: 'system', position: 0, enabled: true });
	if (!blocks.length) return [system('Example messages', `Example messages:\n${convertSTMacros(example)}`)];

	return [
		...blocks.flatMap((turns, b) => [
			system(`Example ${b + 1}`, '[Example chat]'),
			...turns.map((turn, t): Prompt => ({
				name: `Example ${b + 1}.${t + 1}`,
				content: convertSTMacros(turn.lines.join('\n').trim()),
				role: turn.role,
				position: 0,
				enabled: true,
			})),
		]),
		system('End of examples', '[Start a new chat]'),
	];
}

export function convertSTCard(card: STCard, userName = 'User'): ConvertedCard {
	const section = (label: string | undefined, text: string | undefined) => {
		const body = convertSTMacros(text?.trim() ?? '');
		return body && label ? `${label}:\n${body}` : body;
	};
	const prompt = (name: string, content: string, position = 0): Prompt[] =>
		content ? [{ name, content, role: 'system', position, enabled: true }] : [];

	const prompts = [
		...prompt('System prompt', section(undefined, card.system_prompt)),
		...prompt('Description', section(undefined, card.description)),
		...prompt('Personality', section('Personality', card.personality)),
		...prompt('Scenario', section('Scenario', card.scenario)),
		...exampleChatPrompts(card),
		...prompt('Post-history instructions', section(undefined, card.post_history_instructions), -1),
	];

	const fillNames = (text: string) => text.replace(/\{\{char\}\}|<BOT>/gi, card.name).replace(/\{\{user\}\}|<USER>/gi, userName);
	const greetings = [card.first_mes, ...(card.alternate_greetings ?? [])].filter((g): g is string => !!g?.trim()).map(fillNames);
	const messages: ChatMessage[] = greetings.length ? [{ role: 'assistant', content: greetings, currentVersionIndex: 0 }] : [];

	const used = new Set<string>();
	const lore = (card.character_book?.entries ?? []).flatMap((entry, i): LoreEntry[] => {
		if (!entry.content?.trim()) return [];
		const base = entry.name || entry.comment || entry.keys?.[0] || `Entry ${i + 1}`;
		let name = base;
		for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
		used.add(name);
		return [{ name, description: entry.keys?.length ? `Keys: ${entry.keys.join(', ')}` : '', content: convertSTMacros(entry.content) }];
	});

	return {
		config: { name: card.name, prompts },
		chat: { messages, configName: card.name, macros: { char: card.name, user: userName } },
		lore,
	};
}

/** Whether parsed JSON is a character card rather than one of the app's chat files. */
export function isSTCard(raw: unknown): boolean {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'messages' in raw) return false;
	const { data, name } = raw as { data?: { name?: unknown }; name?: unknown };
	return typeof (data?.name ?? name) === 'string';
}
