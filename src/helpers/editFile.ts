/** Pure edit-matching and applying logic, extracted from applyToolCalls for testability. */

export type EditOp = {
	oldText: string;
	newText: string;
	lineHint?: number;
};

export type EditOutcome = {
	applied: boolean;
	line?: number;
	endLine?: number;
	adjusted?: string | undefined;   // indent prefix if auto-adjusted
	message: string;     // status line (✓/✗/⚠)
};

export type ApplyEditsResult = {
	content: string;         // resulting content (LF-normalized; caller handles CRLF)
	outcomes: EditOutcome[]; // one per input edit, in input order
	applied: number;
	failed: number;
	skipped: number;
	// For adjusted edits: index → corrected oldText/newText (for writing back to tool call args)
	adjustments: Map<number, { oldText: string; newText: string }>;
};

type EditMatch = {
	index: number;
	start: number;
	end: number;
	oldText: string;
	newText: string;
	line: number;
	endLine: number;
	lineHint?: number | undefined;
	adjusted?: string | undefined;
};

const descWs = (ws: string) => {
	const t = (ws.match(/\t/g) || []).length;
	const sp = ws.length - t;
	if (!t && !sp) return '0';
	const parts: string[] = [];
	if (t) parts.push(`${t} tab${t > 1 ? 's' : ''}`);
	if (sp) parts.push(`${sp} space${sp > 1 ? 's' : ''}`);
	return parts.join('+');
};

/**
 * Apply search-and-replace edits to file content.
 * Content must be LF-normalized (caller handles CRLF/BOM).
 */
