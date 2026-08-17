/** Cross-tool helpers: error formatting, path validation, file locking, line ranges. */

/** Tauri's IPC rejects with bare strings, so `error.message` alone renders as "undefined". */
export const errMsg = (e: any) => e?.message || String(e);

const isWindows = navigator.platform?.startsWith('Win') ?? false;
const unixPathOnWindows = (p: string) => isWindows && /^\/(?![A-Za-z]:)/.test(p);

let _fsModule: Promise<typeof import('@tauri-apps/plugin-fs')> | null = null;
export function getTauriFs() {
	if (!_fsModule) _fsModule = import('@tauri-apps/plugin-fs');
	return _fsModule;
}

let _coreModule: Promise<typeof import('@tauri-apps/api/core')> | null = null;
export function getTauriCore() {
	if (!_coreModule) _coreModule = import('@tauri-apps/api/core');
	return _coreModule;
}

// Per-path mutex for file-mutating tools. Tool calls in a turn run via
// Promise.all, so two edit_file calls to the same file would otherwise both
// read the original, apply their own edits, and have the later write clobber
// the earlier (silent lost update). Acquiring this serializes same-file
// read-modify-write; different files stay concurrent. Returns a release fn.
const _fileLocks = new Map<string, Promise<void>>();
export async function acquireFileLock(rawKey: string): Promise<() => void> {
	const key = rawKey.toLowerCase().replace(/\\/g, '/');
	const prev = _fileLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>(r => { release = r; });
	const tail = prev.then(() => next);
	_fileLocks.set(key, tail);
	await prev;
	return () => {
		release();
		// Drop the entry once this lock is the last in the chain.
		if (_fileLocks.get(key) === tail) _fileLocks.delete(key);
	};
}

const BINARY_EXTENSIONS = new Set([
	// Images
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.tif', '.avif',
	// Audio/Video
	'.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mkv', '.mov', '.wmv', '.webm', '.m4a', '.aac',
	// Archives
	'.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.zst',
	// Executables/Libraries
	'.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.app', '.dmg', '.deb', '.rpm',
	// Compiled/Object
	'.o', '.obj', '.class', '.pyc', '.pyo', '.wasm',
	// Databases
	'.db', '.sqlite', '.sqlite3',
	// Documents (binary)
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	// Fonts
	'.ttf', '.otf', '.woff', '.woff2', '.eot',
	// Other
	'.iso', '.img',
]);

/** Images a vision model can be shown directly — readable, never editable. */
const VIEWABLE_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);

export function imageMime(path: string): string | undefined {
	const ext = ('.' + path.split('.').pop()!).toLowerCase();
	if (!VIEWABLE_IMAGES.has(ext)) return undefined;
	return ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
}

/**
 * Validate and resolve a tool-supplied file path: rejects Unix paths on
 * Windows, ".." traversal and binary extensions; resolves relative paths
 * against the chat folder. Images pass for reading — they come back as
 * attachments rather than text.
 */
export function resolveToolPath(filePath: string | undefined, chatFolder: string | undefined, verb: 'read' | 'edit'): { path: string } | { error: string } {
	if (!filePath) return { error: 'Error: path is required' };
	if (unixPathOnWindows(filePath))
		return { error: `Error: "${filePath}" looks like a Unix path. On Windows, use native paths (e.g. C:/...). Check shell output for the real path.` };
	if (filePath.includes('..'))
		return { error: 'Error: path must not contain ".." traversal. Use an absolute path or a path within the folder.' };

	const isAbsolute = /^[A-Za-z]:[\\/]|^\//.test(filePath);
	let resolvedPath = filePath;
	if (!isAbsolute) {
		if (!chatFolder)
			return { error: 'Error: relative path given but no chat folder is set. Set a working folder in the sidebar, or use an absolute path.' };
		const sep = chatFolder.includes('\\') ? '\\' : '/';
		resolvedPath = chatFolder.replace(/[/\\]$/, '') + sep + filePath.replace(/[/\\]/g, sep);
	}

	const ext = ('.' + resolvedPath.split('.').pop()!).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext) && !(verb === 'read' && VIEWABLE_IMAGES.has(ext)))
		return { error: `Not a text file (${ext}). Cannot ${verb} binary files.` };

	return { path: resolvedPath };
}

// mainly opus 4.8 funnily enough keeps doing [1, 2] or "12:22" instead of plain
export function normalizeRange(range: unknown): string | undefined {
	if (typeof range !== 'string') return undefined;
	return range.replace(/[[\]"\s]/g, '').replace(/,/g, ':');
}

export function parseLineRange(range: string, totalLines: number): [number, number] | null {
	const colon = range.indexOf(':');
	if (colon === -1) return null;
	const startStr = range.slice(0, colon).trim();
	const endStr = range.slice(colon + 1).trim();
	let start = startStr ? parseInt(startStr, 10) : 1;
	let end = endStr ? parseInt(endStr, 10) : totalLines;
	if (isNaN(start) || isNaN(end)) return null;
	// Negative indices count from end
	if (start < 0) start = Math.max(1, totalLines + start + 1);
	if (end < 0) end = Math.max(0, totalLines + end + 1);
	// Convert from 1-indexed lines to 0-indexed slice bounds
	start = Math.max(0, Math.min(start - 1, totalLines));
	end = Math.max(0, Math.min(end, totalLines));
	if (start > end) return null;
	return [start, end];
}
