import { For } from 'solid-js';
import { diffChars, diffLines } from 'diff';
import { isTauri } from '../platform';
import { applyEdits, type EditOp } from '../editFile';
import { acquireFileLock, resolveToolPath } from './shared';
import type { ToolModule } from './types';

type EditOutcomeData = { applied: boolean; line?: number | undefined; message: string };

export const editFileTool: ToolModule = {
	returns: 'new file: { path: string, created: true, lines: number }; '
		+ 'edit: { path: string, applied: number, failed: number, skipped: number, total: number, outcomes: { applied: boolean, line?: number, message: string }[] } (ok is false unless every edit applied; with applied 0 the file is not written); '
		+ 'declined by the user: { ok: false, denied: true, message: string }',
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
								}
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

			const resolved = resolveToolPath(args?.path, ctx.chatFolder, 'edit', ctx.backend.paths);
			if ('error' in resolved) return { ok: false, reason: 'invalid_path', error: resolved.error };
			const resolvedPath = resolved.path;

			// Serialize read-modify-write per file so concurrent same-file
			// edit_file calls don't clobber each other (released in finally).
			releaseLock = await acquireFileLock(resolvedPath);

			// Check if path exists and whether it's a file or directory
			let fileExists = false;
			try {
				const info = await ctx.backend.stat(resolvedPath);
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
					try { await ctx.backend.mkdir(dir); } catch (_) { /* may already exist */ }
				}

				if (ctx.requestPermission) {
					const permResult = await ctx.requestPermission(call);
					if (permResult !== true) return { denied: true, message: permResult };
				}
				await ctx.backend.writeText(resolvedPath, newContent);
				return { ok: true, path: resolvedPath, created: true, lines: newContent.split('\n').length };
			}

			// Read and normalize
			const rawContent = await ctx.backend.readText(resolvedPath);
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

			await ctx.backend.writeText(resolvedPath, result);

			return { ok: editResult.failed === 0, path: resolvedPath, outcomes, ...counts };
		} catch (error: any) {
			console.error('edit_file error:', error);
			const msg = String(error.message || error);
			const path = args?.path ?? '(unknown)';
			// Provide cleaner messages for common filesystem errors
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
		// Older structured results retain this suffix even though their call args were corrected.
		const successLines = outcomes.filter(o => o.applied).map(o => o.message.replace(/ \(indentation adjusted\)$/, ''));
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
					<pre class='editDiffContent toolScroll' style={{ opacity: '0.85' }}>{typeof args.edits === 'string' ? args.edits : JSON.stringify(args, null, 2)}</pre>
				</div>
			);
		}
		const edits = args.edits as EditOp[] | undefined;
		if (!edits?.length) return <span>edit <code>{args.path}</code></span>;

		const isFileCreate = () => props.result
			? props.result.data?.created ?? props.result.content?.startsWith('Created new file') ?? false
			: !props.call._matchedLines;
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
				outcomes?.[idx]?.line ?? lineStarts.get(idx + 1) ?? (isFileCreate() ? 0 : matchedLines?.[idx] ?? 1));
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
						{edits.length > 1 ? <div class='editDiffHeader'>edit {i() + 1}</div> : null}
						{renderEditDiff(
							isFileCreate() ? '' : (edit.oldText ?? ''),
							edit.newText ?? '',
							starts()[i()],
							!isFileCreate()
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

type DiffSeg = { type: 'ctx' | 'add' | 'del'; value: string };

/**
 * Render a side-by-side before/after diff. Context lines are repeated
 * identically in both columns (kept aligned); changed lines show the old line
 * and the new line next to each other, with only the changed characters
 * highlighted inside each.
 */
function renderEditDiff(oldText: string, newText: string, startLine: number, showBefore = true) {
	type Row = {
		before: DiffSeg[];
		after: DiffSeg[];
		beforeNum: number | '';
		afterNum: number | '';
	};

	const rows: Row[] = [];
	let beforeNo = startLine;
	let afterNo = startLine;

	const toLines = (v: string) => v.replace(/\n$/, '').split('\n');
	const pushCtx = (line: string) => {
		rows.push({
			before: [{ type: 'ctx', value: line }],
			after: [{ type: 'ctx', value: line }],
			beforeNum: beforeNo++,
			afterNum: afterNo++,
		});
	};
	const pushDel = (line: string) => {
		rows.push({ before: [{ type: 'del', value: line }], after: [], beforeNum: beforeNo++, afterNum: '' });
	};
	const pushAdd = (line: string) => {
		rows.push({ before: [], after: [{ type: 'add', value: line }], beforeNum: '', afterNum: afterNo++ });
	};
	const pushPair = (oldLine: string, newLine: string) => {
		const segs: DiffSeg[] = [];
		for (const p of diffChars(oldLine, newLine)) {
			segs.push({ type: p.added ? 'add' : p.removed ? 'del' : 'ctx', value: p.value });
		}
		rows.push({
			before: segs.filter(s => s.type !== 'add'),
			after: segs.filter(s => s.type !== 'del'),
			beforeNum: beforeNo++,
			afterNum: afterNo++,
		});
	};

	const oldT = oldText.endsWith('\n') ? oldText.slice(0, -1) : oldText;
	const newT = newText.endsWith('\n') ? newText.slice(0, -1) : newText;

	const chunks = diffLines(oldT, newT);
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (chunk.added) {
			for (const line of toLines(chunk.value)) pushAdd(line);
		} else if (chunk.removed) {
			const oldLines = toLines(chunk.value);
			const next = chunks[i + 1];
			if (next?.added) {
				const newLines = toLines(next.value);
				const n = Math.min(oldLines.length, newLines.length);
				for (let k = 0; k < n; k++) pushPair(oldLines[k], newLines[k]);
				for (let k = n; k < oldLines.length; k++) pushDel(oldLines[k]);
				for (let k = n; k < newLines.length; k++) pushAdd(newLines[k]);
				i++;
			} else {
				for (const line of oldLines) pushDel(line);
			}
		} else {
			for (const line of toLines(chunk.value)) pushCtx(line);
		}
	}

	// File creation: every line is new, so a before column is pointless.
	if (!showBefore) {
		return (
			<div class='editDiffLines editDiffLinesSingle toolScroll'>
				<For each={rows}>
					{row => <>
						<span class='editDiffNum'>{row.afterNum || ''}</span>
						{diffCell(row.after)}
					</>}
				</For>
			</div>
		);
	}

	return (
		<div class='editDiffLines toolScroll'>
			<For each={rows}>
				{row => <>
					<span class='editDiffNum'>{row.beforeNum || ''}</span>
					{diffCell(row.before)}
					<span class='editDiffNum'>{row.afterNum || ''}</span>
					{diffCell(row.after)}
				</>}
			</For>
		</div>
	);
}

/**
 * A whole added/removed line gets its highlight on the grid cell instead of an
 * inline element, so the background fills the row height and consecutive lines
 * form one solid block. Partly changed lines keep per-character highlights.
 */
function diffCell(segs: DiffSeg[]) {
	const whole = segs.length === 1 && segs[0].type !== 'ctx';
	const cls = 'editDiffText' + (whole ? (segs[0].type === 'add' ? ' diffLineAdd' : ' diffLineDel') : '');
	return <span class={cls}>{whole ? segs[0].value : renderSegs(segs)}</span>;
}

function renderSegs(segs: DiffSeg[]): any {
	if (segs.length === 0) return null;
	return segs.map(s =>
		s.type === 'add' ? <ins class='diffAdd'>{s.value}</ins>
		: s.type === 'del' ? <del class='diffDel'>{s.value}</del>
		: s.value
	);
}