export function applyEdits(content: string, edits: EditOp[]): ApplyEditsResult {
	const totalLines = content.split('\n').length;
	const matched: EditMatch[] = [];
	const outcomes: EditOutcome[] = new Array(edits.length);
	const adjustments = new Map<number, { oldText: string; newText: string }>();
	let failCount = 0;
	let skipped = 0;

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		const oldNorm = (edit.oldText ?? '').replace(/\r\n/g, '\n');
		const newNorm = (edit.newText ?? '').replace(/\r\n/g, '\n');

		if (oldNorm.length === 0) {
			// Empty oldText is acceptable on empty file
			if (content.length === 0) {
				matched.push({ index: i, start: 0, end: 0, oldText: '', newText: newNorm, line: 1, endLine: 1, lineHint: edit.lineHint });
				continue;
			}
			failCount++;
			outcomes[i] = { applied: false, message: `✗ edit ${i + 1}: oldText is empty. Provide the text to find and replace.` };
			continue;
		}

		if (oldNorm === newNorm) {
			skipped++;
			outcomes[i] = { applied: false, message: `⚠ edit ${i + 1}: oldText and newText are identical (no-op, skipped).` };
			continue;
		}

		// Find all exact occurrences
		const positions: number[] = [];
		let searchFrom = 0;
		while (true) {
			const pos = content.indexOf(oldNorm, searchFrom);
			if (pos === -1) break;
			positions.push(pos);
			searchFrom = pos + 1;
		}

		if (positions.length === 0) {
			// Try whitespace-tolerant match for indentation-flexible matching
			const oldLines = oldNorm.split('\n');
			const oldTrimmed = oldLines.map(l => l.trimStart());
			const cLines = content.split('\n');

			const wsMatches: number[] = [];
			for (let s = 0, max = cLines.length - oldLines.length; s <= max; s++) {
				let ok = true;
				for (let j = 0; j < oldLines.length; j++) {
					if (cLines[s + j].trimStart() !== oldTrimmed[j]) { ok = false; break; }
				}
				if (ok) wsMatches.push(s);
			}

			// Attempt indent-prefix adjustment
			if (wsMatches.length > 0) {
				let chosenWsLine: number | undefined;
				if (wsMatches.length === 1) {
					chosenWsLine = wsMatches[0];
				} else if (edit.lineHint != null) {
					let bestIdx = 0;
					let bestDist = Math.abs(wsMatches[0] + 1 - edit.lineHint);
					for (let j = 1; j < wsMatches.length; j++) {
						const dist = Math.abs(wsMatches[j] + 1 - edit.lineHint);
						if (dist < bestDist) { bestDist = dist; bestIdx = j; }
					}
					if (bestDist <= 5) chosenWsLine = wsMatches[bestIdx];
				}

				if (chosenWsLine !== undefined) {
					// Compute indent prefix: the common whitespace the model stripped
					let prefix: string | null = null;
					let prefixValid = true;
					for (let j = 0; j < oldLines.length; j++) {
						if (!oldLines[j].trim()) continue;
						const fWs = cLines[chosenWsLine + j].match(/^\s*/)![0];
						const oWs = oldLines[j].match(/^\s*/)![0];
						if (!fWs.endsWith(oWs)) { prefixValid = false; break; }
						const p = fWs.slice(0, fWs.length - oWs.length);
						if (prefix === null) prefix = p;
						else if (p !== prefix) { prefixValid = false; break; }
					}

					if (prefixValid && prefix !== null && prefix.length > 0) {
						// Use actual file content for oldText, re-indent newText
						let rePos = 0;
						for (let k = 0; k < chosenWsLine; k++) rePos += cLines[k].length + 1;
						const actualOld = cLines.slice(chosenWsLine, chosenWsLine + oldLines.length).join('\n');
						const pfix = prefix;
						const reindentedNew = newNorm.split('\n').map(l => l.trim() ? pfix + l : l).join('\n');

						const matchLine = chosenWsLine + 1;
						const endLine = matchLine + oldLines.length - 1;
						matched.push({
							index: i, start: rePos, end: rePos + actualOld.length,
							oldText: actualOld, newText: reindentedNew,
							line: matchLine, endLine,
							lineHint: edit.lineHint,
							adjusted: pfix
						});
						adjustments.set(i, { oldText: actualOld, newText: reindentedNew });
						continue;
					}
				}
			}

			// Fall through: report error with diagnostics
			const firstLine = oldNorm.split('\n')[0];
			const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
			let hint = '';

			if (wsMatches.length > 1) {
				const matchLines = wsMatches.map(s => s + 1);
				hint = ` (content matches ${wsMatches.length} locations (lines ${matchLines.join(', ')}) but indentation differs)`;
			} else if (wsMatches.length === 1) {
				// Report the first line whose indentation actually differs, not line 1
				const s = wsMatches[0];
				const diffs: number[] = [];
				for (let j = 0; j < oldLines.length; j++) {
					if (!oldLines[j].trim()) continue;
					if (cLines[s + j].match(/^\s*/)![0] !== oldLines[j].match(/^\s*/)![0]) diffs.push(j);
				}
				const j = diffs[0] ?? 0;
				const fWs = cLines[s + j].match(/^\s*/)![0];
				const oWs = oldLines[j].match(/^\s*/)![0];
				const where = oldLines.length > 1 ? `lines ${s + 1}\u2013${s + oldLines.length}` : `line ${s + 1}`;
				const lineDesc = oldLines.length > 1 ? ` at line ${s + j + 1} "${oldLines[j].trim().slice(0, 50)}"` : '';
				const more = diffs.length > 1 ? ` (and on ${diffs.length - 1} more line${diffs.length > 2 ? 's' : ''})` : '';
				hint = ` (content matches ${where} but indentation differs${lineDesc}: file has ${descWs(fWs)}, oldText has ${descWs(oWs)}${more})`;
			} else if (edit.lineHint != null) {
				const lines = content.split('\n');
				const around = Math.max(0, edit.lineHint - 3);
				const endCtx = Math.min(lines.length, edit.lineHint + 2);
				hint = '\nContent near line ' + edit.lineHint + ':\n' +
					lines.slice(around, endCtx).map((l, j) => `  ${around + j + 1}: ${l}`).join('\n');
			}
			failCount++;
			outcomes[i] = { applied: false, message: `✗ edit ${i + 1}: not found: "${preview}"${hint}` };
			continue;
		}

		// Exact match — disambiguate
		let chosenPos: number;
		if (positions.length === 1) {
			if (edit.lineHint != null) {
				const matchLine = content.slice(0, positions[0]).split('\n').length;
				const dist = Math.abs(matchLine - edit.lineHint);
				if (dist > 5) {
					failCount++;
					outcomes[i] = { applied: false, message: `✗ edit ${i + 1}: lineHint ${edit.lineHint} is ${dist} lines from the match (line ${matchLine}). Re-read the file and retry with more context in oldText.` };
					continue;
				}
			}
			chosenPos = positions[0];
		} else if (edit.lineHint != null) {
			const posLines = positions.map(p => content.slice(0, p).split('\n').length);
			let bestIdx = 0;
			let bestDist = Math.abs(posLines[0] - edit.lineHint);
			for (let j = 1; j < posLines.length; j++) {
				const dist = Math.abs(posLines[j] - edit.lineHint);
				if (dist < bestDist) { bestDist = dist; bestIdx = j; }
			}
			if (bestDist > 5) {
				failCount++;
				outcomes[i] = { applied: false, message: `✗ edit ${i + 1}: lineHint ${edit.lineHint} is ${bestDist} lines from nearest match (line ${posLines[bestIdx]}). Re-read the file and retry with more context in oldText.` };
				continue;
			}
			chosenPos = positions[bestIdx];
		} else {
			const matchLines = positions.map(p => content.slice(0, p).split('\n').length);
			failCount++;
			outcomes[i] = { applied: false, message: `✗ edit ${i + 1}: oldText matches ${positions.length} locations (lines ${matchLines.join(', ')}). Disambiguate with larger oldText.` };
			continue;
		}

		const matchLine = content.slice(0, chosenPos).split('\n').length;
		const endLine = matchLine + oldNorm.split('\n').length - 1;
		matched.push({
			index: i, start: chosenPos, end: chosenPos + oldNorm.length,
			oldText: oldNorm, newText: newNorm,
			line: matchLine, endLine,
			lineHint: edit.lineHint
		});
	}

	// Check for overlaps — reject both sides
	matched.sort((a, b) => a.start - b.start);
	const overlapPairs = new Map<number, number[]>();
	for (let i = 1; i < matched.length; i++) {
		if (matched[i].start < matched[i - 1].end) {
			if (!overlapPairs.has(i - 1)) overlapPairs.set(i - 1, []);
			if (!overlapPairs.has(i)) overlapPairs.set(i, []);
			overlapPairs.get(i - 1)!.push(i);
			overlapPairs.get(i)!.push(i - 1);
		}
	}
	const valid: EditMatch[] = [];
	for (let i = 0; i < matched.length; i++) {
		if (overlapPairs.has(i)) {
			const m = matched[i];
			const partners = overlapPairs.get(i)!.map(j => matched[j].index + 1).join(', ');
			failCount++;
			outcomes[m.index] = { applied: false, line: m.line, endLine: m.endLine, message: `✗ edit ${m.index + 1} (line ${m.line}): overlaps with edit ${partners}. Merge overlapping edits.` };
		} else {
			valid.push(matched[i]);
		}
	}

	// Apply from bottom to top
	let result = content;
	for (let i = valid.length - 1; i >= 0; i--) {
		const m = valid[i];
		result = result.slice(0, m.start) + m.newText + result.slice(m.end);
		const lineRange = m.line === m.endLine ? `line ${m.line}` : `lines ${m.line}–${m.endLine}`;
		const oob = (m.lineHint != null && (m.lineHint < 1 || m.lineHint > totalLines))
			? ` ⚠ lineHint ${m.lineHint} is out of range (file has ${totalLines} lines)` : '';
		const adj = m.adjusted ? ' (indentation adjusted)' : '';
		outcomes[m.index] = { applied: true, line: m.line, endLine: m.endLine, adjusted: m.adjusted, message: `✓ edit ${m.index + 1} (${lineRange})${adj}${oob}` };
	}

	return { content: result, outcomes, applied: valid.length, failed: failCount, skipped, adjustments };
}
