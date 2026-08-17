/**
 * Platform abstraction layer.
 * Each function detects Tauri at runtime and branches accordingly.
 * Dynamic imports keep @tauri-apps/* out of the web bundle entirely.
 */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Save a file via platform-native dialog */
export interface FileFilter {
	description: string;
	extensions: string[];
}

export async function saveFileDialog(
	content: string,
	suggestedName: string,
	filters?: FileFilter[],
): Promise<boolean> {
	if (isTauri) {
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const { writeTextFile } = await import('@tauri-apps/plugin-fs');
			const path = await save({
				defaultPath: suggestedName,
				...(filters ? {
					filters: filters.map(f => ({ name: f.description, extensions: f.extensions.map(e => e.replace(/^\./, '')) })),
				} : {}),
			});
			if (path) {
				await writeTextFile(path, content);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	// Web: use File System Access API
	if ('showSaveFilePicker' in window) {
		try {
			const webTypes = filters?.map(f => ({
				description: f.description,
				accept: Object.fromEntries(
					f.extensions.map(ext => [
						// rough mimetype mapping; '*' for unknown extensions
						ext === '.json' ? 'application/json' :
						ext === '.md' ? 'text/markdown' :
						ext === '.txt' ? 'text/plain' :
						'text/plain',
						[ext]
					])
				),
			}));
			const handle = await (window as any).showSaveFilePicker({
				suggestedName,
				...(webTypes ? { types: webTypes } : {}),
			});
			const writable = await handle.createWritable();
			await writable.write(content);
			await writable.close();
			return true;
		} catch (e: any) {
			if (e.name === 'AbortError') return false;
			throw e;
		}
	}

	// Fallback: download via anchor
	const fallbackType = filters?.[0]?.extensions[0] === '.json'
		? 'application/json'
		: 'text/plain';
	const blob = new Blob([content], { type: fallbackType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = suggestedName;
	a.click();
	URL.revokeObjectURL(url);
	return true;
}

/**
 * Set up an autosave file handle.
 * On web: uses File System Access API (showSaveFilePicker) — returns a handle.
 * On Tauri: picks a save path via dialog — returns the path string.
 * Returns null if the user cancels.
 */
export async function setupAutosaveFile(suggestedName: string): Promise<any> {
	if (isTauri) {
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const path = await save({ defaultPath: suggestedName });
			return path; // string path, or null if cancelled
		} catch {
			return null;
		}
	}

	// Web: File System Access API
	if ('showSaveFilePicker' in window) {
		try {
			const handle = await (window as any).showSaveFilePicker({
				suggestedName,
				types: [{
					description: 'JSON files',
					accept: { 'application/json': ['.json'] },
				}],
			});
			return handle;
		} catch (e: any) {
			if (e.name === 'AbortError') return null;
			throw e;
		}
	}

	throw new Error('Autosave requires File System Access API (Chrome/Edge) or Tauri');
}

/** Write content to the autosave handle/path returned by setupAutosaveFile */
export async function writeAutosave(handleOrPath: any, content: string): Promise<void> {
	if (isTauri && typeof handleOrPath === 'string') {
		const { writeTextFile } = await import('@tauri-apps/plugin-fs');
		await writeTextFile(handleOrPath, content);
		return;
	}

	// Web: FileSystemFileHandle
	if (handleOrPath && typeof handleOrPath.createWritable === 'function') {
		const writable = await handleOrPath.createWritable();
		await writable.write(content);
		await writable.close();
		return;
	}

	throw new Error('Invalid autosave handle');
}

/** Read content from the autosave handle/path */
export async function readAutosave(handleOrPath: any): Promise<string> {
	if (isTauri && typeof handleOrPath === 'string') {
		const { readTextFile } = await import('@tauri-apps/plugin-fs');
		return readTextFile(handleOrPath);
	}

	// Web: FileSystemFileHandle
	if (handleOrPath && typeof handleOrPath.getFile === 'function') {
		const file = await handleOrPath.getFile();
		return file.text();
	}

	throw new Error('Invalid autosave handle');
}

/** Platform-aware confirm dialog */
export async function confirmDialog(message: string): Promise<boolean> {
	if (isTauri) {
		const { ask } = await import('@tauri-apps/plugin-dialog');
		return ask(message);
	}
	return window.confirm(message);
}

/** Plain Chrome UA — the plugin otherwise announces itself as tauri-plugin-http/x.y.z */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Platform-aware HTTP fetch (bypasses CORS in Tauri) */
export async function httpFetch(url: string, options?: RequestInit): Promise<Response> {
	// Both plain fetch and Tauri's shim resolve relative URLs against our own origin,
	// quietly turning a malformed URL into a request to the app itself.
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`not a valid absolute URL: ${JSON.stringify(url)}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		throw new Error(`unsupported URL scheme "${parsed.protocol}" (only http and https)`);

	if (isTauri) {
		const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
		// The plugin stamps its own User-Agent and the webview's Origin on every request
		// unless we supply them. An empty Origin makes it drop the header entirely —
		// that branch needs the `unsafe-headers` feature on the crate.
		const headers = new Headers(options?.headers);
		if (!headers.has('User-Agent')) headers.set('User-Agent', BROWSER_UA);
		if (!headers.has('Origin')) headers.set('Origin', '');
		return tauriFetch(url, { ...options, headers });
	}
	return fetch(url, options);
}

/** Open a folder picker dialog. Tauri only — returns absolute path or null if cancelled. */
export async function selectFolder(): Promise<string | null> {
	if (!isTauri) return null;
	try {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const path = await open({ directory: true, multiple: false });
		return path as string | null;
	} catch {
		return null;
	}
}

/** Read a text file from disk. Tauri only. */
export async function readFileText(path: string): Promise<string> {
	const { readTextFile } = await import('@tauri-apps/plugin-fs');
	return readTextFile(path);
}

/** Use `git ls-files` to list tracked+untracked (non-ignored) files. Falls back to readDir with dot-dir filtering. */
async function gitLsFiles(folder: string): Promise<string[] | null> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		const { Channel } = await import('@tauri-apps/api/core');
		const onOutput = new Channel<string>();
		const result = await invoke<{ stdout: string; exit_code: number }>('shell', {
			command: 'git ls-files --cached --others --exclude-standard',
			cwd: folder,
			timeoutSecs: 10,
			onOutput,
		});
		if (result.exit_code !== 0) return null;
		return result.stdout.split('\n').filter(f => f.trim());
	} catch {
		return null;
	}
}

function isHidden(name: string): boolean {
	return name.startsWith('.') || name === 'node_modules' || name === 'target' || name === 'dist' || name === 'build';
}

/** Fallback recursive readDir, skipping hidden/dot dirs. */
async function readDirRecursive(path: string): Promise<string[]> {
	const { readDir } = await import('@tauri-apps/plugin-fs');
	const results: string[] = [];

	async function scan(dirPath: string, prefix: string): Promise<void> {
		const entries = await readDir(dirPath);
		for (const entry of entries) {
			if (isHidden(entry.name)) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory) {
				await scan(
					dirPath.replace(/[/\\]$/, '') + (dirPath.includes('\\') ? '\\' : '/') + entry.name,
					rel
				);
			} else {
				results.push(rel);
			}
		}
	}

	await scan(path, '');
	return results;
}

/** Scan a folder for files matching a name (case-insensitive). Uses git ls-files, falls back to readDir. Tauri only. */
export async function scanFolderFiles(
	path: string,
	filterName?: string
): Promise<Array<{ name: string; path: string }>> {
	if (!isTauri) return [];
	try {
		const files = await gitLsFiles(path) ?? await readDirRecursive(path);
		const sep = path.includes('\\') ? '\\' : '/';
		const base = path.replace(/[/\\]$/, '');
		return files
			.filter(f => !filterName || f.split('/').pop()!.toLowerCase() === filterName.toLowerCase())
			.map(f => ({ name: f, path: base + sep + f.replace(/\//g, sep) }));
	} catch (e) {
		console.warn('Failed to scan folder:', e);
		return [];
	}
}

/** List all files in a folder recursively, returning relative paths. Uses git ls-files, falls back to readDir. Tauri only. */
export async function listFolderFiles(path: string): Promise<string[]> {
	if (!isTauri) return [];
	try {
		return await gitLsFiles(path) ?? await readDirRecursive(path);
	} catch (e) {
		console.warn('Failed to list folder files:', e);
		return [];
	}
}

/** Open a file with the system's default application. Tauri only. */
export async function openExternal(path: string, cwd?: string): Promise<void> {
	if (!isTauri) return;
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('open_external', { path, cwd: cwd || null });
}

/**
 * Folder passed on the command line at launch (`nugram <path>` or `nugram .`),
 * resolved to an absolute path by the backend. Null when none / not Tauri.
 */
export async function getLaunchFolder(): Promise<string | null> {
	if (!isTauri) return null;
	const { invoke } = await import('@tauri-apps/api/core');
	return (await invoke<string | null>('get_launch_folder')) ?? null;
}
