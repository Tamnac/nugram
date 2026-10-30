/**
 * SQLite database layer for Tauri desktop builds.
 * Only dynamically imported when running on Tauri — web builds never touch this file.
 *
 * Uses @tauri-apps/plugin-sql with the "sqlite" driver.
 * Schema migrations are defined in src-tauri/src/lib.rs and run automatically
 * when the database is loaded via the plugin's preload config.
 *
 * Messages have a stable autoincrement `id` (used for identity) and an `idx`
 * column (used for sort order within a chat). A chat owns all of its rows; forks
 * and duplicates are copies.
 */

import type { ChatMessage, ChatMeta, FileAttachment } from './types';
import { normalizeMessage, messageStorage } from './storage';
import { buildSnippet, headSnippet, ftsQuery, ftsTerms } from './search';
import { FORK_MIGRATION_SQL, FORK_MIGRATION_VERSION } from './forkMigration';

// ── Types ──────────────────────────────────────────────────────────────

export interface Chat {
	id: string;
	name: string;
	config_name: string | null;
	meta: string | null; // JSON blob of ChatMeta (minus configName, chatFolder, backend which have own columns)
	chat_folder: string | null;
	backend: string | null; // null = local
	tags: string[];
	/** Chat this one was forked from or spawned by (sub-agents). Display grouping only. */
	parent_id: string | null;
	/**
	 * Set on forks only (null on sub-agent chats): id of the message the fork was
	 * taken at, in the chat it was forked from. Informational — that message, or
	 * the whole chat (when `parent_id` has since moved up past a deleted one), may
	 * be gone.
	 */
	fork_message_id: number | null;
	created: number;
	updated: number;
	version: number; // optimistic-concurrency counter, bumped on every write
}

/**
 * Thrown when a guarded write is attempted with a stale `expectedVersion` —
 * i.e. another view/process modified the chat since this one loaded it.
 * Detected by callers via the `code === 'CONFLICT'` property (avoids pulling
 * this module into the web bundle just for an instanceof check).
 */
declare const __PROJECT_DIR__: string;

export class ConcurrencyError extends Error {
	readonly code = 'CONFLICT' as const;
	constructor(public readonly chatId: string, public readonly expectedVersion: number) {
		super(`Chat ${chatId} was modified elsewhere (expected version ${expectedVersion})`);
		this.name = 'ConcurrencyError';
	}
}

interface MessageRow {
	id: number; // autoincrement, stable identity
	chat_id: string;
	idx: number; // sort order
	role: string;
	content: string;
	current_version: number;
	thinking: string | null;
	thinking_signature: string | null;
	reasoning_enc: string | null;
	tool_calls: string | null;
	tool_results: string | null;
	tool_call_id: string | null;
	ids: string | null;
	images: string | null;
	files: string | null;
	name: string | null;
	models: string | null;
	providers: string | null;
	usage: string | null;
	timing: string | null;
}

/** Row columns holding JSON text, decoded by `selectRows`. */
const JSON_COLUMNS = [
	'content', 'thinking', 'thinking_signature', 'reasoning_enc', 'tool_calls', 'tool_results', 'tool_call_id',
	'ids', 'models', 'providers', 'usage', 'timing', 'images', 'files',
] as const;

type JsonColumn = (typeof JSON_COLUMNS)[number];

/** A `messages` row with its JSON columns already decoded (`content` is NOT NULL). */
type MessageRowParsed = Omit<MessageRow, JsonColumn>
	& { [K in JsonColumn]: ChatMessage[K] | null }
	& Pick<ChatMessage, 'content'>;

// ── Database singleton ─────────────────────────────────────────────────

let db: any = null;
let dbUrl: string | null = null;
let currentChatId: string | null = null;
let initPromise: Promise<void> | null = null;

let coreApi: Promise<typeof import('@tauri-apps/api/core')> | null = null;
const core = () => (coreApi ??= import('@tauri-apps/api/core'));

function generateId(): string {
	return crypto.randomUUID();
}

/** @internal Inject a DB driver for testing. Resets all module state. */
export function _initForTesting(testDb: any): void {
	db = testDb;
	dbUrl = null;
	currentChatId = null;
	initPromise = Promise.resolve();
}

/**
 * Full-text index over `messages.content`, kept in sync by triggers.
 *
 * External-content FTS5 (`content='messages'`) stores only the index, not a copy
 * of the text. `content` is a JSON array of versions, but the unicode61 tokenizer
 * splits on non-word chars, so the JSON punctuation simply doesn't produce tokens
 * — every version ends up searchable, which `searchMessagesFTS` accounts for when
 * building snippets.
 *
 * Exported so tests can apply the exact same schema.
 */
export const FTS_SCHEMA = [
	`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
		content,
		content='messages', content_rowid='id',
		tokenize='unicode61 remove_diacritics 2'
	)`,
	`CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
		INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
	END`,
	`CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
		INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
	END`,
	`CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
		INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
		INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
	END`,
];

/**
 * Table definitions, applied by `initDatabase` and reused verbatim by the tests so
 * they can't drift from what ships. Column additions belong here *and* in a Rust
 * migration (src-tauri/src/lib.rs), plus an ALTER below for databases already created.
 */
