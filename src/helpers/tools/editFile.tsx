import { For } from 'solid-js';
import { diffWords } from 'diff';
import { isTauri } from '../platform';
import { applyEdits, type EditOp } from '../editFile';
import { acquireFileLock, getTauriFs, resolveToolPath } from './shared';
import type { ToolModule } from './types';

type EditOutcomeData = { applied: boolean; line?: number | undefined; message: string };

export const editFileTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'edit_file',
			description: "Edit a text file using search-and-replace. Multiple independent edits. File created if it doesn't exist.",
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'File path (relative to current folder, or absolute)'
					},
					edits: {
						type: 'array',
						description: 'Array of edits to apply.',
						items: {
							type: 'object',
							properties: {
								oldText: {
									type: 'string',
									description: 'Exact text to find. Must match exactly once in the file.'
								},
								newText: {
									type: 'string',
									description: 'Replacement text. Use empty string to delete.'
								},
								// disabling after investigation showed no meaningful uplift. Todo remove all codepaths
								// lineHint: {
								// 	type: 'integer',
								// 	description: 'Optional approximate line number to disambiguate when oldText matches multiple locations. Picks the nearest match.'
								// }
							},
							required: ['oldText', 'newText']
						}
					}
				},
				required: ['path', 'edits']
			}
		}
	},
	available: isTauri,

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		let releaseLock: (() => void) | undefined;
		try {
			const edits: EditOp[] = args?.edits;
			if (!edits || !Array.isArray(edits) || edits.length === 0)
				return { ok: false, reason: 'invalid_args', error: 'Error: edits array is required and must not be empty' };

			const resolved = resolveToolPath(args?.path, ctx.chatFolder, 'edit');
			if ('error' in resolved) return { ok: false, reason: 'invalid_path', error: resolved.error };
			const resolvedPath = resolved.path;

			// Serialize read-modify-write per file so concurrent same-file
			// edit_file calls don't clobber each other (released in finally).
			releaseLock = await acquireFileLock(resolvedPath);

			const { readTextFile, writeTextFile, stat, mkdir } = await getTauriFs();

			// Check if path exists and whether it's a file or directory
			let fileExists = false;
			try {
				const info = await stat(resolvedPath);
				if (info.isDirectory)
					return { ok: false, reason: 'is_directory', error: `Error: "${args.path}" is a directory, not a file.` };
				fileExists = true;
			} catch {
				// stat throws if path doesn't exist — that's fine, we'll create it
				fileExists = false;
			}

			if (!fileExists) {
				// Create new file with concatenated newText
				const newContent = edits.map(e => e.newText).join('');

				// Ensure parent directories exist
				const lastSep = Math.max(resolvedPath.lastIndexOf('/'), resolvedPath.lastIndexOf('\\'));
				if (lastSep > 0) {
					const dir = resolvedPath.slice(0, lastSep);
					try { await mkdir(dir, { recursive: true }); } catch (_) { /* may already exist */ }
				}

				if (ctx.requestPermission) {
					const permResult = await ctx.requestPermission(call);
					if (permResult !== true) return { denied: true, message: permResult };
				}
				await writeTextFile(resolvedPath, newContent);
				return { ok: true, path: resolvedPath, created: true, lines: newContent.split('\n').length };
			}

			// Read and normalize
			const rawContent = await readTextFile(resolvedPath);
			const hasBOM = rawContent.charCodeAt(0) === 0xFEFF;
			const stripped = hasBOM ? rawContent.slice(1) : rawContent;
			const hasCRLF = stripped.includes('\r\n');
			const content = stripped.replace(/\r\n/g, '\n');

			const editResult = applyEdits(content, edits);

			// Write back adjusted indentation to tool call args
			for (const [idx, adj] of editResult.adjustments) {
				edits[idx] = { ...edits[idx], oldText: adj.oldText, newText: adj.newText };
			}

			const errors = editResult.outcomes.filter(o => !o.applied).map(o => o.message);
			if (errors.length > 0) console.warn(`edit_file ${resolvedPath}:`, errors.join('\n'));

			const outcomes = editResult.outcomes.map(o => ({ applied: o.applied, line: o.line, message: o.message }));
			const counts = { applied: editResult.applied, failed: editResult.failed, skipped: editResult.skipped, total: edits.length };

			if (editResult.applied === 0)
				return { ok: false, reason: 'no_edits_applied', path: resolvedPath, outcomes, ...counts };

			// Stamp real matched lines onto the tool call (UI-only) for the permission prompt
			call._matchedLines = editResult.outcomes.map(o => o.applied ? o.line : undefined);

			// Ask permission now that we know edits are valid
			if (ctx.requestPermission) {
				const permResult = await ctx.requestPermission(call);
				if (permResult !== true) return { denied: true, message: permResult };
			}

			// Restore line endings and BOM
			let result = editResult.content;
			if (hasCRLF) result = result.replace(/\n/g, '\r\n');
			if (hasBOM) result = '\uFEFF' + result;

			await writeTextFile(resolvedPath, result);

			return { ok: editResult.failed === 0, path: resolvedPath, outcomes, ...counts };
		} catch (error: any) {
			console.error('edit_file error:', error);
			const msg = String(error.message || error);
			const path = args?.path ?? '(unknown)';
			// Provide cleaner messages for common Tauri fs errors
			let userMsg: string;
			if (msg.includes('Access is denied')) {
				userMsg = `Permission denied: cannot write to "${path}". Check that the path is a file (not a directory) and is not read-only.`;
			} else if (msg.includes('cannot traverse directory') || msg.includes('..')) {
				userMsg = `Invalid path: "${path}" — directory traversal (".." not allowed). Use an absolute path or a direct relative path within the chat folder.`;
			} else {
				userMsg = `Error editing file: ${msg}`;
			}
			return { ok: false, reason: 'write_failed', error: userMsg };
		} finally {
			releaseLock?.();
		}
	},

	format: data => {
		if (data.denied) return data.message;
		if (data.created) return `Created new file ${data.path} (${data.lines} lines). All newText concatenated, oldText ignored.`;

		const outcomes = (data.outcomes ?? []) as EditOutcomeData[];
		const errors = outcomes.filter(o => !o.applied).map(o => o.message);
		if (data.applied === 0) {
			return `edit_file: ${data.path}\n` +
				`${data.failed > 0 ? `${data.failed} edit${data.failed > 1 ? 's' : ''} failed` : 'No edits to apply'}` +
				`${data.skipped > 0 ? `, ${data.skipped} skipped` : ''}:\n${errors.join('\n')}`;
		}
		const successLines = outcomes.filter(o => o.applied).map(o => o.message);
		return `edit_file: ${data.path}\n${successLines.join('\n')}` +
			(errors.length > 0 ? `\n${errors.join('\n')}` : '') +
			`\n${data.applied}/${data.total} edits applied` +
			(data.failed > 0 ? `, ${data.failed} failed` : '') +
			(data.skipped > 0 ? `, ${data.skipped} skipped` : '');
	},

	Summary: props => {
		const args = props.call.function.arguments as any;
		if (args.edits !== undefined && !Array.isArray(args.edits))
			return <span>edit <code>{args.path}</code> (malformed)</span>;
		const edits = args.edits as Array<{ oldText: string; newText: string }> | undefined;
		let add = 0, del = 0;
		for (const e of edits ?? []) {
			if (e.oldText) del += e.oldText.split('\n').length;
			if (e.newText) add += e.newText.split('\n').length;
		}
		return <span>edit <code>{args.path}</code>{' '}<span class='diffStat'>+{add || 0} -{del || 0}</span>{edits && edits.length > 1 ? ` (${edits.length} edits)` : ''}</span>;
	},

	failed: (call, result) => {
		const args = call.function.arguments as any;
		// malformed tool call: not an array
		if (args.edits !== undefined && !Array.isArray(args.edits)) return true;
		return !!result?.content && result.content.includes('\u2717'); // failed match
	},

	Args: props => {
		const args = props.call.function.arguments as any;
		// Malformed args (e.g. an LLM sent `edits` as a JSON string): show it raw
		// in red rather than iterating its characters into thousands of empty diffs.
		if (args.edits !== undefined && !Array.isArray(args.edits)) {
			return (
				<div class='toolArgEdit'>
					<div class='shellHeaderFail' style={{ 'margin-bottom': '4px' }}>edit {args.path} — malformed edits</div>
					<pre class='editDiffContent' style={{ opacity: '0.85' }}>{typeof args.edits === 'string' ? args.edits : JSON.stringify(args, null, 2)}</pre>
				</div>
			);
		}
		const edits = args.edits as Array<{ oldText: string; newText: string; lineHint?: number }> | undefined;
		if (!edits?.length) return <span>edit <code>{args.path}</code></span>;

		const isFileCreate = () => props.result?.data?.created
			?? (props.result?.content?.startsWith('Created new file') || false);
		const starts = () => {
			// Real post-edit line of each match: structured data when available,
			// else parsed from a legacy result's text (“✓ edit 1 (line 547)”), else the
			// lines stamped on the call while awaiting permission.
			const outcomes = props.result?.data?.outcomes as EditOutcomeData[] | undefined;
			const lineStarts = new Map<number, number>();
			if (!outcomes && props.result?.content) {
				const re = /edit (\d+) \(lines? (\d+)/g;
				let m;
				while ((m = re.exec(props.result.content))) lineStarts.set(Number(m[1]), Number(m[2]));
			}
			const matchedLines = props.call._matchedLines;
			const out = edits.map((edit, idx) =>
				outcomes?.[idx]?.line ?? lineStarts.get(idx + 1) ?? (isFileCreate() ? 0 : matchedLines?.[idx] ?? edit.lineHint ?? 1));
			if (isFileCreate()) {
				// New files concatenate every newText from line 1, so accumulate.
				let cl = 1;
				for (let idx = 0; idx < edits.length; idx++) {
					out[idx] = cl;
					cl += (edits[idx].newText ?? '').split('\n').length - 1;
				}
			}
			return out;
		};
		return (
			<div class='toolArgEdit'>
				<For each={edits}>
				{(edit, i) => (
					<div class='editDiff'>
						{edits.length > 1 ? <div class='editDiffHeader'>edit {i() + 1}{edit.lineHint != null ? ` · lineHint ${edit.lineHint}` : ''}</div> : edit.lineHint != null ? <div class='editDiffHint'>line {edit.lineHint}</div> : null}
						{renderEditDiff(
							isFileCreate() ? '' : (edit.oldText ?? ''),
							edit.newText ?? '',
							starts()[i()]
						)}
					</div>
				)}
				</For>
			</div>
		);
	},

	Result: props => {
		const lines = () => editFileTool.format(props.data).split('\n');
		return <EditStatus header={lines()[0] || ''} statusLines={lines().slice(1)} />;
	},

	LegacyResult: props => {
		// Parse status lines: ✓/✗/⚠ per edit, plus summary
		const lines = () => props.content.split('\n');
		return <EditStatus header={lines()[0] || ''} statusLines={lines().slice(1)} />;
	},
};

