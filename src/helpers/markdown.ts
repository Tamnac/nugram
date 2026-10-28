import { Remarkable } from 'remarkable';
import katex from 'katex';
import { isTauri, openExternal } from './platform';

function scriptRule(marker: '~' | '^', tag: 'sub' | 'sup'): Remarkable.InlineParsingRule {
	const markerCode = marker.charCodeAt(0);
	return function(state, silent) {
		const start = state.pos;
		const max = state.posMax;
		if (state.src.charCodeAt(start) !== markerCode || silent) return false;
		if (start + 1 >= max || state.src[start + 1] === marker || /\s/.test(state.src[start + 1])) return false;
		if (state.level >= (state as any).options.maxNesting) return false;

		state.pos = start + 1;
		let depth = 0;
		let end = -1;
		while (state.pos < max) {
			if (state.src.charCodeAt(state.pos) === markerCode) {
				const prev = state.src[state.pos - 1] ?? '';
				const next = state.src[state.pos + 1] ?? '';
				if (prev === marker || next === marker) {
					state.parser.skipToken(state);
					continue;
				}

				const canOpen = next !== '' && !/\s/.test(next);
				const canClose = prev !== '' && !/\s/.test(prev);
				if (canClose) {
					if (depth === 0) {
						end = state.pos;
						break;
					}
					depth--;
				} else if (canOpen) {
					depth++;
				}
				state.pos++;
				continue;
			}
			state.parser.skipToken(state);
		}

		if (end < 0) {
			state.pos = start;
			return false;
		}

		state.posMax = end;
		state.pos = start + 1;
		state.push({ type: `${tag}_open`, level: state.level++ });
		state.parser.tokenize(state);
		state.push({ type: `${tag}_close`, level: --state.level });
		state.pos = end + 1;
		state.posMax = max;
		return true;
	};
}

export function enableSupSub(parser: Remarkable) {
	parser.inline.ruler.at('sub', scriptRule('~', 'sub'), {});
	parser.inline.ruler.at('sup', scriptRule('^', 'sup'), {});
	parser.inline.ruler.enable(['sub', 'sup']);
	parser.renderer.rules.sub_open = () => '<sub>';
	parser.renderer.rules.sub_close = () => '</sub>';
	parser.renderer.rules.sup_open = () => '<sup>';
	parser.renderer.rules.sup_close = () => '</sup>';
}

const mathCache = new Map<string, string>();

function renderMath(src: string, displayMode: boolean): string {
	const key = (displayMode ? 'D' : 'I') + src;
	let html = mathCache.get(key);
	if (html !== undefined) return html;
	try {
		html = katex.renderToString(src, { displayMode, throwOnError: false, output: 'html' });
	} catch {
		html = `<code>${src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`;
	}
	if (mathCache.size >= 1000) mathCache.clear();
	mathCache.set(key, html);
	return html;
}

const mathDelims = [
	{ open: '$$', close: '$$', display: true },
	{ open: '\\[', close: '\\]', display: true },
	{ open: '\\(', close: '\\)', display: false },
];

/** `$$`/`\[` display math occupying whole lines, possibly spanning several. */
const mathBlock: Remarkable.BlockParsingRule = (state, startLine, endLine, silent) => {
	const lineText = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
	const first = lineText(startLine);
	const delim = mathDelims.find(d => d.display && first.startsWith(d.open));
	if (!delim) return false;

	const lines = [first.slice(delim.open.length)];
	for (let line = startLine; line < endLine; line++) {
		if (line > startLine) {
			if (state.bMarks[line] + state.tShift[line] < state.eMarks[line] && state.tShift[line] < state.blkIndent) return false;
			lines.push(lineText(line));
		}
		const last = lines[lines.length - 1].trimEnd();
		if (!last.endsWith(delim.close)) continue;

		lines[lines.length - 1] = last.slice(0, -delim.close.length);
		const content = lines.join('\n');
		if (!content.trim()) return false;
		if (!silent) state.tokens.push({ type: 'math_block', content, lines: [startLine, line + 1], level: state.level } as any);
		state.line = line + 1;
		return true;
	}
	return false;
};