export const CORE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS chats (
		id               TEXT PRIMARY KEY,
		name             TEXT NOT NULL DEFAULT 'New Chat',
		config_name      TEXT,
		meta             TEXT,
		chat_folder      TEXT,
		backend          TEXT,
		parent_id        TEXT REFERENCES chats(id) ON DELETE SET NULL,
		fork_message_id  INTEGER,
		created          INTEGER NOT NULL,
		updated          INTEGER NOT NULL,
		version          INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS messages (
		id                INTEGER PRIMARY KEY AUTOINCREMENT,
		chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
		idx               INTEGER NOT NULL,
		role              TEXT NOT NULL,
		content           TEXT NOT NULL,
		current_version   INTEGER NOT NULL DEFAULT 0,
		thinking          TEXT,
		thinking_signature TEXT,
		reasoning_enc     TEXT,
		tool_calls        TEXT,
		tool_results      TEXT,
		tool_call_id      TEXT,
		ids               TEXT,
		name              TEXT,
		models            TEXT,
		providers         TEXT,
		usage             TEXT,
		timing            TEXT,
		images            TEXT,
		files             TEXT,
		origin_id         INTEGER,
		UNIQUE (chat_id, idx)
	)`,
	`CREATE TABLE IF NOT EXISTS attachments (
		id      TEXT PRIMARY KEY,
		mime    TEXT NOT NULL,
		data    TEXT NOT NULL,
		created INTEGER NOT NULL
	)`,
	// Live app instances. Each process keeps its row fresh; a restore refuses to
	// overwrite the database file while anyone else still has it open.
	`CREATE TABLE IF NOT EXISTS sessions (
		id    TEXT PRIMARY KEY,
		seen  INTEGER NOT NULL
	)`,
	// Chat tags. Join table (not a chats column) so scoping joins into queries;
	// NOCASE collation makes the PK and equality checks case-insensitive.
	`CREATE TABLE IF NOT EXISTS chat_tags (
		chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
		tag     TEXT NOT NULL COLLATE NOCASE,
		PRIMARY KEY (chat_id, tag)
	)`,
	`CREATE INDEX IF NOT EXISTS chat_tags_tag ON chat_tags(tag)`,
	// Keeps the backup change probe (and the most-recent-chat lookup) off the wide
	// rows — scanning `meta` blobs to answer count/max is what makes it expensive.
	`CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated)`,
];

/** Rebuild the full-text index from scratch. */
export async function rebuildFTS(): Promise<void> {
	await db.execute(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
}

export const DB_FILE = 'story.db';

let dbDir: string | null = null;

/**
 * Directory holding the database file: the project root in dev, the app config
 * dir (where the sql plugin resolves relative paths) in prod.
 */
export async function getDbDir(): Promise<string> {
	if (dbDir) return dbDir;
	if (import.meta.env.DEV) return dbDir = __PROJECT_DIR__;
	const { appConfigDir } = await import('@tauri-apps/api/path');
	return dbDir = (await appConfigDir()).replace(/[\\/]+$/, '');
}

/**
 * Write a consistent snapshot of the whole database to `path`. WAL content included.
 */
export async function vacuumInto(path: string): Promise<void> {
	await initDatabase();
	await db.execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}

/**
 * Renames and metadata saves deliberately touch neither `updated` nor `version`
 * (see saveChatMeta), so the SQL probe below can't see them. Counting them costs
 * nothing, where noticing them in SQL would mean summing text lengths — ~17× the
 * probe's cost at a few thousand chats.
 *
 * Kept in localStorage rather than a module variable so every window agrees on
 * the count; a per-process counter would make each instance read the others'
 * stamps as changed and back up on its own schedule. Belongs to backup.ts (see
 * its bookkeeping prefix), which is the only reader.
 */
const QUIET_KEY = 'db_backup_quiet_writes';

function noteQuietWrite(): void {
	localStorage.setItem(QUIET_KEY, String(Number(localStorage.getItem(QUIET_KEY) || 0) + 1));
}

/**
 * Cheap fingerprint of the database's contents, used to skip backups when
 * nothing happened. File mtime can't serve here — under WAL the main file sits
 * untouched between checkpoints.
 *
 * Deliberately limited to columns covered by `chats_updated`, so it reads a
 * small covering index instead of every row's `meta` blob.
 */
export async function changeStamp(): Promise<string> {
	await initDatabase();
	const rows: { chats: number; updated: number | null }[] = await db.select(
		'SELECT count(*) as chats, max(updated) as updated FROM chats'
	);
	const r = rows[0];
	return `${r?.chats ?? 0}:${r?.updated ?? 0}:${localStorage.getItem(QUIET_KEY) ?? 0}`;
}

// ── Instance presence ────────────────────────────────────────────

/**
 * Every app window is its own OS process with its own connection pool, so
 * closing the database here says nothing about the file being free. The one
 * thing all instances share is the database itself, so presence lives there:
 * each marks a row while it runs, and a restore refuses to overwrite the file
 * while anyone else's mark is fresh.
 */
export const SESSION_ID = crypto.randomUUID();
const SESSION_TTL = 90_000;

/** Announce this instance / keep its mark fresh, sweeping marks left by crashed ones. */
export async function markSession(): Promise<void> {
	await initDatabase();
	const now = Date.now();
	await db.execute(
		'INSERT INTO sessions (id, seen) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET seen = $2',
		[SESSION_ID, now]
	);
	await db.execute('DELETE FROM sessions WHERE seen < $1', [now - 10 * SESSION_TTL]);
}

export async function endSession(): Promise<void> {
	if (!db) return;
	await db.execute('DELETE FROM sessions WHERE id = $1', [SESSION_ID]);
}

/** How many *other* instances have checked in recently. */
export async function otherSessions(): Promise<number> {
	await initDatabase();
	const rows: { n: number }[] = await db.select(
		'SELECT count(*) as n FROM sessions WHERE id != $1 AND seen > $2',
		[SESSION_ID, Date.now() - SESSION_TTL]
	);
	return rows[0]?.n ?? 0;
}

export async function initDatabase(): Promise<void> {
	if (initPromise) return initPromise;

	initPromise = (async () => {
		const Database = (await import('@tauri-apps/plugin-sql')).default;

		// Dev: store DB in the project directory for easy access.
		// Prod: default AppData location.
		const dbPath = import.meta.env.DEV
			? `sqlite:${__PROJECT_DIR__}/${DB_FILE}`
			: `sqlite:${DB_FILE}`;

		db = await Database.load(dbPath);
		dbUrl = dbPath;

		// Performance & safety pragmas
		await db.execute('PRAGMA journal_mode = WAL');
		await db.execute('PRAGMA foreign_keys = ON');
		await db.execute('PRAGMA synchronous = NORMAL');  // safe with WAL, skips extra fsync
		await db.execute('PRAGMA busy_timeout = 5000');
		await db.execute('PRAGMA cache_size = -8000');    // 16MB page cache
		await db.execute('PRAGMA temp_store = MEMORY');
		await db.execute('PRAGMA mmap_size = 268435456'); // 256MB memory-mapped I/O

		// Ensure schema exists. Idempotent — safe even if Rust migrations already ran.
		// Needed because Rust migrations are keyed to a specific connection string
		// which may differ from the one we use (e.g. absolute path in dev mode).
		for (const stmt of CORE_SCHEMA) await db.execute(stmt);
		// Column additions for databases created before them
		await db.execute('ALTER TABLE chats ADD COLUMN config_name TEXT').catch(() => {});
		await db.execute('ALTER TABLE chats ADD COLUMN meta TEXT').catch(() => {});
		await db.execute('ALTER TABLE chats ADD COLUMN chat_folder TEXT').catch(() => {});
		await db.execute('ALTER TABLE chats ADD COLUMN backend TEXT').catch(() => {});
		await db.execute('ALTER TABLE chats ADD COLUMN version INTEGER NOT NULL DEFAULT 0').catch(() => {});
		await db.execute('ALTER TABLE messages ADD COLUMN images TEXT').catch(() => {});
		await db.execute('ALTER TABLE messages ADD COLUMN files TEXT').catch(() => {});
		await db.execute('ALTER TABLE messages ADD COLUMN providers TEXT').catch(() => {});
		await db.execute('ALTER TABLE messages ADD COLUMN reasoning_enc TEXT').catch(() => {});
		await db.execute('ALTER TABLE messages ADD COLUMN origin_id INTEGER').catch(() => {});

		// Full-text index over message content (global search).
		for (const stmt of FTS_SCHEMA) await db.execute(stmt);
		// Backfill on first run (or after the table was added to an existing DB).
		// Counting messages_fts itself would read through to the content table and
		// always report the unindexed rows; the shadow docsize table holds one row
		// per indexed document, so comparing the two also repairs a partially built
		// index (e.g. a crash mid-rebuild) rather than only a completely empty one.
		const [indexed, msgs] = await Promise.all([
			db.select('SELECT count(*) as count FROM messages_fts_docsize') as Promise<{ count: number }[]>,
			db.select('SELECT count(*) as count FROM messages') as Promise<{ count: number }[]>,
		]);
		if ((indexed[0]?.count || 0) !== (msgs[0]?.count || 0)) await rebuildFTS();

		// After the full-text triggers exist, so the rows it adds get indexed.
		await materializeForks(async () => {
			const { backupBeforeMigration } = await import('./backup');
			await backupBeforeMigration(path => db.execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`));
		});
	})();

	return initPromise;
}