function EditStatus(props: { header: string; statusLines: string[] }) {
	return (
		<div class='toolResultContent'>
			<div style={{ opacity: '0.6', 'margin-bottom': '4px' }}>{props.header.replace(/^edit_file:\s*/, '')}</div>
			{props.statusLines.map(line =>
				<div class={line.startsWith('\u2717') ? 'editStatusFail' : line.startsWith('\u26a0') ? 'editStatusWarn' : 'editStatusOk'}>{line}</div>
			)}
		</div>
	);
}

/**
 * Render an inline diff with word-level highlights.
 * - Pure additions/deletions: line-level background
 * - Paired changes: inline on same line, word-level backgrounds only
 */
function renderEditDiff(oldText: string, newText: string, startLine: number) {
	// Word-level diff gives us the finest granularity, then we fold the inline
	// segments back into visual lines so we can show a line-number gutter.
	type Seg = { type: 'add' | 'del' | 'ctx'; value: string };
	const lines: { segs: Seg[]; hasNew: boolean }[] = [{ segs: [], hasNew: false }];
	for (const part of diffWords(oldText, newText)) {
		const type: Seg['type'] = part.added ? 'add' : part.removed ? 'del' : 'ctx';
		const sub = part.value.split('\n');
		for (let i = 0; i < sub.length; i++) {
			if (i > 0) lines.push({ segs: [], hasNew: false });
			const cur = lines[lines.length - 1];
			if (sub[i] !== '') cur.segs.push({ type, value: sub[i] });
			if (type !== 'del') cur.hasNew = true; // line exists in the new file
		}
	}
	// Drop the trailing empty line produced by a final newline.
	if (lines.length > 1 && lines[lines.length - 1].segs.length === 0) lines.pop();

	// Only lines present in the new file get a number; pure deletions are blank.
	let lineNo = startLine;
	const numbered = lines.map(line => ({ ...line, num: line.hasNew ? lineNo++ : '' }));

	return (
		<div class='editDiffLines'>
			<For each={numbered}>
				{line => <>
					<span class='editDiffNum'>{line.num}</span>
					<span class='editDiffText'>
						{line.segs.map(s =>
							s.type === 'add' ? <ins class='diffAdd'>{s.value}</ins>
							: s.type === 'del' ? <del class='diffDel'>{s.value}</del>
							: s.value
						)}
					</span>
				</>}
			</For>
		</div>
	);
}
