function iSpace(char: string): boolean {
	return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

export function typeHelper(text: string, loc: number): string {
	if (loc <= 0 || loc > text.length) return text;
	const lastChar = text.charAt(loc - 1);
	const nextChar = text.charAt(loc);
	const matches = ['(', '[', '{', '<'];
	const replace = [')', ']', '}', '>'];
	const matchI = matches.indexOf(lastChar);

	if (matchI !== -1 && (iSpace(nextChar) || loc === text.length))
		text = text.slice(0, loc) + replace[matchI] + text.slice(loc);

	return text;
}

export function tabComplete(text: string, loc: number): {text: string, cursorPos?: number | undefined} {
	let newText = text;
	let newCursorPos: number | undefined;

	if (text.substring(loc - 2, loc) === '--') {
		text = text.slice(0, loc - 2) + '—' + text.slice(loc);
		newCursorPos = loc - 1;
	}
	newText = text.replaceAll(/div.([\w-]+)/g, (m, p1, offset) => {
		if (offset + m.length === loc) {
			const replacement = `<div class="${p1}"></div>`;
			newCursorPos = offset + `<div class="${p1}">`.length;
			return replacement;
		}
		return m;
	});

	return { text: newText, cursorPos: newCursorPos };
}

export interface ImageCompletion {
	kind: 'shorthand' | 'destination';
	query: string;
	start: number;
	end: number;
}

function imagePathEnd(text: string, start: number, angle: boolean): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (char === '\n' || (angle && char === '>')) return i;
		if (char === '\\') i++;
		else if (!angle) {
			if (char === '(') depth++;
			else if (char === ')') {
				if (!depth) return i;
				depth--;
			} else if (/\s/.test(char) && /^\s+["']/.test(text.slice(i))) return i;
		}
	}
	return text.length;
}

export function imageCompletionAt(text: string, loc: number): ImageCompletion | null {
	if (loc < 0 || loc > text.length) return null;
	const before = text.slice(0, loc);
	const start = before.lastIndexOf('![');
	if (start === -1) return null;
	const prefix = before.slice(start);
	const destination = /^!\[(?:\\.|[^\]\\\n])*\]\((<?)([^\n]*)$/.exec(prefix);
	const shorthand = destination ? null : /^!\[([^\]\n]*)$/.exec(prefix);
	const match = destination ?? shorthand;
	if (!match) return null;

	let escapes = 0;
	for (let i = start - 1; i >= 0 && text[i] === '\\'; i--) escapes++;
	if (escapes % 2) return null;

	let query = destination ? destination[2] : match[1];
	if (destination && /^(?:[a-z][\w+.-]*:|\/\/|\/)/i.test(query)) return null;
	const rest = text.slice(loc).split('\n')[0];
	if (destination) {
		const pathStart = loc - destination[2].length;
		let end = imagePathEnd(text, pathStart, !!destination[1]);
		if (end < loc) return null;
		if (!destination[1] && (end === text.length || text[end] === '\n')) {
			const space = rest.search(/\s/);
			if (space !== -1) end = loc + space;
		}
		try { query = decodeURIComponent(query); } catch { /* partially typed escape */ }
		return { kind: 'destination', query, start: pathStart - destination[1].length, end };
	}

	const closing = rest.indexOf(']');
	const wordEnd = rest.search(/\s/);
	let end = loc + (closing === -1 ? (wordEnd === -1 ? rest.length : wordEnd) : closing + 1);
	if (text.startsWith('](', end - 1)) {
		if (text[end + 1] === ')') end += 2;
		else return null;
	}
	return { kind: 'shorthand', query, start, end };
}

export function completeImageReference(text: string, completion: ImageCompletion, path: string): { text: string; cursorPos: number } {
	const ref = path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
		char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
	let end = completion.end;
	let replacement = ref;
	if (completion.kind === 'shorthand') replacement = `![](${ref})`;
	else {
		if (text[end] === '>') end++;
		if (!/^\s+["']/.test(text.slice(end))) {
			if (text[end] === ')') end++;
			replacement += ')';
		}
	}
	return {
		text: text.slice(0, completion.start) + replacement + text.slice(end),
		cursorPos: completion.start + replacement.length,
	};
}

export function handleLineClipboard(e: ClipboardEvent) {
	const target = e.currentTarget as HTMLTextAreaElement;
	const { value, selectionStart, selectionEnd } = target;
	const cut = e.type === 'cut';
	if (selectionStart !== selectionEnd || !value || !e.clipboardData || (cut && target.readOnly)) return;

	const start = selectionStart === 0 ? 0 : value.lastIndexOf('\n', selectionStart - 1) + 1;
	const newline = value.indexOf('\n', selectionStart);
	const end = newline === -1 ? value.length : newline + 1;
	e.clipboardData.setData('text/plain', value.slice(start, end) || '\n');
	e.preventDefault();

	if (cut) {
		const cutStart = newline === -1 && start > 0 ? start - 1 : start;
		target.setSelectionRange(cutStart, end);
		// Native deletion preserves undo history and runs the field's input handler.
		if (!target.ownerDocument.execCommand('delete')) {
			target.setRangeText('', cutStart, end, 'end');
			target.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}
}