/**
 * Convert pointer forks into plain copies, once per database file (see
 * forkMigration.ts for what and how). Runs from `initDatabase` rather than as a
 * Rust migration: those only run for the `sqlite:story.db` URL, which dev builds
 * don't use, and only on the first load in a process, so a restored backup would
 * stay unconverted until the app was restarted.
 *
 * `snapshot` runs only when there is something to convert, before anything is
 * touched. A failed snapshot is logged, not fatal: the conversion is atomic.
 */
export async function materializeForks(snapshot?: () => Promise<void>): Promise<void> {
	const [{ v }]: { v: number }[] = await db.select('SELECT user_version AS v FROM pragma_user_version');
	if (v >= FORK_MIGRATION_VERSION) return;

	const [{ n }]: { n: number }[] = await db.select(
		'SELECT COUNT(*) AS n FROM chats WHERE parent_id IS NOT NULL AND fork_message_id IS NOT NULL'
	);
	if (n === 0) {
		await db.execute(`PRAGMA user_version = ${FORK_MIGRATION_VERSION}`);
		return;
	}

	try { await snapshot?.(); }
	catch (e) { console.warn('Could not back up the database before converting forks:', e); }

	try {
		await db.execute(FORK_MIGRATION_SQL);
	} catch (e) {
		// The pool gives no say over which connection runs a statement, and the one that
		// ran the script may still hold its transaction (and the write lock). Send a
		// burst so every idle connection gets one; those with nothing open just fail.
		await Promise.allSettled(Array.from({ length: 8 }, () => db.execute('ROLLBACK')));
		throw e;
	}
}

// ── Current chat management ────────────────────────────────────────────

/**
 * Get the current chat ID. If none is set, finds the most recent chat
 * or creates a new one.
 */
export async function getCurrentChatId(): Promise<string> {
	if (currentChatId) return currentChatId;
	if (!db) await initDatabase();

	// Try to get the last used chat from localStorage
	// (migrate from the old 'current_chat_id' key written by older builds)
	const stored = localStorage.getItem('last_chat_id') ?? localStorage.getItem('current_chat_id');
	if (stored) {
		const id = stored;
		const chatRows: Chat[] = await db.select(
			'SELECT id FROM chats WHERE id = $1', [id]
		);
		if (chatRows.length > 0) {
			currentChatId = id;
			localStorage.setItem('last_chat_id', id);
			return id;
		}
	}

	// Get most recent chat
	const chatRows: Chat[] = await db.select(
		'SELECT id FROM chats ORDER BY updated DESC LIMIT 1'
	);
	if (chatRows.length > 0) {
		currentChatId = chatRows[0].id;
		localStorage.setItem('last_chat_id', currentChatId);
		return currentChatId!;
	}

	// No chats exist — create a default one
	return createChat('Chat');
}

/**
 * Set the active chat for this view. `persist` writes `last_chat_id`, the
 * fallback a fresh window opens to. A window opened explicitly with `?chat=<id>`
 * should pass `persist = false` so it doesn't hijack that shared fallback.
 */
export function setCurrentChatId(id: string, persist = true): void {
	currentChatId = id;
	if (persist) localStorage.setItem('last_chat_id', id);
}

// ── Chat CRUD ──────────────────────────────────────────────────────────

/**
 * Create a chat. `makeCurrent = false` skips claiming the "last opened" slot —
 * used by background agent chats so they don't steal it from the visible chat.
 * `parentId` records a parent link with `fork_message_id` NULL — used to nest
 * sub-agent chats under the chat that spawned them (forks go through `forkChat`).
 */
export async function createChat(name: string = 'New Chat', configName?: string, meta?: string, makeCurrent = true, parentId?: string): Promise<string> {
	const id = generateId();
	const now = Date.now();
	await db.execute(
		'INSERT INTO chats (id, name, config_name, meta, parent_id, created, updated) VALUES ($1, $2, $3, $4, $5, $6, $7)',
		[id, name, configName ?? null, meta ?? null, parentId ?? null, now, now]
	);
	if (makeCurrent) {
		currentChatId = id;
		localStorage.setItem('last_chat_id', id);
	}
	return id;
}

/** Tags column: tab-separated via group_concat, since tags may contain commas. */
const TAGS_SUBQUERY = '(SELECT group_concat(ct.tag, char(9)) FROM chat_tags ct WHERE ct.chat_id = chats.id) as _tags';

function rowWithTags(row: any): Chat {
	const { _tags, ...rest } = row;
	return { ...rest, tags: _tags ? _tags.split('\t') : [] };
}

export async function listChats(): Promise<Chat[]> {
	const rows = await db.select(`SELECT *, ${TAGS_SUBQUERY} FROM chats ORDER BY created DESC`);
	return rows.map(rowWithTags);
}

export async function getChat(id: string): Promise<Chat | null> {
	const rows = await db.select(`SELECT *, ${TAGS_SUBQUERY} FROM chats WHERE id = $1`, [id]);
	return rows[0] ? rowWithTags(rows[0]) : null;
}

export async function renameChat(id: string, name: string): Promise<void> {
	await db.execute(
		'UPDATE chats SET name = $1 WHERE id = $2',
		[name, id]
	);
	noteQuietWrite();
}

/**
 * Delete a chat and its messages. Chats that name it as `parent_id` (forks,
 * sub-agent chats) keep their own messages and move up to its parent, so a
 * fork chain stays grouped in the sidebar. With no parent to move up to they
 * lose the link, and a fork's `fork_message_id` goes with it.
 */
export async function deleteChat(id: string): Promise<void> {
	await db.execute(
		`UPDATE chats
		 SET parent_id = (SELECT p.parent_id FROM chats p WHERE p.id = $1),
		     fork_message_id = CASE WHEN (SELECT p.parent_id FROM chats p WHERE p.id = $1) IS NULL THEN NULL ELSE fork_message_id END
		 WHERE parent_id = $1`,
		[id]
	);

	// CASCADE removes the chat's messages
	await db.execute('DELETE FROM chats WHERE id = $1', [id]);

	if (currentChatId === id) {
		currentChatId = null;
	}
}

/**
 * Copy `chatId`'s tags and messages, optionally only those stored at `idx <= throughIdx`,
 * into `toChatId` (renumbered from 0). Messages move in one statement, so large
 * chats don't pass through JS. `origin` marks the copies as the same messages as
 * their sources (`origin_id`, which search uses to show a message once): forks do,
 * duplicates are deliberate snapshots and don't.
 */
async function copyChatContent(chatId: string, toChatId: string, opts: { throughIdx?: number; origin?: boolean } = {}): Promise<void> {
	await db.execute(
		`INSERT INTO messages (chat_id, idx, ${UPDATE_FIELDS.join(', ')}, origin_id)
		 SELECT $1, rn, ${UPDATE_FIELDS.join(', ')}, ${opts.origin ? 'COALESCE(origin_id, id)' : 'NULL'}
		 FROM (SELECT *, row_number() OVER (ORDER BY idx) - 1 AS rn FROM messages WHERE chat_id = $2 AND idx <= $3)
		 ORDER BY rn`,
		[toChatId, chatId, opts.throughIdx ?? Number.MAX_SAFE_INTEGER]
	);
	await db.execute(
		'INSERT OR IGNORE INTO chat_tags (chat_id, tag) SELECT $1, tag FROM chat_tags WHERE chat_id = $2',
		[toChatId, chatId]
	);
}

