/**
 * Occasional snapshots of the Tauri SQLite database.
 *
 * Copies are made with VACUUM INTO through the live connection, so they include
 * WAL content and are compact, self-contained database files — openable
 * directly, or restorable by dropping one back over story.db.
 *
 * Snapshots land in `backups/` next to the database and are thinned by a tiered
 * policy: recent ones stay dense, older ones survive one per hour, then per day,
 * then per week. Nothing here ever throws at the caller's expense — a failed
 * backup is logged, never fatal.
 *
 * The database only holds chats, messages and attachments; prompts, configs,
 * lore, macros and provider keys live in localStorage. So each snapshot gets a
 * `.json` sidecar with those, restorable on its own — restoring a week-old
 * database next to today's lore is rarely what anyone wants.
 */

import { isTauri, openExternal } from './platform';
import { loadFromStorage } from './Extras';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Keep the newest snapshot in each of the `keep` most recent `every`-sized buckets. */
export interface RetentionRule { every: number; keep: number }

export interface BackupFile {
	name: string;
	path: string;
	time: number;
	size: number;
	/** Whether a settings sidecar was written alongside this snapshot. */
	settings: boolean;
}

export const PROFILES = {
	sparse: { label: 'Sparse', rules: [{ every: HOUR, keep: 2 }, { every: DAY, keep: 2 }, { every: WEEK, keep: 1 }] },
	normal: { label: 'Normal', rules: [{ every: 15 * MINUTE, keep: 4 }, { every: HOUR, keep: 3 }, { every: DAY, keep: 3 }, { every: WEEK, keep: 2 }] },
	dense:  { label: 'Paranoid', rules: [{ every: 15 * MINUTE, keep: 8 }, { every: HOUR, keep: 6 }, { every: DAY, keep: 7 }, { every: WEEK, keep: 4 }] },
} satisfies Record<string, { label: string; rules: RetentionRule[] }>;

export type ProfileName = keyof typeof PROFILES;

export interface BackupSettings { enabled: boolean; profile: ProfileName }

const SETTINGS_KEY = 'db_backup_settings';
const LAST_KEY = 'db_backup_last';
const STAMP_KEY = 'db_backup_stamp';

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { enabled: true, profile: 'normal' };

export function loadBackupSettings(): BackupSettings {
	const s = loadFromStorage<BackupSettings>(SETTINGS_KEY, DEFAULT_BACKUP_SETTINGS);
	return { ...DEFAULT_BACKUP_SETTINGS, ...s, profile: s.profile in PROFILES ? s.profile : 'normal' };
}

export function saveBackupSettings(settings: BackupSettings): void {
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function lastBackupTime(): number {
	return Number(localStorage.getItem(LAST_KEY) || 0);
}

// ── Settings sidecar ────────────────────────────────────────────

/**
 * Everything but our own bookkeeping (the `db_backup_` keys here and the quiet-write
 * counter db.ts keeps for `changeStamp`), so applying an old dump can't rewind the
 * backup clock or make the next probe see a phantom change.
 */
const isBookkeeping = (key: string) => key.startsWith('db_backup_');

const settingsPath = (file: BackupFile) => file.path.replace(/\.db$/, '.json');

function dumpSettings(): string {
	const out: Record<string, string> = {};
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i)!;
		if (!isBookkeeping(key)) out[key] = localStorage.getItem(key) ?? '';
	}
	return JSON.stringify(out);
}

/**
 * Replace the current settings with a snapshot's — keys missing from the dump are
 * removed, so a config deleted back then stays deleted. The caller reloads.
 */
export async function applySettings(file: BackupFile): Promise<void> {
	const { readTextFile } = await import('@tauri-apps/plugin-fs');
	const saved: Record<string, string> = JSON.parse(await readTextFile(settingsPath(file)));

	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i)!;
		if (!isBookkeeping(key) && !(key in saved)) localStorage.removeItem(key);
	}
	for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
}

// ── Naming ────────────────────────────────────────────────────

