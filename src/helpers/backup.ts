/**
 * Occasional snapshots of the Tauri SQLite database.
 *
 * Copies are made with VACUUM INTO through the open connection, so they include
 * WAL content and are compact, self-contained database files that can be opened
 * directly, or restored by copying one over story.db.
 *
 * Snapshots are written to a user-selected folder (default: `backups/` next to the
 * database) and pruned in tiers: all recent ones are kept, then one per hour, one per
 * day and one per week. The periodic backup logs failures instead of throwing;
 * `createBackup` throws.
 *
 * The database only holds chats, messages and attachments; prompts, configs,
 * lore, macros and provider keys are in localStorage. So each snapshot gets a
 * `.json` sidecar with those, which can be restored separately, so a restored
 * database can be paired with the settings from the same time.
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

export interface BackupSettings { enabled: boolean; profile: ProfileName; directory?: string | undefined }

const SETTINGS_KEY = 'db_backup_settings';
const LAST_KEY = 'db_backup_last';
const STAMP_KEY = 'db_backup_stamp';

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { enabled: true, profile: 'normal' };

export function loadBackupSettings(): BackupSettings {
	const s = loadFromStorage<BackupSettings>(SETTINGS_KEY, DEFAULT_BACKUP_SETTINGS);
	return {
		...DEFAULT_BACKUP_SETTINGS, ...s,
		profile: s.profile in PROFILES ? s.profile : 'normal',
		directory: typeof s.directory === 'string' && s.directory ? s.directory : undefined,
	};
}

export function saveBackupSettings(settings: BackupSettings): void {
	const previous = loadBackupSettings();
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	if (previous.directory !== settings.directory) {
		localStorage.removeItem(LAST_KEY);
		localStorage.removeItem(STAMP_KEY);
	}
}

export function lastBackupTime(): number {
	return Number(localStorage.getItem(LAST_KEY) || 0);
}

// ── Settings sidecar ────────────────────────────────────────────

/**
 * Everything but our own bookkeeping (the `db_backup_` keys here and the quiet-write
 * counter db.ts keeps for `changeStamp`), so applying an old dump doesn't reset the
 * last-backup time or make the next `changeStamp` check report a change that didn't happen.
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
export function stampName(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `story-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomUUID()}.db`;
}

/** Time encoded in a snapshot's name, or null for anything we didn't write. */
export function parseStampName(name: string): number | null {
	const m = /^story-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\.db$/.exec(name);
	if (!m) return null;
	const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
	return new Date(y, mo - 1, d, h, mi, s).getTime();
}

// ── Retention ───────────────────────────────────────────────

/**
 * Returns the snapshots no rule keeps, newest first. Each rule goes from newest to
 * oldest and keeps the newest file in each `every`-sized bucket, for up to `keep`
 * buckets. A file is kept if any rule keeps it. The newest snapshot and `protect`
 * are always kept: `protect` is the snapshot about to be restored, and the safety
 * snapshot taken just before could otherwise push it out of the shortest tier.
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

export async function backupsDir(settings = loadBackupSettings()): Promise<string> {
	const directory = settings.directory;
	if (directory) return directory;
	const { getDbDir } = await import('./db');
	const { join } = await import('@tauri-apps/api/path');
	return join(await getDbDir(), 'backups');
}

export async function validateBackupDirectory(settings: BackupSettings): Promise<void> {
	const { mkdir, writeTextFile, remove } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const dir = await backupsDir(settings);
	await mkdir(dir, { recursive: true });
	await readBackupDir(dir);
	const probe = await join(dir, `${stampName(new Date())}.part`);
	await writeTextFile(probe, '', { createNew: true });
	await remove(probe);
}

/** Reveal the backups folder, creating it first so nothing tries to open a missing path. */
export async function openBackupsFolder(): Promise<void> {
	const { mkdir } = await import('@tauri-apps/plugin-fs');
	const dir = await backupsDir();
	await mkdir(dir, { recursive: true });
	await openExternal(dir);
}

/** One directory read, shared by listing and pruning. */
async function readBackupDir(dir: string): Promise<{ dir: string; files: BackupFile[]; names: Set<string> }> {
	const { readDir, stat, exists } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
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
	return (await readBackupDir(await backupsDir())).files;
}

/** Recognized settings dumps without a database, and partial backups older than an hour. */
export function orphanedBackupNames(names: Set<string>, now = Date.now()): string[] {
	return [...names].filter(name => {
		if (name.endsWith('.db.part')) {
			const time = parseStampName(name.slice(0, -5));
			return time !== null && time < now - HOUR;
		}
		if (name.endsWith('.json')) {
			const database = name.replace(/\.json$/, '.db');
			return parseStampName(database) !== null && !names.has(database) && !names.has(`${database}.part`);
		}
		return false;
	});
}