/**
 * Duplicate a chat (full message copy, no parent link). Independent snapshot.
 */
export async function duplicateChat(id: string, newName?: string): Promise<string> {
	const chat = await getChat(id);
	if (!chat) throw new Error(`Chat ${id} not found`);

	const newId = generateId();
	const now = Date.now();
	await db.execute(
		// The draft stays with the original
		"INSERT INTO chats (id, name, config_name, meta, chat_folder, backend, created, updated) VALUES ($1, $2, $3, json_remove($4, '$.draft'), $5, $6, $7, $8)",
		[newId, newName || `${chat.name} (copy)`, chat.config_name, chat.meta, chat.chat_folder, chat.backend, now, now]
	);
	await copyChatContent(id, newId);

	return newId;
}

// ── Tags ───────────────────────────────────────────────────────────────

/**
 * Replace a chat's tags. Tags keep the casing of their first occurrence;
 * comparisons are case-insensitive (NOCASE collation), and duplicates that
 * differ only in case collapse into one row.
 */
export async function setChatTags(id: string, tags: string[]): Promise<void> {
	const seen = new Set<string>();
	const unique = tags
		.map(t => t.trim())
		.filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
	await db.execute('DELETE FROM chat_tags WHERE chat_id = $1', [id]);
	for (const tag of unique)
		await db.execute('INSERT OR IGNORE INTO chat_tags (chat_id, tag) VALUES ($1, $2)', [id, tag]);
	noteQuietWrite();
}

/**
 * Tag every chat in a folder (pass '' for chats with no folder). Idempotent.
 * Returns the number of tags applied (already-tagged chats don't count).
 */
export async function tagFolder(folder: string, tag: string): Promise<number> {
	const trimmed = tag.trim();
	if (!trimmed) return 0;
	const res = await db.execute(
		`INSERT OR IGNORE INTO chat_tags (chat_id, tag)
		 SELECT id, $2 FROM chats
		 WHERE ($1 = '' AND (chat_folder IS NULL OR chat_folder = '')) OR chat_folder = $1`,
		[folder, trimmed]
	);
	noteQuietWrite();
	return res.rowsAffected;
}

/** Rename a tag everywhere. Chats that already carry the target name (under
 *  any casing) keep a single row of it. Returns the number of rows updated. */
export async function renameTag(from: string, to: string): Promise<number> {
	const fromTag = from.trim(), toTag = to.trim();
	if (!fromTag || !toTag || fromTag.toLowerCase() === toTag.toLowerCase()) return 0;
	const res = await db.execute(
		'UPDATE OR IGNORE chat_tags SET tag = $2 WHERE tag = $1', [fromTag, toTag]
	);
	// Rows the UPDATE ignored (case-variant of `to` already present) go away
	await db.execute('DELETE FROM chat_tags WHERE tag = $1', [fromTag]);
	noteQuietWrite();
	return res.rowsAffected;
}

/** Remove a tag from every chat that has it. */
export async function deleteTag(tag: string): Promise<void> {
	await db.execute('DELETE FROM chat_tags WHERE tag = $1', [tag.trim()]);
	noteQuietWrite();
}

/**
 * Fork a chat at a given message: a new chat holding a copy of the messages up to
 * and including `forkAtIndex`. `parent_id` / `fork_message_id` only record where
 * it came from — later edits to either chat don't reach the other.
 */
export async function forkChat(id: string, forkAtIndex: number, newName?: string): Promise<string> {
	const chat = await getChat(id);
	if (!chat) throw new Error(`Chat ${id} not found`);

	const boundary: { id: number; idx: number }[] = forkAtIndex >= 0 ? await db.select(
		'SELECT id, idx FROM messages WHERE chat_id = $1 ORDER BY idx LIMIT 1 OFFSET $2', [id, forkAtIndex]
	) : [];
	if (boundary.length === 0) {
		throw new Error(`Fork index ${forkAtIndex} out of range (0..${await getMessageCount(id) - 1})`);
	}

	const newId = generateId();
	const now = Date.now();
	await db.execute(
		// The draft stays with the original
		"INSERT INTO chats (id, name, config_name, meta, chat_folder, backend, parent_id, fork_message_id, created, updated) VALUES ($1, $2, $3, json_remove($4, '$.draft'), $5, $6, $7, $8, $9, $10)",
		[newId, newName || `${chat.name} (fork)`, chat.config_name, chat.meta, chat.chat_folder, chat.backend, id, boundary[0].id, now, now]
	);
	// The plugin's pooled connections can't hold a transaction across calls, so undo by
	// hand: a failed copy, or one that raced a write to the source (the recorded
	// boundary may no longer be the last message copied), leaves no fork behind.
	try {
		await copyChatContent(id, newId, { throughIdx: boundary[0].idx, origin: true });
		const rows: { version: number }[] = await db.select('SELECT version FROM chats WHERE id = $1', [id]);
		if (rows[0]?.version !== chat.version) throw new ConcurrencyError(id, chat.version);
	} catch (e) {
		await db.execute('DELETE FROM chats WHERE id = $1', [newId]).catch(() => {});
		throw e;
	}

	return newId;
}

// ── Optimistic concurrency ─────────────────────────────────────────────

/**
 * Atomically bump a chat's optimistic-concurrency `version`, and optionally its
 * `updated` timestamp. Only mutations that change the conversation itself
 * (messages added/edited/deleted) should touch `updated` — metadata-only saves
 * leave it alone so chat-list ordering doesn't churn on every config tweak or
 * chat switch.
 *
 * If `expectedVersion` is given and doesn't match the row's current version, no
 * write happens and a ConcurrencyError is thrown (another writer raced us).
 * Returns the new version, so callers can keep their tracked version in sync.
 */
async function bumpChatVersion(id: string, expectedVersion?: number, touchUpdated = true): Promise<number> {
	const params: any[] = [id];
	if (touchUpdated) params.push(Date.now()); // $2 when present
	const setUpdated = touchUpdated ? ', updated = $2' : '';

	if (expectedVersion === undefined) {
		await db.execute(`UPDATE chats SET version = version + 1${setUpdated} WHERE id = $1`, params);
		const rows: { version: number }[] = await db.select('SELECT version FROM chats WHERE id = $1', [id]);
		return rows[0]?.version ?? 0;
	}

	params.push(expectedVersion); // $3 (or $2 when not touching updated)
	const res = await db.execute(
		`UPDATE chats SET version = version + 1${setUpdated} WHERE id = $1 AND version = $${touchUpdated ? 3 : 2}`,
		params
	);
	if (!res.rowsAffected) throw new ConcurrencyError(id, expectedVersion);
	return expectedVersion + 1;
}

// ── Message serialization ──────────────────────────────────────────────

const MESSAGE_COLS = `(chat_id, idx, role, content, current_version,
	 thinking, thinking_signature, reasoning_enc, tool_calls, tool_results,
	 tool_call_id, ids, name, models, providers, usage, timing, images, files)`;
