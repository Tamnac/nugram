/**
 * Widget state: one JSON value per (chat, instance id), saved by the widget with `widgetSave`
 * and handed back as `widgetState` when the frame loads. Kept in memory in front of the
 * `widget_state` table (desktop only), with writes delayed so a widget that saves on every
 * keystroke doesn't write on every keystroke. Design: mds/widgets-mvp.md
 *
 * Values are JSON text, so what the widget saved is what it gets back. `null` means no state.
 */
import { isTauri } from './platform';

export const MAX_WIDGET_STATE = 1_000_000;
const WRITE_DELAY_MS = 500;

export interface WidgetStateIO {
	load(chatId: string, id: string): Promise<string | null>;
	save(chatId: string, id: string, json: string): Promise<void>;
}

const dbIO: WidgetStateIO = {
	async load(chatId, id) {
		if (!isTauri) return null;
		const db = await import('./db');
		await db.initDatabase();
		return db.loadWidgetState(chatId, id);
	},
	async save(chatId, id, json) {
		if (!isTauri) return;
		const db = await import('./db');
		await db.initDatabase();
		await db.saveWidgetState(chatId, id, json);
	},
};

let io = dbIO;

interface Entry { chatId: string; id: string; json: string | null; pending: boolean; timer?: ReturnType<typeof setTimeout> | undefined }

const entries = new Map<string, Entry>();

const keyOf = (chatId: string, id: string) => `${chatId}\u0000${id}`;

/** @internal Replace the storage and forget everything held in memory, for tests. */
export function _resetWidgetStateForTesting(next: WidgetStateIO = dbIO) {
	for (const entry of entries.values()) clearTimeout(entry.timer);
	entries.clear();
	io = next;
}

async function read(chatId: string, id: string): Promise<string | null> {
	const key = keyOf(chatId, id);
	const known = entries.get(key);
	if (known) return known.json;
	const json = await io.load(chatId, id).catch(e => {
		console.warn(`widget ${id}: failed to load its state:`, e);
		return null;
	});
	// A save that arrived while loading is newer
	const current = entries.get(key);
	if (current) return current.json;
	entries.set(key, { chatId, id, json, pending: false });
	return json;
}

async function writeNow(entry: Entry) {
	clearTimeout(entry.timer);
	entry.timer = undefined;
	if (!entry.pending || entry.json === null) return;
	entry.pending = false;
	try {
		await io.save(entry.chatId, entry.id, entry.json);
	} catch (e) {
		console.warn(`widget ${entry.id}: failed to save its state:`, e);
	}
}

function put(chatId: string, id: string, json: string, immediately = false) {
	const key = keyOf(chatId, id);
	const entry = entries.get(key) ?? { chatId, id, json, pending: false };
	entries.set(key, entry);
	entry.json = json;
	entry.pending = true;
	if (immediately) void writeNow(entry);
	else entry.timer ??= setTimeout(() => void writeNow(entry), WRITE_DELAY_MS);
}

/**
 * The instance's saved state as JSON text, or null. An instance that inherits another and has
 * no state yet (and isn't `fresh`) starts as a copy of the other's current state; that first
 * load is written down even when empty, so later saves of the other instance don't leak in.
 */
export async function loadWidgetState(chatId: string, id: string, inherit?: string, mode: 'copy' | 'fresh' = 'copy'): Promise<string | null> {
	const json = await read(chatId, id);
	if (json !== null || !inherit || inherit === id) return json;
	const copied = mode === 'fresh' ? null : await read(chatId, inherit);
	put(chatId, id, copied ?? 'null', true);
	return copied;
}

/** Replace the instance's state. Throws when `json` isn't JSON or is over the size limit. */
export function saveWidgetState(chatId: string, id: string, json: string) {
	if (json.length > MAX_WIDGET_STATE) throw new Error(`widgetSave: the state is ${json.length} characters as JSON, over the limit of ${MAX_WIDGET_STATE}`);
	try {
		JSON.parse(json);
	} catch {
		throw new Error('widgetSave: the state is not valid JSON');
	}
	put(chatId, id, json);
}

/** Clear the state. `null` is stored rather than deleting the row, so an inheriting instance doesn't copy again. */
export function resetWidgetState(chatId: string, id: string) {
	put(chatId, id, 'null', true);
}

/** Write pending saves now: for one chat (it is closing) or for all of them. */
export function flushWidgetStates(chatId?: string): Promise<unknown> {
	return Promise.all([...entries.values()].filter(e => chatId === undefined || e.chatId === chatId).map(writeNow));
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => void flushWidgetStates());