async function pruneBackups(directory: string, rules: RetentionRule[], protect?: string): Promise<void> {
	const { remove } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const { dir, files, names } = await readBackupDir(directory);

	const doomed = expiredBackups(files, rules, protect).flatMap(f => f.settings ? [f.path, settingsPath(f)] : [f.path]);

	for (const name of orphanedBackupNames(names)) doomed.push(await join(dir, name));

	for (const path of doomed) {
		try { await remove(path); }
		catch (e) { console.warn('Failed to remove old backup', path, e); }
	}
}

/**
 * Snapshot the database and the current settings, then prune old snapshots.
 * Throws on failure; callers decide whether to show or only log the error.
 *
 * The database goes to a `.part` name and is renamed once complete, so a crash
 * mid-copy can't leave something that looks restorable.
 */
export async function createBackup(opts: { profile?: ProfileName; protect?: string } = {}): Promise<BackupFile> {
	const { vacuumInto, changeStamp } = await import('./db');
	const { mkdir, stat, rename, writeTextFile } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const settings = loadBackupSettings();
	const profile = opts.profile ?? settings.profile;

	const dir = await backupsDir(settings);
	await mkdir(dir, { recursive: true });
	const name = stampName(new Date());
	const path = await join(dir, name);
	const partial = `${path}.part`;

	await vacuumInto(partial);
	await writeTextFile(path.replace(/\.db$/, '.json'), dumpSettings(), { createNew: true });
	await rename(partial, path);

	const stamp = await changeStamp();
	if (loadBackupSettings().directory === settings.directory) {
		localStorage.setItem(LAST_KEY, String(Date.now()));
		localStorage.setItem(STAMP_KEY, stamp);
	}
	await pruneBackups(dir, PROFILES[profile].rules, opts.protect);

	return { name, path, time: parseStampName(name)!, size: (await stat(path)).size, settings: true };
}

/**
 * Safety copy taken by `initDatabase` before a data migration rewrites the database.
 * Same folder and naming as a regular backup, so it shows up in the restore list and
 * retention thins it like any other. `vacuum` is passed in because `createBackup`
 * goes through `initDatabase`, which is still running. Skipped when backups are off.
 *
 * Counts as the latest backup: otherwise `maybeBackup`'s first run, seconds later,
 * would share its time buckets and retention would drop this one, the only
 * copy of the data from before the conversion.
 */
export async function backupBeforeMigration(vacuum: (path: string) => Promise<unknown>): Promise<void> {
	if (!isTauri) return;
	const settings = loadBackupSettings();
	if (!settings.enabled) return;

	const { mkdir, rename } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const dir = await backupsDir(settings);
	await mkdir(dir, { recursive: true });
	const path = await join(dir, stampName(new Date()));
	await vacuum(`${path}.part`);
	await rename(`${path}.part`, path);
	if (loadBackupSettings().directory === settings.directory) localStorage.setItem(LAST_KEY, String(Date.now()));
	await pruneBackups(dir, PROFILES[settings.profile].rules);
}

/** Snapshot only if one is due and `changeStamp` differs from the last backup's. */
export async function maybeBackup(): Promise<void> {
	if (!isTauri) return;
	const settings = loadBackupSettings();
	if (!settings.enabled) return;

	const rules = PROFILES[settings.profile].rules;
	const shortest = Math.min(...rules.map(r => r.every));
	if (Date.now() - lastBackupTime() < shortest) return;

	const { changeStamp } = await import('./db');
	if (await changeStamp() === localStorage.getItem(STAMP_KEY)) return;

	// Record the backup time before copying, so a check in another window doesn't start a second backup.
	localStorage.setItem(LAST_KEY, String(Date.now()));
	try { await createBackup({ profile: settings.profile }); }
	catch (e) { console.warn('Database backup failed:', e); }
}

/**
 * Start the periodic backup check, and update this instance's `sessions` row every
 * 30s (see markSession); restoreBackup uses those rows to detect other open windows.
 * Returns a cleanup function.
 */
export function startBackupService(): () => void {
	if (!isTauri) return () => {};
	const backupTick = () => { if (!restoring) void maybeBackup(); };
	const markTick = () => { if (!restoring) void import('./db').then(db => db.markSession()).catch(() => {}); };

	markTick();
	const startup = setTimeout(backupTick, 20_000); // first check 20s after launch
	const backupTimer = setInterval(backupTick, 5 * MINUTE);
	const markTimer = setInterval(markTick, 30_000);

	return () => {
		clearTimeout(startup);
		clearInterval(backupTimer);
		clearInterval(markTimer);
	};
}

/**
 * Set while a restore is running. Both timers below reopen the database on
 * demand, and one firing between the close and the copy would open a
 * connection to the file we're about to overwrite.
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
 * Every window is a separate process with its own connection, so closing this
 * one doesn't make the file safe to replace while another window is running;
 * overwriting it then corrupts both. So restore checks for other instances, and
 * checks again after the safety snapshot, since another window may have started
 * in the meantime.
 *
 * After that: close (which truncates the WAL), delete WAL/SHM files left by an
 * earlier crash (SQLite would apply them to the restored file and corrupt it),
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
			// Copy to a .part file next to the database, then rename it. If the app is
			// killed during the copy, only the .part file is incomplete, not the database.
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