const PARAMS_PER_ROW = 19;

/**
 * File refs carry an inlined `data` body on request/export copies. Persisting it would
 * duplicate the body into the message row, which is what the attachment store avoids.
 */
function serializeFiles(files: FileAttachment[][] | undefined): string | null {
	return files ? JSON.stringify(files, (key, value) => key === 'data' ? undefined : value) : null;
}

function messageToParams(chatId: string, idx: number, msg: ChatMessage): any[] {
	return [
		chatId,
		idx,
		msg.role,
		JSON.stringify(msg.content),
		msg.currentVersionIndex || 0,
		msg.thinking ? JSON.stringify(msg.thinking) : null,
		msg.thinking_signature ? JSON.stringify(msg.thinking_signature) : null,
		msg.reasoning_enc ? JSON.stringify(msg.reasoning_enc) : null,
		msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
		msg.tool_results ? JSON.stringify(msg.tool_results) : null,
		msg.tool_call_id ? JSON.stringify(msg.tool_call_id) : null,
		msg.ids ? JSON.stringify(msg.ids) : null,
		null, // name column (reserved, not currently used on ChatMessage)
		msg.models ? JSON.stringify(msg.models) : null,
		msg.providers ? JSON.stringify(msg.providers) : null,
		msg.usage ? JSON.stringify(msg.usage) : null,
		msg.timing ? JSON.stringify(msg.timing) : null,
		msg.images ? JSON.stringify(msg.images) : null,
		serializeFiles(msg.files),
	];
}

/** Column list for UPDATE statements (excludes chat_id and idx which don't change). */
const UPDATE_FIELDS = ['role', 'content', 'current_version', 'thinking', 'thinking_signature', 'reasoning_enc',
	'tool_calls', 'tool_results', 'tool_call_id', 'ids', 'name', 'models', 'providers', 'usage', 'timing', 'images', 'files'] as const;

function messageToUpdateParams(msg: ChatMessage): any[] {
	return [
		msg.role,
		JSON.stringify(msg.content),
		msg.currentVersionIndex || 0,
		msg.thinking ? JSON.stringify(msg.thinking) : null,
		msg.thinking_signature ? JSON.stringify(msg.thinking_signature) : null,
		msg.reasoning_enc ? JSON.stringify(msg.reasoning_enc) : null,
		msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
		msg.tool_results ? JSON.stringify(msg.tool_results) : null,
		msg.tool_call_id ? JSON.stringify(msg.tool_call_id) : null,
		msg.ids ? JSON.stringify(msg.ids) : null,
		null,
		msg.models ? JSON.stringify(msg.models) : null,
		msg.providers ? JSON.stringify(msg.providers) : null,
		msg.usage ? JSON.stringify(msg.usage) : null,
		msg.timing ? JSON.stringify(msg.timing) : null,
		msg.images ? JSON.stringify(msg.images) : null,
		serializeFiles(msg.files),
	];
}

/**
 * `db.select` for rows whose JSON columns should come back decoded.
 *
 * Routes through the `select_json` Rust command, which appends those columns to the
 * response buffer verbatim rather than decoding and re-escaping every cell (see
 * src-tauri/src/sql.rs). Anything that makes it reject — an unregistered command, a
 * blob column, text that isn't the JSON it claims to be — re-runs the query through
 * the plugin and parses in JS, which is what this did before the command existed
 * (and still throws on a cell that won't parse).
 */
async function selectRows(query: string, values: unknown[]): Promise<MessageRowParsed[]> {
	if (dbUrl) {
		try {
			const { invoke } = await core();
			const raw = await invoke<ArrayBuffer | number[]>('select_json', {
				db: dbUrl, query, values, jsonColumns: JSON_COLUMNS,
			});
			return await new Response(raw instanceof ArrayBuffer ? raw : Uint8Array.from(raw)).json();
		} catch (e) {
			// A malformed query lands here too, and will throw again below — the warning
			// only means the fast path was skipped, not that the query itself failed.
			console.warn('select_json rejected, retrying via plugin select:', e);
		}
	}

	const rows: MessageRow[] = await db.select(query, values);
	return rows.map(row => {
		const parsed: any = { ...row };
		for (const col of JSON_COLUMNS) {
			const value = (row as any)[col];
			if (typeof value === 'string') parsed[col] = JSON.parse(value);
		}
		return parsed as MessageRowParsed;
	});
}

function rowToMessage(row: MessageRowParsed): ChatMessage {
	return normalizeMessage({
		_dbId: row.id,
		role: row.role as ChatMessage['role'],
		content: row.content,
		currentVersionIndex: row.current_version || 0,
		thinking: row.thinking ?? undefined,
		thinking_signature: row.thinking_signature ?? undefined,
		reasoning_enc: row.reasoning_enc ?? undefined,
		tool_calls: row.tool_calls ?? undefined,
		tool_results: row.tool_results ?? undefined,
		tool_call_id: row.tool_call_id ?? undefined,
		ids: row.ids ?? undefined,
		models: row.models ?? undefined,
		providers: row.providers ?? undefined,
		usage: row.usage ?? undefined,
		timing: row.timing ?? undefined,
		images: row.images ?? undefined,
		files: row.files ?? undefined,
	});
}

/**
 * Batch-insert messages using json_each (bypasses SQLite's 999-variable limit).
 * Returns an array of the new autoincrement ids in insertion order.
 */
async function batchInsertMessages(rows: { chatId: string; idx: number; msg: ChatMessage }[], upsert = false): Promise<number[]> {
	if (rows.length === 0) return [];

	const jsonArray = rows.map(r => ({
		chat_id: r.chatId,
		idx: r.idx,
		role: r.msg.role,
		content: JSON.stringify(r.msg.content),
		current_version: r.msg.currentVersionIndex || 0,
		thinking: r.msg.thinking ? JSON.stringify(r.msg.thinking) : null,
		thinking_signature: r.msg.thinking_signature ? JSON.stringify(r.msg.thinking_signature) : null,
		reasoning_enc: r.msg.reasoning_enc ? JSON.stringify(r.msg.reasoning_enc) : null,
		tool_calls: r.msg.tool_calls ? JSON.stringify(r.msg.tool_calls) : null,
		tool_results: r.msg.tool_results ? JSON.stringify(r.msg.tool_results) : null,
		tool_call_id: r.msg.tool_call_id ? JSON.stringify(r.msg.tool_call_id) : null,
		ids: r.msg.ids ? JSON.stringify(r.msg.ids) : null,
		name: null,
		models: r.msg.models ? JSON.stringify(r.msg.models) : null,
		providers: r.msg.providers ? JSON.stringify(r.msg.providers) : null,
		usage: r.msg.usage ? JSON.stringify(r.msg.usage) : null,
		timing: r.msg.timing ? JSON.stringify(r.msg.timing) : null,
		images: r.msg.images ? JSON.stringify(r.msg.images) : null,
		files: serializeFiles(r.msg.files),
	}));

	const onConflict = upsert
		? `ON CONFLICT (chat_id, idx) DO UPDATE SET ${UPDATE_FIELDS.map(f => `${f} = excluded.${f}`).join(', ')}`
		: '';

	const ids: { id: number }[] = await db.select(
		`INSERT INTO messages ${MESSAGE_COLS}
		 SELECT
		   json_extract(value, '$.chat_id'),
		   json_extract(value, '$.idx'),
		   json_extract(value, '$.role'),
		   json_extract(value, '$.content'),
		   json_extract(value, '$.current_version'),
		   json_extract(value, '$.thinking'),
		   json_extract(value, '$.thinking_signature'),
		   json_extract(value, '$.reasoning_enc'),
		   json_extract(value, '$.tool_calls'),
		   json_extract(value, '$.tool_results'),
		   json_extract(value, '$.tool_call_id'),
		   json_extract(value, '$.ids'),
		   json_extract(value, '$.name'),
		   json_extract(value, '$.models'),
		   json_extract(value, '$.providers'),
		   json_extract(value, '$.usage'),
		   json_extract(value, '$.timing'),
		   json_extract(value, '$.images'),
		   json_extract(value, '$.files')
		 FROM json_each($1)
		 ORDER BY key
		 ${onConflict}
		 RETURNING id`,
		[JSON.stringify(jsonArray)]
	);

	return ids.map(r => r.id);
}

