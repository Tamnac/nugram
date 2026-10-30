/**
 * Folder of images messages reference by name: `![](pic.png)` resolves even when the
 * file sits at `art/refs/pic.png`. The folder is always on this machine — remote
 * backends never serve it. Desktop keeps the path in ChatMeta and reads through
 * localBackend; web holds a File System Access handle in IndexedDB (single chat).
 *
 * The name→path index is built on the first lookup or completion, not on chat switch,
 * and rebuilt when a lookup misses so files added later stop being broken.
 */
import { createSignal } from 'solid-js';
import { localBackend, listFiles, joinPath } from './backend';
import { isTauri } from './platform';
import { messageStorage } from './storage';

export type ImageSource =
	| { kind: 'path'; path: string }
	| { kind: 'handle'; handle: FileSystemDirectoryHandle };

const MIME: Record<string, string> = {
	jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
	webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const REBUILD_COOLDOWN_MS = 10_000;

const [source, setSource] = createSignal<ImageSource | null>(null);
export { source as imageSource };

export const imageFolderLabel = () => {
	const s = source();
	return s ? (s.kind === 'path' ? s.path : s.handle.name) : undefined;
};

interface ImageIndex {
	refs: Map<string, string>;
	paths: string[];
}

let index: Promise<ImageIndex> | null = null;
let indexPending = false;
let buildToken = 0;
let builtAt = 0;
const urls = new Map<string, string>();

export function setImageSource(next: ImageSource | null) {
	const cur = source();
	if (cur === next) return;
	if (cur?.kind === 'path' && next?.kind === 'path' && cur.path === next.path) return;

	index = null;
	indexPending = false;
	builtAt = 0;
	buildToken++;
	for (const url of urls.values()) URL.revokeObjectURL(url);
	urls.clear();
	setSource(() => next);
}

/** Open the folder picker. False when the user cancelled. */
export async function pickImageFolder(): Promise<boolean> {
	if (isTauri) {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const dir = await open({ directory: true });
		if (typeof dir !== 'string') return false;
		setImageSource({ kind: 'path', path: dir });
		return true;
	}

	if (!(window as any).showDirectoryPicker)
		throw new Error('This browser has no directory picker — use Chrome or Edge');
	try {
		const handle = await (window as any).showDirectoryPicker();
		await messageStorage.saveImageFolderHandle(handle);
		setImageSource({ kind: 'handle', handle });
		return true;
	} catch (err) {
		if ((err as any)?.name === 'AbortError') return false;
		throw err;
	}
}

export async function clearImageFolder() {
	setImageSource(null);
	if (!isTauri) await messageStorage.deleteImageFolderHandle();
}

/** Web only: re-adopt the saved handle on load. Reading it needs the permission grant to
 *  have survived; re-granting takes a click, so a stale one just shows as a missing image. */
export async function restoreWebImageFolder() {
	const handle = await messageStorage.loadImageFolderHandle().catch(err => {
		console.warn('Failed to load image folder handle:', err);
		return null;
	});
	if (handle) setImageSource({ kind: 'handle', handle });
}

/** Cached relative image paths, refreshing a stale listing when completion opens. */
export async function listImagePaths(): Promise<string[]> {
	const s = source();
	if (!s) return [];
	if (index && !indexPending && Date.now() - builtAt > REBUILD_COOLDOWN_MS) index = null;
	const result = await getIndex(s);
	return source() === s ? result.paths : [];
}

/** Object URL for a reference written in a message, or null when nothing matches. */
export async function resolveImageUrl(ref: string): Promise<string | null> {
	const s = source();
	if (!s) return null;

	let rel = lookup((await getIndex(s)).refs, ref);
	if (source() !== s) return null;
	if (!rel && Date.now() - builtAt > REBUILD_COOLDOWN_MS) {
		index = null;
		rel = lookup((await getIndex(s)).refs, ref);
	}
	if (!rel || source() !== s) return null;

	const cached = urls.get(rel);
	if (cached) return cached;

	const blob = s.kind === 'path' ? await readPath(s.path, rel) : await readHandle(s.handle, rel);
	if (source() !== s) return null; // folder changed while reading
	return urls.get(rel) ?? set(urls, rel, URL.createObjectURL(blob));
}

const set = (map: Map<string, string>, key: string, value: string) => (map.set(key, value), value);

async function getIndex(s: ImageSource): Promise<ImageIndex> {
	if (!index) {
		// Cache failed scans through the cooldown so an unreadable folder doesn't rescan on every keystroke.
		const token = ++buildToken;
		indexPending = true;
		index = buildIndex(s)
			.catch(err => {
				console.warn('Image folder scan failed:', err);
				return { refs: new Map<string, string>(), paths: [] };
			})
			.finally(() => {
				if (token === buildToken) {
					builtAt = Date.now();
					indexPending = false;
				}
			});
	}
	return index;
}

/** Every image keyed by its path relative to the folder and by its bare name. */
async function buildIndex(s: ImageSource): Promise<ImageIndex> {
	const files = s.kind === 'path'
		? (await listFiles(localBackend, s.path, { git: false })).filter(isImage)
		: await walkHandle(s.handle);

	const map = new Map<string, string>();
	for (const rel of files) {
		const key = rel.toLowerCase();
		add(map, key, rel);
		add(map, key.slice(key.lastIndexOf('/') + 1), rel);
	}
	return { refs: map, paths: files.sort() };
}

/** Shallowest match wins, then alphabetical — same folder must always give the same picture. */
function add(map: Map<string, string>, key: string, rel: string) {
	const prev = map.get(key);
	if (!prev || better(rel, prev)) map.set(key, rel);
}

function better(a: string, b: string): boolean {
	const depth = (p: string) => p.split('/').length;
	return depth(a) === depth(b) ? a < b : depth(a) < depth(b);
}

function lookup(map: Map<string, string>, ref: string): string | undefined {
	let key = ref.replace(/\\/g, '/').replace(/^\.\//, '');
	try { key = decodeURIComponent(key); } catch { /* not percent-encoded */ }
	key = key.toLowerCase();

	const hit = map.get(key);
	if (hit || !key.includes('/')) return hit;

	// A partial path: `refs/pic.png` should still find `art/refs/pic.png`.
	let best: string | undefined;
	for (const rel of map.values())
		if (rel.toLowerCase().endsWith('/' + key) && (!best || better(rel, best))) best = rel;
	return best;
}

const isImage = (name: string) => extOf(name) in MIME;
const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

async function readPath(root: string, rel: string): Promise<Blob> {
	const bytes = await localBackend.readBinary(joinPath(root, rel, localBackend.paths));
	return new Blob([bytes as BlobPart], { type: MIME[extOf(rel)] });
}

async function readHandle(root: FileSystemDirectoryHandle, rel: string): Promise<Blob> {
	const parts = rel.split('/');
	let dir = root;
	for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
	return (await dir.getFileHandle(parts[parts.length - 1]!)).getFile();
}

async function walkHandle(root: FileSystemDirectoryHandle): Promise<string[]> {
	const files: string[] = [];
	async function scan(dir: FileSystemDirectoryHandle, prefix: string) {
		for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
			if (entry.name.startsWith('.')) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.kind === 'directory') await scan(entry as FileSystemDirectoryHandle, rel);
			else if (isImage(entry.name)) files.push(rel);
		}
	}
	await scan(root, '');
	return files;
}