/** Finds the closing `$` of strict (pandoc-style) inline math: no whitespace inside the delimiters, no digit after the closer. */
function strictDollarEnd(src: string, start: number, max: number): number {
	if (start + 1 >= max || /\s/.test(src[start + 1])) return -1;
	let pos = start + 1;
	while (pos < max && (src[pos] !== '$' || src[pos - 1] === '\\')) pos++;
	if (pos >= max || /\s/.test(src[pos - 1]) || /\d/.test(src[pos + 1] ?? '')) return -1;
	return pos;
}

/** `\(…\)`, strict `$…$`, and `$$…$$`/`\[…\]` display math within a paragraph. */
const mathInline: Remarkable.InlineParsingRule = (state, silent) => {
	const { src, pos: start, posMax: max } = state;
	const delim = mathDelims.find(d => src.startsWith(d.open, start));
	let contentStart: number, contentEnd: number, end: number;
	if (delim) {
		contentStart = start + delim.open.length;
		contentEnd = src.indexOf(delim.close, contentStart);
		end = contentEnd + delim.close.length;
		if (contentEnd < 0 || end > max) return false;
	} else if (src[start] === '$') {
		contentStart = start + 1;
		contentEnd = strictDollarEnd(src, start, max);
		end = contentEnd + 1;
		if (contentEnd < 0) return false;
	} else {
		return false;
	}

	const content = src.slice(contentStart, contentEnd);
	if (!content.trim()) return false;
	if (!silent) state.push({ type: 'math_inline', content, display: delim?.display ?? false, level: state.level } as any);
	state.pos = end;
	return true;
};

/** Index just past the math span or code span starting at `pos`, or -1 if none starts there. */
function spanEnd(src: string, pos: number): number {
	const delim = mathDelims.find(d => src.startsWith(d.open, pos));
	if (delim) {
		const close = src.indexOf(delim.close, pos + delim.open.length);
		return close < 0 ? -1 : close + delim.close.length;
	}
	if (src[pos] === '$') {
		const close = strictDollarEnd(src, pos, src.length);
		return close < 0 ? -1 : close + 1;
	}
	if (src[pos] === '`') {
		let run = pos;
		while (src[run] === '`') run++;
		const ticks = src.slice(pos, run);
		for (let close = src.indexOf(ticks, run); close >= 0; close = src.indexOf(ticks, close + 1)) {
			const closeEnd = close + ticks.length;
			if (src[close - 1] !== '`' && src[closeEnd] !== '`') return closeEnd;
		}
	}
	return -1;
}

/** Splits a table row on `|`, except escaped `\|` and pipes inside math or code spans. */
export function splitRow(line: string): string[] {
	const cells: string[] = [];
	let cellStart = 0;
	let pos = 0;
	while (pos < line.length) {
		const end = spanEnd(line, pos);
		if (end >= 0) {
			pos = end;
		} else if (line[pos] === '\\') {
			pos += 2;
		} else if (line[pos] === '`') {
			while (line[pos] === '`') pos++;
		} else {
			if (line[pos] === '|') {
				cells.push(line.slice(cellStart, pos));
				cellStart = pos + 1;
			}
			pos++;
		}
	}
	cells.push(line.slice(cellStart));
	if (line.startsWith('|')) cells.shift();
	if (cellStart === line.length && cells.length > 1) cells.pop();
	return cells;
}