// ── Single-row operations ──────────────────────────────────────────────

/** Insert a single message (upsert). Returns the row id. */
async function insertSingleMessage(chatId: string, idx: number, msg: ChatMessage): Promise<number> {
	const updateClause = UPDATE_FIELDS.map(f => `${f} = excluded.${f}`).join(', ');
	const result = await db.execute(
		`INSERT INTO messages ${MESSAGE_COLS} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
		 ON CONFLICT (chat_id, idx) DO UPDATE SET ${updateClause}`,
		messageToParams(chatId, idx, msg)
	);
	// On conflict (update), lastInsertId may be 0 — fetch the actual row id
	if (result.lastInsertId) return result.lastInsertId;
	const rows: { id: number }[] = await db.select(
		'SELECT id FROM messages WHERE chat_id = $1 AND idx = $2',
		[chatId, idx]
	);
	return rows[0].id;
}

/** Update an existing message by its stable row id. */
async function updateMessageRow(dbId: number, msg: ChatMessage): Promise<void> {
	const setClause = UPDATE_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
	const params = messageToUpdateParams(msg);
	params.push(dbId);
	await db.execute(
		`UPDATE messages SET ${setClause} WHERE id = $${UPDATE_FIELDS.length + 1}`,
		params
	);
}

/**
 * Delete a single message by its stable row id, bumping the owning chat's
 * version/`updated`. Pass `chatId` + `expectedVersion` to participate in
 * optimistic concurrency; returns the chat's new version (undefined if the
 * owning chat couldn't be resolved). Without `chatId` it falls back to the
 * message's own `chat_id` and skips the concurrency check.
 */
export async function deleteMessageRow(dbId: number, chatId?: string, expectedVersion?: number): Promise<number | undefined> {
	const info: { chat_id: string; idx: number }[] = await db.select(
		'SELECT chat_id, idx FROM messages WHERE id = $1', [dbId]
	);
	if (info.length === 0) return expectedVersion;
	const { chat_id: rowChatId, idx: deletedIdx } = info[0];
	const id = chatId ?? rowChatId;
	// Guard first so a stale delete removes nothing.
	const newVersion = await bumpChatVersion(id, expectedVersion);
	await db.execute('DELETE FROM messages WHERE id = $1', [dbId]);
	// Close the idx gap so array-index-based inserts stay in sync.
	await db.execute(
		'UPDATE messages SET idx = idx - 1 WHERE chat_id = $1 AND idx > $2',
		[rowChatId, deletedIdx]
	);
	return newVersion;
}

/**
 * Auto-repair idx gaps left by older builds that didn't re-index on delete.
 * Without this, new messages (inserted at idx = array length) collide with
 * a later row's idx via the upsert and silently overwrite it.
 */
async function repairIdxGaps(rows: { id: number; idx: number }[]): Promise<void> {
	if (rows.length === 0 || rows[rows.length - 1].idx === rows.length - 1) return;
	for (let i = 0; i < rows.length; i++) {
		if (rows[i].idx !== i) {
			await db.execute('UPDATE messages SET idx = $1 WHERE id = $2', [i, rows[i].id]);
			rows[i].idx = i;
		}
	}
}

// ── Message loading ────────────────────────────────────────────────────

/**
 * Load all messages for a chat.
 */
export async function loadChatMessages(chatId?: string): Promise<ChatMessage[]> {
	const id = chatId || await getCurrentChatId();
	const rows = await selectRows(
		'SELECT * FROM messages WHERE chat_id = $1 ORDER BY idx',
		[id]
	);
	await repairIdxGaps(rows);
	return rows.map(rowToMessage);
}

/**
 * Save all messages for a chat (full replace).
 * Assigns new _dbId to each message from the INSERT results.
 */
export async function saveChatMessages(messages: ChatMessage[], chatId?: string, expectedVersion?: number): Promise<number> {
	const id = chatId || await getCurrentChatId();

	// Guard against concurrent writers before mutating anything.
	const newVersion = await bumpChatVersion(id, expectedVersion);

	// Clear existing and bulk insert (new autoincrement ids)
	await db.execute('DELETE FROM messages WHERE chat_id = $1', [id]);

	if (messages.length > 0) {
		const ids = await batchInsertMessages(
			messages.map((msg, i) => ({ chatId: id, idx: i, msg }))
		);
		for (let i = 0; i < messages.length; i++) {
			messages[i]._dbId = ids[i];
		}
	}

	return newVersion;
}

/**
 * Incrementally save dirty messages.
 * - Messages with _dbId are UPDATEd in place (stable identity preserved).
 * - Messages without _dbId are INSERTed (new rows, _dbId assigned).
 */
export async function saveDirtyChatMessages(
	indices: number[],
	messages: ChatMessage[],
	chatId?: string,
	expectedVersion?: number
): Promise<number | undefined> {
	if (indices.length === 0) return expectedVersion;

	const id = chatId || await getCurrentChatId();

	// Guard against concurrent writers before touching any message rows.
	const newVersion = await bumpChatVersion(id, expectedVersion);

	// Partition into updates (have _dbId) and inserts (new messages)
	const toUpdate: { index: number; msg: ChatMessage }[] = [];
	const toInsert: { index: number; msg: ChatMessage }[] = [];

	for (const index of indices) {
		if (index >= messages.length) continue; // deleted via deleteMessageRow, skip
		const msg = messages[index];
		if (msg._dbId) toUpdate.push({ index, msg });
		else toInsert.push({ index, msg });
	}

	// Updates: individual calls (typically few — streaming edits to existing messages)
	for (const { msg } of toUpdate) {
		await updateMessageRow(msg._dbId!, msg);
	}

	// Inserts: batch upsert (handles bulk + deduplicates on conflict)
	if (toInsert.length > 0) {
		const ids = await batchInsertMessages(
			toInsert.map(({ index, msg }) => ({ chatId: id, idx: index, msg })),
			true
		);
		for (let i = 0; i < toInsert.length; i++) {
			toInsert[i].msg._dbId = ids[i];
		}
	}

	return newVersion;
}

// ── Windowed loading (for future scroll-to-load UI) ────────────────────

/**
 * Load a window of messages using LIMIT/OFFSET.
 */