/** Local time, so a listing reads the way the user's clock does. */
function stampName(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `story-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
}

/** Time encoded in a snapshot's name, or null for anything we didn't write. */
export function parseStampName(name: string): number | null {
	const m = /^story-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name);
	if (!m) return null;
	const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
	return new Date(y, mo - 1, d, h, mi, s).getTime();
}

// ── Retention ───────────────────────────────────────────────

/**
 * Snapshots the rules don't pin, newest first. Each rule walks the list from the
 * newest end and claims one file per time bucket until it has `keep` of them, so
 * a file stays alive as long as any tier still counts it as its representative.
 * The newest snapshot is always kept, as is `protect` — a snapshot about to be
 * restored must survive the safety snapshot taken moments earlier, which can
 * otherwise push it out of the shortest tier.
 */
export function expiredBackups(files: BackupFile[], rules: RetentionRule[], protect?: string): BackupFile[] {
	const sorted = [...files].sort((a, b) => b.time - a.time);
	const keep = new Set<string>();
	if (sorted[0]) keep.add(sorted[0].path);
	if (protect) keep.add(protect);

	for (const rule of rules) {
		const buckets = new Set<number>();
		for (const f of sorted) {
			const bucket = Math.floor(f.time / rule.every);
			if (buckets.has(bucket)) continue;
			buckets.add(bucket);
			keep.add(f.path);
			if (buckets.size >= rule.keep) break;
		}
	}

	return sorted.filter(f => !keep.has(f.path));
}

// ── Files ───────────────────────────────────────────────────

export async function backupsDir(): Promise<string> {
	const { getDbDir } = await import('./db');
	const { join } = await import('@tauri-apps/api/path');
	return join(await getDbDir(), 'backups');
}

/** Reveal the backups folder, creating it first so nothing tries to open a missing path. */
export async function openBackupsFolder(): Promise<void> {
	const { mkdir } = await import('@tauri-apps/plugin-fs');
	const dir = await backupsDir();
	await mkdir(dir, { recursive: true });
	await openExternal(dir);
}

/** One directory read, shared by listing and pruning. */
async function readBackupDir(): Promise<{ dir: string; files: BackupFile[]; names: Set<string> }> {
	const { readDir, stat, exists } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const dir = await backupsDir();
	if (!await exists(dir)) return { dir, files: [], names: new Set() };

	const names = new Set((await readDir(dir)).filter(e => e.isFile).map(e => e.name));
	const files: BackupFile[] = [];
	for (const name of names) {
		const time = parseStampName(name);
		if (time === null) continue; // partials, sidecars and strays
		const path = await join(dir, name);
		files.push({
			name, path, time,
			size: (await stat(path)).size,
			settings: names.has(name.replace(/\.db$/, '.json')),
		});
	}
	files.sort((a, b) => b.time - a.time);
	return { dir, files, names };
}

export async function listBackups(): Promise<BackupFile[]> {
	if (!isTauri) return [];
	return (await readBackupDir()).files;
}

/**
 * Drop expired snapshots with their sidecars, plus anything left behind by an
 * interrupted backup: a `.part` older than an hour, or a settings dump whose
 * database never made it.
 */
async function pruneBackups(rules: RetentionRule[], protect?: string): Promise<void> {
	const { remove } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const { dir, files, names } = await readBackupDir();

	const doomed = expiredBackups(files, rules, protect).flatMap(f => f.settings ? [f.path, settingsPath(f)] : [f.path]);

	for (const name of names) {
		const stray = name.endsWith('.db.part')
			? (parseStampName(name.slice(0, -5)) ?? 0) < Date.now() - HOUR
			: name.endsWith('.json') && !names.has(name.replace(/\.json$/, '.db'));
		if (stray) doomed.push(await join(dir, name));
	}

	for (const path of doomed) {
		try { await remove(path); }
		catch (e) { console.warn('Failed to remove old backup', path, e); }
	}
}

/**
 * Snapshot the database and the current settings, then thin the folder.
 * Throws on failure — callers decide how loud to be.
 *
 * The database goes to a `.part` name and is renamed once complete, so a crash
 * mid-copy can't leave something that looks restorable.
 */
export async function createBackup(opts: { profile?: ProfileName; protect?: string } = {}): Promise<BackupFile> {
	const { vacuumInto, changeStamp } = await import('./db');
	const { mkdir, stat, rename, writeTextFile } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const profile = opts.profile ?? loadBackupSettings().profile;

	const dir = await backupsDir();
	await mkdir(dir, { recursive: true });
	const name = stampName(new Date());
	const path = await join(dir, name);
	const partial = `${path}.part`;

	await writeTextFile(path.replace(/\.db$/, '.json'), dumpSettings());
	await vacuumInto(partial);
	await rename(partial, path);

	localStorage.setItem(LAST_KEY, String(Date.now()));
	localStorage.setItem(STAMP_KEY, await changeStamp());
	await pruneBackups(PROFILES[profile].rules, opts.protect);

	return { name, path, time: parseStampName(name)!, size: (await stat(path)).size, settings: true };
}

/** Snapshot only if one is due and the database moved since the last one. */
export async function maybeBackup(): Promise<void> {
	if (!isTauri) return;
	const settings = loadBackupSettings();
	if (!settings.enabled) return;

	const rules = PROFILES[settings.profile].rules;
	const shortest = Math.min(...rules.map(r => r.every));
	if (Date.now() - lastBackupTime() < shortest) return;

	const { changeStamp } = await import('./db');
	if (await changeStamp() === localStorage.getItem(STAMP_KEY)) return;

	// Claim the slot before the slow part so a second window doesn't duplicate it.
	localStorage.setItem(LAST_KEY, String(Date.now()));
	try { await createBackup({ profile: settings.profile }); }
	catch (e) { console.warn('Database backup failed:', e); }
}

/**
 * Start the periodic backup check and keep this instance's presence mark fresh
 * (see markSession — the mark is what makes a restore able to refuse while
 * another window holds the database). Returns a cleanup function.
 */
export function startBackupService(): () => void {
	if (!isTauri) return () => {};
	const backupTick = () => { if (!restoring) void maybeBackup(); };
	const markTick = () => { if (!restoring) void import('./db').then(db => db.markSession()).catch(() => {}); };

	markTick();
	const startup = setTimeout(backupTick, 20_000); // let launch settle first
	const backupTimer = setInterval(backupTick, 5 * MINUTE);
	const markTimer = setInterval(markTick, 30_000);

	return () => {
		clearTimeout(startup);
		clearInterval(backupTimer);
		clearInterval(markTimer);
	};
}

/**
 * Set while a restore is in flight. Both timers below reopen the database on
 * demand, and one firing between the close and the copy would put a live
 * connection on the file we're about to overwrite.
 */
let restoring = false;

/** Instances other than this one currently holding the database open. */
export async function otherInstances(): Promise<number> {
	if (!isTauri) return 0;
	try { return await (await import('./db')).otherSessions(); }
	catch { return 0; }
}

/**
 * Replace the live database with a snapshot.
 *
 * Every window is a separate process with its own connection, so closing ours
 * frees nothing if another is running — overwriting the file underneath it
 * corrupts both. Hence the presence check, repeated right before the copy since
 * taking the safety snapshot takes time.
 *
 * After that: close (which truncates the WAL), drop any sidecars left by an
 * earlier crash — replaying them against a different database would be fatal —
 * and copy the snapshot into place. The caller reloads the window afterwards;
 * on failure the database is reopened untouched instead.
 */
export async function restoreBackup(file: BackupFile, opts: { backupFirst: boolean }): Promise<void> {
	const { getDbDir, DB_FILE, closeDatabase, initDatabase, endSession, otherSessions } = await import('./db');
	const { copyFile, rename, remove, exists } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');

	const blocked = async () => {
		const others = await otherSessions();
		if (others) throw new Error(
			`${others} other app window${others > 1 ? 's have' : ' has'} this database open. ` +
			`Close ${others > 1 ? 'them' : 'it'} and try again.`
		);
	};

	restoring = true;
	try {
		await blocked();
		if (opts.backupFirst) await createBackup({ protect: file.path });
		await blocked();

		const dbPath = await join(await getDbDir(), DB_FILE);
		const staged = `${dbPath}.part`;
		await endSession();
		await closeDatabase();
		try {
			for (const stale of [`${dbPath}-wal`, `${dbPath}-shm`, staged])
				if (await exists(stale)) await remove(stale);
			// Stage beside the database and swap: being killed mid-copy then costs a
			// stray .part, where copying straight over would cost the database.
			await copyFile(file.path, staged);
			await rename(staged, dbPath);
		} catch (e) {
			await initDatabase().catch(err =>
				console.error('Could not reopen the database after a failed restore:', err));
			throw e;
		}
	} catch (e) {
		restoring = false;
		throw e;
	}
}
