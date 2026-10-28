/**
 * Where tools do their work. `local` runs commands and touches files on the
 * machine the app runs on; future implementations (ssh, a remote daemon) put
 * the same operations somewhere else. Everything a tool needs from a shell or
 * a filesystem goes through this interface, so no tool imports Tauri directly.
 */

export interface PathRules {
	/** Separator the backend's OS uses. */
	sep: '/' | '\\';
	/** Windows path shapes (drive letters, backslashes) rather than POSIX. */
	windows: boolean;
}

export interface ExecOptions {
	command?: string | undefined;
	cwd?: string | undefined;
	timeoutSecs?: number | undefined;
	/** Return the previous command's untruncated output instead of running anything. */
	previous?: boolean | undefined;
	/** Keys previous-output and cancellation state. One per chat. */
	session?: string | undefined;
	/** Names the command within its session, so `cancelExec` can stop it alone. */
	id?: string | undefined;
	onOutput?: ((line: string) => void) | undefined;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	duration_ms: number;
}

export interface DirEntry {
	name: string;
	isDirectory: boolean;
}

export interface Backend {
	id: string;
	label: string;
	paths: PathRules;
	/** Command interpreter name, for the shell tool's description. */
	shellKind: string;
	exec(opts: ExecOptions): Promise<ExecResult>;
	/** Stops the session's running commands, or only the one started with `id`. */
	cancelExec(session: string | undefined, id?: string): Promise<void>;
	/** Throws when the path doesn't exist — callers use that to detect absence. */
	stat(path: string): Promise<{ isDirectory: boolean }>;
	readText(path: string): Promise<string>;
	readBinary(path: string): Promise<Uint8Array>;
	writeText(path: string, content: string): Promise<void>;
	/** Creates parents as needed. */
	mkdir(path: string): Promise<void>;
	readDir(path: string): Promise<DirEntry[]>;
	homeDir(): Promise<string>;
}

export const isAbsolutePath = (path: string, rules: PathRules): boolean =>
	rules.windows ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/');

export const joinPath = (base: string, rel: string, rules: PathRules): string =>
	base.replace(/[/\\]$/, '') + rules.sep + rel.replace(/[/\\]/g, rules.sep);

/** Dir names never descended into during a recursive listing: hidden entries plus heavy build dirs. */
const PRUNE_DIRS = ['node_modules', 'target', 'dist', 'build', '__pycache__'];

/** Relative dir paths pruned from listings: dependency caches too specific for a bare name
 *  (`go/pkg` holds the Go module cache; a project-local `pkg/` is often real source). */
const PRUNE_PATHS = ['go/pkg'];

const isPrunedPath = (rel: string): boolean =>
	PRUNE_PATHS.some(p => rel === p || rel.endsWith('/' + p));

const fileLists = new Map<string, { at: number; files: string[] }>();
const FILE_LIST_TTL_MS = 5_000;

/** All files under `root`, relative to it, in one round trip: `git ls-files` where
 *  available, else a dir-pruned `find` walk (readDir recursion on Windows). Briefly
 *  cached per backend+root: a folder switch fans out to several scans at once.
 *  `git: false` skips the git path, which hides .gitignore'd files. */
export async function listFiles(backend: Backend, root: string, opts?: { git?: boolean }): Promise<string[]> {
	const useGit = opts?.git !== false;
	const key = `${backend.id}:${root}:${useGit}`;
	const hit = fileLists.get(key);
	if (hit && Date.now() - hit.at < FILE_LIST_TTL_MS) return hit.files;

	let files: string[] | null = null;
	const git = useGit ? await backend
		.exec({ command: 'git ls-files --cached --others --exclude-standard', cwd: root, timeoutSecs: 10 })
		.catch(() => null) : null;
	if (git?.exit_code === 0) files = git.stdout.split('\n').filter(f => f.trim());

	if (!files) {
		if (backend.paths.windows) {
			files = await readDirRecursive(backend, root);
		} else {
			const pruneNames = ['.*', ...PRUNE_DIRS].map(n => `-name '${n}'`);
			const prunePaths = PRUNE_PATHS.map(p => `-path '*/${p}'`);
			const prune = [...pruneNames, ...prunePaths].join(' -o ');
			const find = await backend
				.exec({ command: `find . -mindepth 1 \\( ${prune} \\) -prune -o -type f -print`, cwd: root, timeoutSecs: 30 })
				.catch(() => null);
			files = find?.exit_code === 0
				? find.stdout.split('\n').map(f => f.trim().replace(/^\.\//, '')).filter(f => f)
				: [];
		}
	}

	// git ls-files doesn't know the prune rules (a tracked-but-cache folder still
	// floods the @ dropdown), so apply the path filter to every source.
	files = files.filter(f => !PRUNE_PATHS.some(p => f.startsWith(p + '/') || f.includes('/' + p + '/')));
	fileLists.set(key, { at: Date.now(), files });
	return files;
}

async function readDirRecursive(backend: Backend, root: string): Promise<string[]> {
	const results: string[] = [];
	async function scan(dir: string, prefix: string): Promise<void> {
		for (const entry of await backend.readDir(dir)) {
			if (entry.name.startsWith('.') || PRUNE_DIRS.includes(entry.name)) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory) {
				if (isPrunedPath(rel)) continue;
				await scan(joinPath(dir, entry.name, backend.paths), rel);
			}
			else results.push(rel);
		}
	}
	await scan(root, '');
	return results;
}

export { localBackend } from './local';

import type { SshBackendConfig } from '../types';
import { localBackend } from './local';
import { createSshBackend, evictSshBackend } from './ssh';

const sshBackends = new Map<string, Backend>();
let registered = new Map<string, string>(); // id -> config snapshot

/** Replace the ssh backend registry (called when settings change). Changed or
 *  removed connections are evicted so their next use reconnects fresh. */
export function registerSshBackends(configs: SshBackendConfig[]) {
	const next = new Map(configs.map(c => [c.id, JSON.stringify(c)]));
	
	for (const [id, json] of registered)
		if (next.get(id) !== json) evictSshBackend(id);

	registered = next;
	sshBackends.clear();
	
	for (const cfg of configs)
		sshBackends.set(cfg.id, createSshBackend(cfg));
}

/** Resolve a ChatMeta.backend id. Unknown ids fall back to local — a stale id
 *  (deleted connection) shouldn't break a chat, it should warn once. */
export function backendFor(id: string | undefined): Backend {
	if (!id || id === 'local') return localBackend;
	const found = sshBackends.get(id);
	if (!found) console.warn(`Unknown backend "${id}", using local`);
	return found ?? localBackend;
}