export async function loadChatMessagesWindowed(
	chatId: string,
	limit: number,
	offset: number
): Promise<ChatMessage[]> {
	const rows = await selectRows(
		'SELECT * FROM messages WHERE chat_id = $1 ORDER BY idx LIMIT $2 OFFSET $3',
		[chatId, limit, offset]
	);
	return rows.map(rowToMessage);
}

// ── Message search ─────────────────────────────────────────────────────

export interface MessageSearchResult {
	chatId: string;
	chatName: string;
	chatFolder: string | null;
	updated: number;
	dbId: number;
	/** Stored sort index within the owning chat. */
	idx: number;
	role: string;
	/** HTML — escaped, with the match wrapped in <b>. */
	snippet: string;
	/** Set when the match is in a version other than the stored active one. */
	versionIndex?: number | undefined;
	/** Set when forks of this chat hold the same message and also matched (shown once, here). */
	copies?: number | undefined;
}

/**
 * Full-text search across every chat.
 *
 * A fork holds its own copy of the messages before the fork point, but those copies
 * share an `origin_id`, so a message is reported once — in the original, or in the
 * oldest copy still matching — with `copies` counting the others. Duplicates carry
 * no `origin_id` and match like any other chat.
 *
 * `folders` scopes the search to those chat folders (use '' for "no folder").
 * `tags` requires every listed tag; `excludeTags` removes chats carrying any of
 * * them. Tag terms resolve case-insensitively (NOCASE collation).
 * Filtering happens in SQL so `limit` applies to the scoped rows — post-filtering
 * in JS would silently drop folders whose hits sit past the global limit.
 */
export async function searchMessagesFTS(
	query: string,
	opts: { limit?: number; folders?: string[] | undefined; tags?: string[] | undefined; excludeTags?: string[] | undefined } = {}
): Promise<MessageSearchResult[]> {
	const match = ftsQuery(query);
	if (!match) return [];
	const { limit = 50, folders, tags, excludeTags } = opts;
	if (folders && folders.length === 0) return [];
	if (tags && tags.length === 0) return [];

	// $1 is the FTS match and $2 the limit, so folder params start at $3
	const named = folders?.filter(f => f !== '') ?? [];
	let folderClause = '';
	if (folders) {
		const clauses = named.length
			? [`c.chat_folder IN (${named.map((_, i) => `$${i + 3}`).join(', ')})`]
			: [];
		// chat_folder is NULL (or '') for unfoldered chats, and NULL IN (...) never matches
		if (named.length !== folders.length) clauses.push(`c.chat_folder IS NULL`, `c.chat_folder = ''`);
		folderClause = ` AND (${clauses.join(' OR ')})`;
	}

	// $1 is the FTS match and $2 the limit, so facet params start at $3
	let p = 3 + named.length;
	const tagClauses: string[] = [];
	const tagParams: string[] = []
	for (const tag of tags ?? []) {
		tagClauses.push(`EXISTS (SELECT 1 FROM chat_tags ct WHERE ct.chat_id = c.id AND ct.tag = $${p++})`);
		tagParams.push(tag);
	}
	for (const tag of excludeTags ?? []) {
		tagClauses.push(`NOT EXISTS (SELECT 1 FROM chat_tags ct WHERE ct.chat_id = c.id AND ct.tag = $${p++})`);
		tagParams.push(tag);
	}
	const tagClause = tagClauses.length ? ` AND (${tagClauses.join(' AND ')})` : '';

	// A fork's copies share an `origin_id`, and FTS ranks equal text alike, so the copies of
	// a message sit together in rank order. Fold a few times `limit` candidates (inside the
	// scoped set, so a hit in a scoped fork isn't hidden by an out-of-scope original) and
	// widen only if folding left too few; an unforked database costs a single pass.
	// Only ids are read here, the message bodies for the survivors come after.
	const MAX_CANDIDATES = 5000;
	let fetch = limit * 4;
	let hits: { id: number; copies: number }[];
	for (;;) {
		const candidates: { id: number; origin: number }[] = await db.select(
			`SELECT m.id, COALESCE(m.origin_id, m.id) AS origin
			 FROM messages_fts
			 JOIN messages m ON m.id = messages_fts.rowid
			 JOIN chats c ON c.id = m.chat_id
			 WHERE messages_fts MATCH $1${folderClause}${tagClause}
			 ORDER BY rank LIMIT $2`,
			[match, fetch, ...named, ...tagParams]
		);
		// Best rank decides the order, the oldest copy is the one shown
		const groups = new Map<number, { id: number; copies: number }>();
		for (const { id, origin } of candidates) {
			const group = groups.get(origin);
			if (!group) groups.set(origin, { id, copies: 0 });
			else { group.copies++; group.id = Math.min(group.id, id); }
		}
		hits = [...groups.values()];
		if (hits.length >= limit || candidates.length < fetch || fetch >= MAX_CANDIDATES) break;
		fetch = Math.min(fetch * 4, MAX_CANDIDATES);
	}
	hits = hits.slice(0, limit);
	if (hits.length === 0) return [];

	const bodies: (MessageRow & { chat_name: string; chat_folder: string | null; updated: number })[] = await db.select(
		`SELECT m.id, m.chat_id, m.idx, m.role, m.content, m.current_version,
		        c.name AS chat_name, c.chat_folder, c.updated
		 FROM messages m JOIN chats c ON c.id = m.chat_id
		 WHERE m.id IN (${hits.map((_, i) => `$${i + 1}`).join(', ')})`,
		hits.map(h => h.id)
	);
	const bodyById = new Map(bodies.map(r => [r.id, r]));
	const rows = hits.flatMap(h => {
		const row = bodyById.get(h.id);
		return row ? [{ ...row, copies: h.copies }] : [];
	});

	// Snippets are built in JS from the parsed content array rather than via FTS5
	// snippet(), which would return fragments of the raw JSON (escapes and all).
	// FTS ANDs the terms and they may sit far apart, so anchor on whichever term
	// appears earliest rather than on the full query string.
	const terms = ftsTerms(query);
	const locate = (text: string): { at: number; len: number } | null => {
		const lower = text.toLowerCase();
		let best: { at: number; len: number } | null = null;
		for (const t of terms) {
			const at = lower.indexOf(t);
			if (at !== -1 && (!best || at < best.at)) best = { at, len: t.length };
		}
		return best;
	};

	const results: MessageSearchResult[] = [];
	for (const row of rows) {
		let versions: string[];
		try { versions = JSON.parse(row.content); } catch { continue; }
		const active = row.current_version || 0;
		// Active version first — the match is usually in what the user last saw.
		const order = [active, ...versions.map((_, v) => v).filter(v => v !== active)];

		const base = {
			chatId: row.chat_id, chatName: row.chat_name, chatFolder: row.chat_folder,
			updated: row.updated, dbId: row.id, idx: row.idx, role: row.role,
			...(row.copies > 0 ? { copies: row.copies } : {}),
		};
		let located = false;
		for (const v of order) {
			const text = versions[v];
			if (typeof text !== 'string') continue;
			const hit = locate(text);
			if (!hit) continue;
			results.push({
				...base,
				snippet: buildSnippet(text, hit.at, hit.len),
				...(v === active ? {} : { versionIndex: v }),
			});
			located = true;
			break;
		}
		// FTS folds diacritics (and case) when tokenizing, so it can legitimately
		// match text that a literal indexOf won't find — e.g. "cafe" against "café".
		// The row is still a genuine hit; show its opening rather than dropping it.
		if (!located && typeof versions[active] === 'string')
			results.push({ ...base, snippet: headSnippet(versions[active]) });
	}
	return results;
}

