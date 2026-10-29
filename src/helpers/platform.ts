/**
 * Platform abstraction layer.
 * Each function detects Tauri at runtime and branches accordingly.
 * Dynamic imports keep @tauri-apps/* out of the web bundle entirely.
 *
 * Folder/file reads take an optional Backend and default to the local one —
 * imported dynamically to avoid a cycle: backend/local.ts imports isTauri from here.
 */
import type { Backend } from './backend';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let pendingNativeDialogs = 0;
export function hasPendingNativeDialog(): boolean {
	return pendingNativeDialogs > 0;
}

async function withNativeDialog<T>(open: () => Promise<T>): Promise<T> {
	pendingNativeDialogs++;
	try {
		return await open();
	} finally {
		pendingNativeDialogs--;
	}
}

/** Save a file via platform-native dialog. perChat: open in (and update) the
 *  current chat's remembered export folder. */
export interface FileFilter {
	description: string;
	extensions: string[];
}

// each chat remembers its own export folder.
let exportScope = '';
export function setExportScope(chatId: string) {
	exportScope = chatId;
}

export async function saveFileDialog(
	content: string,
	suggestedName: string,
	filters?: FileFilter[],
	perChat = false,
): Promise<boolean> {
	if (isTauri) {
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const { writeTextFile } = await import('@tauri-apps/plugin-fs');
			const { dirname, join } = await import('@tauri-apps/api/path');
			const lastDir = perChat && exportScope ? localStorage.getItem(`export_dir:${exportScope}`) : null;
			const defaultPath = lastDir ? await join(lastDir, suggestedName) : suggestedName;
			const path = await withNativeDialog(() => save({
				defaultPath,
				...(filters ? {
					filters: filters.map(f => ({ name: f.description, extensions: f.extensions.map(e => e.replace(/^\./, '')) })),
				} : {}),
			}));
			if (path) {
				if (perChat && exportScope) localStorage.setItem(`export_dir:${exportScope}`, await dirname(path));
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
				...(perChat && exportScope ? { id: `e-${exportScope}`.slice(0, 32) } : {}),
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
			const path = await withNativeDialog(() => save({ defaultPath: suggestedName }));
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
		return withNativeDialog(() => ask(message));
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
		const path = await withNativeDialog(() => open({ directory: true, multiple: false }));
		return path as string | null;
	} catch {
		return null;
	}
}

async function defaultBackend(): Promise<Backend> {
	return (await import('./backend')).localBackend;
}

/** Read a text file from disk. Tauri only. */
export async function readFileText(path: string, backend?: Backend): Promise<string> {
	return (backend ?? await defaultBackend()).readText(path);
}

/** List a directory's immediate entries. Throws if it doesn't exist. Tauri only. */
export async function readDirEntries(path: string, backend?: Backend): Promise<Array<{ name: string; isDirectory: boolean }>> {
	return (backend ?? await defaultBackend()).readDir(path);
}

/** Scan a folder for files matching a name (case-insensitive). Tauri only. */
export async function scanFolderFiles(
	path: string,
	filterName?: string,
	backend?: Backend
): Promise<Array<{ name: string; path: string }>> {
	if (!isTauri) return [];
	const b = backend ?? await defaultBackend();
	const { listFiles, joinPath } = await import('./backend');
	try {
		const base = path.replace(/[/\\]$/, '');
		return (await listFiles(b, path))
			.filter(f => !filterName || f.split('/').pop()!.toLowerCase() === filterName.toLowerCase())
			.map(f => ({ name: f, path: joinPath(base, f, b.paths) }));
	} catch (e) {
		console.warn('Failed to scan folder:', e);
		return [];
	}
}

/** List all files in a folder recursively, returning relative paths. Tauri only. */
export async function listFolderFiles(path: string, backend?: Backend): Promise<string[]> {
	if (!isTauri) return [];
	const { listFiles } = await import('./backend');
	try {
		return await listFiles(backend ?? await defaultBackend(), path);
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

/** Initial user prompt passed via `nugram -p`, auto-sent in a fresh chat. Null when none / not Tauri. */
export async function getLaunchPrompt(): Promise<string | null> {
	if (!isTauri) return null;
	const { invoke } = await import('@tauri-apps/api/core');
	return (await invoke<string | null>('get_launch_prompt')) ?? null;
}