/** Remarkable's table rule, with rows split by `splitRow` instead of on every `|`. */
const table: Remarkable.BlockParsingRule = (state, startLine, endLine, silent) => {
	if (startLine + 2 > endLine) return false;
	const alignLine = startLine + 1;
	if (state.tShift[alignLine] < state.blkIndent) return false;
	const first = state.src[state.bMarks[alignLine] + state.tShift[alignLine]];
	if (alignLine >= state.lineMax || !first || !'|-:'.includes(first)) return false;

	const getLine = (line: number) => state.src.slice(state.bMarks[line] + state.blkIndent, state.eMarks[line]);
	const alignText = getLine(alignLine);
	if (!/^[-:| ]+$/.test(alignText)) return false;
	const parts = alignText.split('|');
	const aligns: string[] = [];
	for (const [i, part] of parts.entries()) {
		const t = part.trim();
		if (!t) {
			if (i === 0 || i === parts.length - 1) continue;
			return false;
		}
		if (!/^:?-+:?$/.test(t)) return false;
		aligns.push(t.endsWith(':') ? (t.startsWith(':') ? 'center' : 'right') : t.startsWith(':') ? 'left' : '');
	}

	const headText = getLine(startLine).trim();
	if (!headText.includes('|')) return false;
	const head = splitRow(headText);
	if (head.length !== aligns.length) return false;
	if (silent) return true;

	const tokens = state.tokens as any[];
	const pushRow = (cells: string[], tag: 'th' | 'td', lines?: number[]) => {
		tokens.push({ type: 'tr_open', lines, level: state.level++ });
		cells.forEach((content, i) => {
			tokens.push({ type: `${tag}_open`, align: aligns[i], lines, level: state.level++ });
			tokens.push({ type: 'inline', content: content.trim(), lines, level: state.level, children: [] });
			tokens.push({ type: `${tag}_close`, level: --state.level });
		});
		tokens.push({ type: 'tr_close', level: --state.level });
	};

	const tableLines = [startLine, 0];
	const tbodyLines = [startLine + 2, 0];
	tokens.push({ type: 'table_open', lines: tableLines, level: state.level++ });
	tokens.push({ type: 'thead_open', lines: [startLine, startLine + 1], level: state.level++ });
	pushRow(head, 'th', [startLine, startLine + 1]);
	tokens.push({ type: 'thead_close', level: --state.level });
	tokens.push({ type: 'tbody_open', lines: tbodyLines, level: state.level++ });
	let line = startLine + 2;
	for (; line < endLine; line++) {
		if (state.tShift[line] < state.blkIndent) break;
		const text = getLine(line).trim();
		if (!text.includes('|')) break;
		pushRow(splitRow(text), 'td');
	}
	tokens.push({ type: 'tbody_close', level: --state.level });
	tokens.push({ type: 'table_close', level: --state.level });
	tableLines[1] = tbodyLines[1] = line;
	state.line = line;
	return true;
};

export function enableMath(parser: Remarkable) {
	parser.block.ruler.at('table', table, { alt: ['paragraph'] } as any);
	parser.block.ruler.before('fences', 'math_block', mathBlock, { alt: ['paragraph', 'blockquote', 'list'] } as any);
	parser.inline.ruler.before('escape', 'math_inline', mathInline, {});
	parser.renderer.rules.math_block = (tokens: any[], idx: number) => renderMath(tokens[idx].content, true) + '\n';
	parser.renderer.rules.math_inline = (tokens: any[], idx: number) => renderMath(tokens[idx].content, tokens[idx].display);
}