/**
 * Get total message count for a chat.
 */
export async function getMessageCount(chatId?: string): Promise<number> {
	const id = chatId || await getCurrentChatId();
	const rows: { count: number }[] = await db.select('SELECT COUNT(*) as count FROM messages WHERE chat_id = $1', [id]);
	return rows[0]?.count || 0;
}

// ── Per-chat metadata ──────────────────────────────────────────────────

/**
 * Save chat metadata. `configName` is stored as a dedicated column (queryable),
 * remaining fields go into a JSON `meta` blob.
 *
 * Meta is low-stakes settings (theme, model, tools, etc.) — intentionally does
 * NOT bump the optimistic-concurrency version. Version is reserved for message
 * mutations so that a settings save in one window never poisons the version
 * counter for a window that's actively streaming messages.
 */
export async function saveChatMeta(meta: ChatMeta, chatId?: string, _expectedVersion?: number): Promise<number | undefined> {
	const id = chatId || await getCurrentChatId();
	const { configName, chatFolder, backend, ...rest } = meta;
	await db.execute(
		'UPDATE chats SET config_name = $1, meta = $2, chat_folder = $3, backend = $4 WHERE id = $5',
		[configName ?? null, JSON.stringify(rest), chatFolder ?? null, backend ?? null, id]
	);
	noteQuietWrite();
	return undefined; // no version change — callers should not update chatVersion
}

/**
 * Load chat metadata. Returns null if the chat has no saved metadata.
 * Reassembles `configName` from its dedicated column into the ChatMeta object.
 */
export async function loadChatMeta(chatId?: string): Promise<ChatMeta | null> {
	const id = chatId || await getCurrentChatId();
	const rows: { config_name: string | null; meta: string | null; chat_folder: string | null; backend: string | null }[] = await db.select(
		'SELECT config_name, meta, chat_folder, backend FROM chats WHERE id = $1', [id]
	);
	if (rows.length === 0) return null;
	const { config_name, meta, chat_folder, backend } = rows[0];
	if (!config_name && !meta && !chat_folder && !backend) return null;
	const parsed = meta ? JSON.parse(meta) : {};
	return { configName: config_name ?? '', chatFolder: chat_folder ?? undefined, backend: backend ?? undefined, ...parsed };
}

// ── IndexedDB → SQLite migration ──────────────────────────────────────

/**
 * Migrate messages from IndexedDB to SQLite on first Tauri launch.
 * Only runs if SQLite has no chats and IndexedDB has data.
 * Returns the migrated messages (or empty array if nothing to migrate).
 */
export async function migrateFromIndexedDB(): Promise<ChatMessage[]> {
	// Check if we already have chats
	const existingChats: Chat[] = await db.select('SELECT id FROM chats LIMIT 1');
	if (existingChats.length > 0) return [];

	// Try to read from IndexedDB
	try {
		const idbMessages = await messageStorage.loadMessages();
		if (idbMessages.length === 0) return [];

		console.log(`Migrating ${idbMessages.length} messages from IndexedDB to SQLite...`);

		const chatId = await createChat('Migrated Chat');
		const ids = await batchInsertMessages(
			idbMessages.map((msg, i) => ({ chatId, idx: i, msg }))
		);
		for (let i = 0; i < idbMessages.length; i++) {
			idbMessages[i]._dbId = ids[i];
		}

		console.log(`Migration complete: ${idbMessages.length} messages in chat ${chatId}`);
		return idbMessages;
	} catch (error) {
		console.warn('IndexedDB migration failed (non-fatal):', error);
		return [];
	}
}

// ── Attachments ────────────────────────────────────────────────────────

export async function saveAttachment(id: string, mime: string, data: string): Promise<void> {
	await db.execute(
		'INSERT OR REPLACE INTO attachments (id, mime, data, created) VALUES ($1, $2, $3, $4)',
		[id, mime, data, Date.now()]
	);
}

export async function loadAttachment(id: string): Promise<{ mime: string; data: string } | null> {
	const rows: { mime: string; data: string }[] = await db.select(
		'SELECT mime, data FROM attachments WHERE id = $1', [id]
	);
	return rows[0] || null;
}

/**
 * Drop attachments no message references any more (e.g. after deleting a chat).
 * minAgeMs guards against a multi-window race: a fresh attachment may have been
 * saved by another window whose referencing message isn't persisted yet.
 */
export async function pruneAttachments(minAgeMs = 0): Promise<void> {
	// <= keeps the minAge boundary inclusive; with 0 (tests) same-millisecond saves still prune
	await db.execute(`DELETE FROM attachments WHERE created <= $1 AND id NOT IN (
		SELECT id FROM (
			SELECT ref.value AS id FROM messages,
			     json_each(messages.images) AS version,
			     json_each(version.value) AS ref
			WHERE messages.images IS NOT NULL
			UNION ALL
			SELECT json_extract(ref.value, '$.id') FROM messages,
			     json_each(messages.files) AS version,
			     json_each(version.value) AS ref
			WHERE messages.files IS NOT NULL
			UNION ALL
			SELECT ref.value FROM messages,
			     json_each(messages.tool_results) AS version,
			     json_each(version.value) AS result,
			     json_each(json_extract(result.value, '$.data.images')) AS ref
			WHERE messages.tool_results IS NOT NULL
			UNION ALL
			-- run_js: globals snapshot, and images of the calls in its log
			SELECT json_extract(result.value, '$.data.state') FROM messages,
			     json_each(messages.tool_results) AS version,
			     json_each(version.value) AS result
			WHERE messages.tool_results IS NOT NULL
			UNION ALL
			SELECT ref.value FROM messages,
			     json_each(messages.tool_results) AS version,
			     json_each(version.value) AS result,
			     json_each(json_extract(result.value, '$.data.log')) AS entry,
			     json_each(json_extract(entry.value, '$.result.data.images')) AS ref
			WHERE messages.tool_results IS NOT NULL
			UNION ALL
			-- Chat background images live in meta, not on a message
			SELECT json_extract(chats.meta, '$.background.image') FROM chats
			WHERE json_extract(chats.meta, '$.background.image') IS NOT NULL
			UNION ALL
			-- So are unsent drafts
			SELECT ref.value FROM chats,
			     json_each(json_extract(chats.meta, '$.draft.images')) AS ref
			UNION ALL
			SELECT json_extract(ref.value, '$.id') FROM chats,
			     json_each(json_extract(chats.meta, '$.draft.files')) AS ref
		)
		WHERE id IS NOT NULL
	)`, [Date.now() - minAgeMs]);
}

/**
 * Gracefully close the database connection.
 * Updates query planner statistics, then truncates the WAL so the database is a
 * single self-contained file — which is what makes it safe to move or replace
 * (see restoreBackup).
 */
export async function closeDatabase(): Promise<void> {
	if (!db) return;
	await db.execute('PRAGMA optimize');
	await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
	await db.close();
	db = null as any;
	initPromise = null as any;
}
