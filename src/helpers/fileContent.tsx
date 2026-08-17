/**
 * Reading, formatting and rendering text files. Shared by the read_file tool and by file
 * attachments, which are snapshots of the same data taken when a file is picked from the
 * input's @ dropdown.
 */

import type { ToolData } from './types';
import { getTauriFs, imageMime, normalizeRange, parseLineRange, resolveToolPath } from './tools/shared';

/** Cap on one file's formatted output, line gutter included. */
const MAX_CHARS = 50_000;
const TRUNCATION_NOTICE = `\n...[truncated at ${MAX_CHARS / 1000}KB]`;

export interface FileContentData {
	path: string;
	body: string;
	start: number;
	end: number;
	total: number;
	truncated?: boolean;
}

/** A stored attachment, or freshly read data that doesn't have an id yet. */
type FileRef = { path: string; data?: FileContentData | undefined };

/**
 * Read a file for the read_file tool or for an attachment. Images are handed to
 * `attachImage` (passed in, so this module stays independent of the attachment store)
 * and come back as ids; everything else is read as text.
 */
export async function readFileData(
	args: any,
	chatFolder: string | undefined,
	attachImage: (file: Blob) => Promise<string>,
): Promise<ToolData> {
	try {
		if (args?.range) {
			const normalized = normalizeRange(args.range);
			if (normalized) args.range = normalized;
		}
		const resolved = resolveToolPath(args?.path, chatFolder, 'read');
		if ('error' in resolved) return { ok: false, reason: 'invalid_path', error: resolved.error };
		const resolvedPath = resolved.path;

		const { readFile, readTextFile, stat } = await getTauriFs();
		try {
			const info = await stat(resolvedPath);
			if (info.isDirectory)
				return { ok: false, reason: 'is_directory', error: `Error: "${args.path}" is a directory, not a file.` };
		} catch (error: any) {
			return { ok: false, reason: 'not_found', error: `Error reading file: ${error.message || error}` };
		}

		const mime = imageMime(resolvedPath);
		if (mime) {
			const bytes = await readFile(resolvedPath);
			const id = await attachImage(new Blob([bytes as BlobPart], { type: mime }));
			return { path: resolvedPath, images: [id], bytes: bytes.byteLength };
		}

		const raw = await readTextFile(resolvedPath);
		if (!args?.range) return createFileContentData(raw, resolvedPath);

		const allLines = raw.split('\n');
		const parsed = parseLineRange(args.range, allLines.length);
		if (!parsed)
			return { ok: false, reason: 'invalid_args', error: `Error: invalid line range "${args.range}". Use format "start:end" with 1-indexed lines, e.g. "5:15" or "10:" or ":20".` };
		const [start, end] = parsed;
		return createFileContentData(allLines.slice(start, end).join('\n'), resolvedPath, start, allLines.length);
	} catch (error: any) {
		return { ok: false, reason: 'read_failed', error: `Error reading file: ${error.message || error}` };
	}
}

export function createFileContentData(raw: string, path: string, start = 0, sourceTotal?: number): FileContentData {
	const allLines = raw.split('\n');
	const total = sourceTotal ?? start + allLines.length;
	let end = start + allLines.length;
	let body = raw;
	const truncated = body.length + countGutterChars(start, end) > MAX_CHARS;

	if (truncated) {
		let budget = MAX_CHARS;
		let kept = 0;
		let lineNo = start + 1;
		for (const line of allLines) {
			const cost = String(lineNo).length + 1 + line.length + 1;
			if (budget - cost < 0) break;
			budget -= cost;
			kept += line.length + 1;
			lineNo++;
		}
		if (kept === 0) {
			body = body.slice(0, Math.max(0, budget - String(lineNo).length - 1));
			end = start + 1;
		} else {
			body = body.slice(0, kept - 1);
			end = lineNo - 1;
		}
	}

	return { path, body, start, end, total, ...(truncated && { truncated }) };
}

export function formatFileContent(data: FileContentData): string {
	const numbered = data.body.split('\n').map((line, j) => `${data.start + j + 1}\u2502${line}`).join('\n');
	return `${fileHeader(data)}\n\n${numbered}${data.truncated ? TRUNCATION_NOTICE : ''}`;
}

export function fileHeader(data: FileContentData): string {
	const rangeInfo = (data.start > 0 || data.end < data.total)
		? ` (lines ${data.start + 1}\u2013${data.end} of ${data.total})`
		: ` (${data.total} lines)`;
	return `${data.path}${rangeInfo}`;
}

/**
 * The `<file>` block an attachment contributes to its message's text. `summary` keeps only
 * the header line, for markdown export previews. A body that failed to load still gets a
 * block, so the model isn't left wondering where the file the user referenced went.
 */
export function fileBlock(file: FileRef, summary = false): string {
	if (!file.data) {
		if (!summary) console.warn('File attachment body missing, sending a placeholder for', file.path);
		return `<file>${file.path} (content unavailable)</file>`;
	}
	if (summary) return `<file>${fileHeader(file.data)}</file>`;
	return `<file>\n${formatFileContent(file.data)}\n</file>`;
}

export function FileContent(props: { data: FileContentData }) {
	return (
		<div class='toolResultContent'>
			<div style={{ opacity: '0.6', 'margin-bottom': '4px' }}>{fileHeader(props.data)}</div>
			<pre style={{ margin: '0', 'white-space': 'pre-wrap', 'word-break': 'break-all' }}>
				{props.data.body + (props.data.truncated ? TRUNCATION_NOTICE : '')}
			</pre>
		</div>
	);
}

function countGutterChars(startLine: number, endLine: number): number {
	let total = 0;
	for (let n = startLine + 1; n <= endLine; n++) total += String(n).length + 1;
	return total;
}