const svgTagRe = /<!--(?:>|->|[\s\S]*?--!?>)|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][\w:-]*)(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*(\/?)>/g;
const svgTags = new Set([
	'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'style', 'title', 'desc', 'metadata',
	'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
	'text', 'tspan', 'textpath', 'a', 'image', 'clippath', 'mask', 'marker', 'pattern',
	'lineargradient', 'radialgradient', 'stop', 'filter', 'feblend', 'fecolormatrix',
	'fecomponenttransfer', 'fecomposite', 'feconvolvematrix', 'fediffuselighting',
	'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood',
	'fefunca', 'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage',
	'femerge', 'femergenode', 'femorphology', 'feoffset', 'fepointlight',
	'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
]);
const svgCache = new WeakMap<object, { src: string; start: number; max: number; ends: Map<number, number> }>();

function svgEnd(state: { src: string }, start: number, max: number): number {
	const { src } = state;
	if (!/^<svg[\s/>]/i.test(src.slice(start, start + 5))) return -1;

	let cache = svgCache.get(state);
	if (!cache || cache.src !== src || cache.max !== max || start < cache.start) {
		cache = { src, start, max, ends: new Map() };
		svgCache.set(state, cache);
		const tags = new RegExp(svgTagRe);
		tags.lastIndex = start;
		const openings: number[] = [];
		let match: RegExpExecArray | null;
		while ((match = tags.exec(src)) && tags.lastIndex <= max) {
			if (match[1]?.toLowerCase() !== 'svg') continue;
			if (match[0].startsWith('</')) {
				const opening = openings.pop();
				if (opening !== undefined) cache.ends.set(opening, tags.lastIndex);
			} else if (match[2] === '/') {
				cache.ends.set(match.index, tags.lastIndex);
			} else {
				openings.push(match.index);
			}
		}
	}
	return cache.ends.get(start) ?? -1;
}

function renderSvg(content: string): string {
	const escape = (text: string) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const output: string[] = [];
	let lastIndex = 0;
	content.replace(svgTagRe, (tag, name: string | undefined, _closing: string | undefined, offset: number) => {
		output.push(escape(content.slice(lastIndex, offset)), !name || svgTags.has(name.toLowerCase()) ? tag : escape(tag));
		lastIndex = offset + tag.length;
		return tag;
	});
	output.push(escape(content.slice(lastIndex)));
	return output.join('');
}

const svgBlock: Remarkable.BlockParsingRule = (state, startLine, endLine, silent) => {
	if (!state.options.html || state.tShift[startLine] - state.blkIndent > 3) return false;
	const start = state.bMarks[startLine] + state.tShift[startLine];
	const end = svgEnd(state, start, state.eMarks[endLine - 1]);
	if (end < 0) return false;

	let lastLine = startLine;
	while (state.eMarks[lastLine] < end) {
		lastLine++;
		if (!state.isEmpty(lastLine) && state.tShift[lastLine] < state.blkIndent) return false;
	}
	if (state.src.slice(end, state.eMarks[lastLine]).trim()) return false;
	if (silent) return true;

	state.line = lastLine + 1;
	state.tokens.push({
		type: 'htmlblock',
		content: renderSvg(state.getLines(startLine, state.line, state.blkIndent, true)),
		lines: [startLine, state.line],
		level: state.level,
	});
	return true;
};

const svgInline: Remarkable.InlineParsingRule = (state, silent) => {
	if (!(state as any).options.html) return false;
	const end = svgEnd(state, state.pos, state.posMax);
	if (end < 0) return false;
	if (!silent) state.push({ type: 'svg_inline', content: state.src.slice(state.pos, end), level: state.level } as any);
	state.pos = end;
	return true;
};

/** Keep SVG markup out of Markdown parsing and individual HTML-tag renderer overrides. */
export function enableSvg(parser: Remarkable) {
	parser.block.ruler.before('htmlblock', 'svg_block', svgBlock, { alt: ['paragraph', 'blockquote', 'list'] } as any);
	parser.inline.ruler.before('htmltag', 'svg_inline', svgInline, {});
	(parser.renderer.rules as any).svg_inline = (tokens: any[], idx: number) => renderSvg(tokens[idx].content);
}

/** Markdown parser for thinking traces and tool content (no raw HTML). */
export const thinkingParser = new Remarkable({ html: false, typographer: false });
enableSupSub(thinkingParser);
enableMath(thinkingParser);
thinkingParser.block.ruler.disable(['code']);

/** Chat folder for resolving relative paths in links, set by MessageList. */
let linkCwd: (() => string | undefined) | undefined;
export function setLinkCwd(fn: () => string | undefined) { linkCwd = fn; }

export async function handleLinkClick(e: MouseEvent) {
	const anchor = (e.target as HTMLElement).closest('a');
	if (!anchor) return;
	const href = anchor.getAttribute('href');
	if (!href) return;
	// Hash-only links navigate within the page, leave them alone
	if (href.startsWith('#')) return;
	const isWebUrl = href.startsWith('http://') || href.startsWith('https://');
	// On web, let web URLs behave normally. In Tauri we never let a link
	// take over the webview: web URLs go to the system browser, file paths
	// open with their default app.
	if (isWebUrl && !isTauri) return;
	e.preventDefault();
	if (isTauri) {
		await openExternal(href, linkCwd?.()).catch(console.error);
	}
}
