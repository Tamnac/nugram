/**
 * Message attachments: images, and text-file snapshots taken when a file is picked from
 * the input's @ dropdown.
 *
 * Messages hold attachment ids (or literal `data:`/`http` URLs); the bytes live in a
 * separate store — SQLite `attachments` on Tauri, an IndexedDB object store on web — so
 * message rows stay small and loading a chat doesn't pull attachment bodies into memory.
 * Both kinds share that store; the mime tells them apart.
 *
 * Ids are resolved on demand: for rendering, for the API request, and when exporting
 * (exports inline the data so the file is self-contained).
 */

import { isTauri } from './platform';
import type { ChatMessage, FileAttachment } from './types';
import { readFileData, type FileContentData } from './fileContent';

export interface StoredImage {
	mime: string;
	/** base64, no data-URL prefix */
	data: string;
}

/** Longest edge kept when re-encoding. Above this most models downscale anyway. */
const MAX_DIM = 1568;
/** Images at or under this size are stored as-is if they also fit MAX_DIM. */
const KEEP_ORIGINAL_BYTES = 300_000;

/** id → data URL. Stored images are immutable, so entries never go stale. */
const resolved = new Map<string, string>();

export function isLiteralImage(ref: string): boolean {
	return /^(data:|https?:)/i.test(ref);
}

function toDataUrl(img: StoredImage): string {
	return `data:${img.mime};base64,${img.data}`;
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/** Downscale to MAX_DIM and re-encode as webp. Returns the original when it's already small. */
async function compress(file: Blob): Promise<StoredImage> {
	const original = async (): Promise<StoredImage> => ({ mime: file.type || 'image/png', data: await blobToBase64(file) });
	if (file.type === 'image/svg+xml') return original();

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return original();
	}

	const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
	if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES) {
		bitmap.close();
		return original();
	}

	const canvas = document.createElement('canvas');
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();

	const encoded = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/webp', 0.85));
	if (!encoded || encoded.size >= file.size) return original();
	return { mime: 'image/webp', data: await blobToBase64(encoded) };
}

async function putAttachment(id: string, value: StoredImage): Promise<void> {
	if (isTauri) {
		const { initDatabase, saveAttachment } = await import('./db');
		await initDatabase();
		await saveAttachment(id, value.mime, value.data);
		return;
	}
	const { messageStorage } = await import('./storage');
	await messageStorage.saveAttachment(id, value);
}

async function fetchAttachment(id: string): Promise<StoredImage | null> {
	if (isTauri) {
		const { initDatabase, loadAttachment } = await import('./db');
		await initDatabase();
		return loadAttachment(id);
	}
	const { messageStorage } = await import('./storage');
	return messageStorage.loadAttachment(id);
}

/** Compress and store an image file. Returns the attachment id to put on a message. */
export async function attachImage(file: Blob): Promise<string> {
	const img = await compress(file);
	const id = crypto.randomUUID();
	await putAttachment(id, img);
	resolved.set(id, toDataUrl(img));
	return id;
}

/** Image files from a paste or drop, stored. Returns their attachment ids. */
export async function attachFromTransfer(data: DataTransfer | null): Promise<string[]> {
	const files = Array.from(data?.files ?? []).filter(f => f.type.startsWith('image/'));
	if (!files.length) return [];
	return Promise.all(files.map(attachImage));
}

/** Store an already-encoded data URL (import path). Returns its attachment id. */
export async function storeDataUrl(url: string): Promise<string> {
	const match = /^data:([^;,]+);base64,(.*)$/is.exec(url);
	if (!match) throw new Error('Not a base64 data URL');
	const id = crypto.randomUUID();
	await putAttachment(id, { mime: match[1], data: match[2] });
	resolved.set(id, url);
	return id;
}

