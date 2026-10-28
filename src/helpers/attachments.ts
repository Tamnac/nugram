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
import type { ChatMessage, FileAttachment, ToolData } from './types';
import { dataUrlImageDims, type ImageDims } from './tokens';
import { readFileData, type FileContentData } from './fileContent';
import type { Backend } from './backend';

export interface StoredImage {
	mime: string;
	/** base64, no data-URL prefix */
	data: string;
}

/**
 * Pruning only reclaims orphans older than this. Far longer than the dirty-message
 * flush, so an attachment saved by another window/tab whose referencing message
 * isn't persisted yet is never collected.
 */
export const ORPHAN_PRUNE_AGE = 24 * 3_600_000;

/** Lowest max I could find, opux pre 4.7's max */
const MAX_DIM = 1568;
/** Images at or under this size are stored as-is if they also fit MAX_DIM. */
const KEEP_ORIGINAL_BYTES = 300_000;

/** id → data URL. Stored images are immutable, so entries never go stale. */
const resolved = new Map<string, string>();

/** id → blob object URL. Separate from `resolved` (those data URLs go to APIs/exports);
 *  object URLs keep multi-MB images out of CSS/DOM strings, which WebViews silently reject. */
const objectUrls = new Map<string, string>();

/** ref → pixel dims (post-compress — what providers actually receive). */
const dims = new Map<string, ImageDims>();

/** Known pixel dimensions of an image ref, when determinable (never for bare http(s) URLs). */
export function imageDims(ref: string): ImageDims | undefined {
	const known = dims.get(ref);
	if (known) return known;
	const url = ref.startsWith('data:') ? ref : resolved.get(ref);
	const found = url ? dataUrlImageDims(url) : undefined;
	if (found) dims.set(ref, found);
	return found;
}

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
async function compress(file: Blob): Promise<{ img: StoredImage; dims?: ImageDims | undefined }> {
	const original = async (dims?: ImageDims) => ({ img: { mime: file.type || 'image/png', data: await blobToBase64(file) } as StoredImage, dims });
	if (file.type === 'image/svg+xml') return original();

	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return original();
	}

	const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
	if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES) {
		const atScale = { w: bitmap.width, h: bitmap.height };
		bitmap.close();
		return original(atScale);
	}

	const canvas = document.createElement('canvas');
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();

	// Re-encode-only images (already within MAX_DIM — often screenshots with small text) get
	// the higher quality; downscaled ones already lost resolution, so 0.85 suffices.
	const encoded = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/webp', scale === 1 ? 0.92 : 0.85));
	const atScale = { w: canvas.width, h: canvas.height };
	if (!encoded || encoded.size >= file.size) return original(atScale);
	return { img: { mime: 'image/webp', data: await blobToBase64(encoded) }, dims: atScale };
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
	const { img, dims: d } = await compress(file);
	const id = crypto.randomUUID();
	await putAttachment(id, img);
	resolved.set(id, toDataUrl(img));
	if (d) dims.set(id, d);
	return id;
}

/** Store an image file at original quality (e.g. chat backgrounds — it's for viewing, not the model). Returns the attachment id. */
export async function storeImageOriginal(file: Blob): Promise<string> {
	const id = crypto.randomUUID();
	const img: StoredImage = { mime: file.type || 'image/png', data: await blobToBase64(file) };

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
	const d = dataUrlImageDims(url);
	if (d) dims.set(id, d);
	return id;
}

/** Resolve a stored attachment to a blob: URL for local-only rendering (chat background). */
export async function attachmentObjectUrl(ref: string): Promise<string | undefined> {
	if (isLiteralImage(ref)) return ref;
	const cached = objectUrls.get(ref);
	if (cached) return cached;
	const img = await fetchAttachment(ref);
	if (!img) return undefined;
	const bytes = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
	const url = URL.createObjectURL(new Blob([bytes], { type: img.mime }));
	objectUrls.set(ref, url);
	return url;
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

/**
 * Walk every attachment reference a message carries: images, files, tool-result images.
 * `nested` includes images of tool calls made inside a run_js log, which the API never sees.
 */
async function mapAttachments(messages: ChatMessage[], image: Mapper<string>, file: Mapper<FileAttachment>, nested = true): Promise<void> {
	for (const msg of messages) {
		if (msg.images) msg.images = await Promise.all(msg.images.map(version => mapAll(version, image)));
		if (msg.files) msg.files = await Promise.all(msg.files.map(version => mapAll(version, file)));

		for (const version of msg.tool_results || [])
			for (const result of version || [])
				if (result.data) result.data = await mapResultImages(result.data, image, nested);
	}
}

async function mapResultImages(data: ToolData, image: Mapper<string>, nested: boolean): Promise<ToolData> {
	let out = data;
	if (data.images) out = { ...out, images: await mapAll(data.images, image) };
	if (nested && Array.isArray(data.log) && data.log.some((e: any) => e?.result?.data))
		out = {
			...out,
			log: await Promise.all(data.log.map(async (e: any) => e?.result?.data
				? { ...e, result: { ...e.result, data: await mapResultImages(e.result.data, image, false) } }
				: e)),
		};
	return out;
}

/**
 * Replace attachment ids with the data they point at, in place — pass a copy, not the
 * store. Used before sending to the API and before exporting. Unresolvable images are
 * dropped; files stay and render as a placeholder (see fileBlock).
 */
/** Collect every stored attachment id the messages reference (literal data:/http refs excluded). */
export async function collectAttachmentRefs(messages: ChatMessage[]): Promise<Set<string>> {
	const refs = new Set<string>();
	await mapAttachments(
		messages,
		async ref => { if (!isLiteralImage(ref)) refs.add(ref); return ref; },
		async file => { refs.add(file.id); return file; }
	);
	for (const msg of messages)
		for (const version of msg.tool_results || [])
			for (const result of version || [])
				if (typeof result.data?.state === 'string') refs.add(result.data.state);
	return refs;
}

/** `nested: false` skips run_js log images (requests: the model never sees them). */
export function inlineAttachments(messages: ChatMessage[], opts: { nested?: boolean } = {}): Promise<void> {
	return mapAttachments(messages, imageSrc, async file => ({ ...file, data: await loadTextFile(file) }), opts.nested ?? true);
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

const JS_STATE_MIME = 'application/x-nugram-js-state';

/** Store a run_js globals snapshot under its content-addressed id (see jsRuntime/state.ts). */
export function saveJsState(id: string, text: string): Promise<void> {
	return putAttachment(id, { mime: JS_STATE_MIME, data: text });
}

export async function loadJsState(id: string): Promise<string | undefined> {
	const stored = await fetchAttachment(id);
	return stored?.mime === JS_STATE_MIME ? stored.data : undefined;
}

/**
 * Read a file and keep it as an immutable snapshot, for the input's @ dropdown. Image
 * files go down the image path instead — the model can look at them either way.
 */
export async function attachFile(path: string, chatFolder: string, backend: Backend): Promise<{ file: FileAttachment } | { images: string[] }> {
	const data = await readFileData({ path }, chatFolder, attachImage, backend);
	if (data.error) throw new Error(data.error);
	if (data.images) return { images: data.images };
	// keep the path as the user picked it (relative to the chat folder), not the resolved one
	return { file: await storeTextFile({ ...(data as FileContentData), path }) };
}