/** Resolve a message image reference to something usable as an `<img src>` or API url. */
export async function imageSrc(ref: string): Promise<string | undefined> {
	if (isLiteralImage(ref)) return ref;
	const cached = resolved.get(ref);
	if (cached) return cached;
	try {
		const img = await fetchAttachment(ref);
		if (!img) return undefined;
		const url = toDataUrl(img);
		resolved.set(ref, url);
		return url;
	} catch (err) {
		console.error('Failed to load attachment', ref, err);
		return undefined;
	}
}

type Mapper<T> = (value: T) => Promise<T | undefined>;

async function mapAll<T>(values: T[] | undefined, map: Mapper<T>): Promise<T[]> {
	const mapped = await Promise.all((values || []).map(map)) as (T | undefined)[];
	return mapped.filter((value): value is T => value !== undefined);
}

/** Walk every attachment reference a message carries: images, files, tool-result images. */
async function mapAttachments(messages: ChatMessage[], image: Mapper<string>, file: Mapper<FileAttachment>): Promise<void> {
	for (const msg of messages) {
		if (msg.images) msg.images = await Promise.all(msg.images.map(version => mapAll(version, image)));
		if (msg.files) msg.files = await Promise.all(msg.files.map(version => mapAll(version, file)));

		for (const version of msg.tool_results || [])
			for (const result of version || [])
				if (result.data?.images)
					result.data = { ...result.data, images: await mapAll(result.data.images, image) };
	}
}

/**
 * Replace attachment ids with the data they point at, in place — pass a copy, not the
 * store. Used before sending to the API and before exporting. Unresolvable images are
 * dropped; files stay and render as a placeholder (see fileBlock).
 */
export function inlineAttachments(messages: ChatMessage[]): Promise<void> {
	return mapAttachments(messages, imageSrc, async file => ({ ...file, data: await loadTextFile(file) }));
}

/** Move inlined data back into the attachment store, in place. Used when importing a chat. */
export function ingestAttachments(messages: ChatMessage[]): Promise<void> {
	return mapAttachments(
		messages,
		async ref => ref.startsWith('data:') ? storeDataUrl(ref).catch(() => undefined) : ref,
		async file => file.data ? storeTextFile(file.data, file.id) : file
	);
}

/** Images of a message's current version, or undefined when it has none. */
export function getMessageImages(msg: ChatMessage): string[] | undefined {
	const images = msg.images?.[msg.currentVersionIndex || 0];
	return images?.length ? images : undefined;
}

/** Files of a message's current version, or undefined when it has none. */
export function getMessageFiles(msg: ChatMessage): FileAttachment[] | undefined {
	const files = msg.files?.[msg.currentVersionIndex || 0];
	return files?.length ? files : undefined;
}

const FILE_MIME = 'application/x-nugram-text-file+json';

/** Store a file snapshot. Returns the reference to put on a message. */
export async function storeTextFile(data: FileContentData, id: string = crypto.randomUUID()): Promise<FileAttachment> {
	await putAttachment(id, { mime: FILE_MIME, data: JSON.stringify(data) });
	return { id, path: data.path, chars: data.body.length, ...(data.truncated && { truncated: true }) };
}

export async function loadTextFile(file: FileAttachment): Promise<FileContentData | undefined> {
	if (file.data) return file.data;
	try {
		const stored = await fetchAttachment(file.id);
		if (!stored || stored.mime !== FILE_MIME) return undefined;
		return JSON.parse(stored.data) as FileContentData;
	} catch (err) {
		console.error('Failed to load text attachment', file.id, err);
		return undefined;
	}
}

/**
 * Read a file and keep it as an immutable snapshot, for the input's @ dropdown. Image
 * files go down the image path instead — the model can look at them either way.
 */
export async function attachFile(path: string, chatFolder: string): Promise<{ file: FileAttachment } | { images: string[] }> {
	const data = await readFileData({ path }, chatFolder, attachImage);
	if (data.error) throw new Error(data.error);
	if (data.images) return { images: data.images };
	// keep the path as the user picked it (relative to the chat folder), not the resolved one
	return { file: await storeTextFile({ ...(data as FileContentData), path }) };
}
