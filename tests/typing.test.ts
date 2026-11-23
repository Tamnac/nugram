import { describe, expect, mock, test } from 'bun:test';
import { completeImageReference, imageCompletionAt, handleLineClipboard, typeHelper, tabComplete } from '../src/helpers/typing';
import { Remarkable } from 'remarkable';

describe('typeHelper', () => {
	test('pairs opening brackets at the end of the input', () => {
		for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']])
			expect(typeHelper(`text${open}`, 5)).toBe(`text${open}${close}`);
	});

	test('pairs brackets before whitespace', () => {
		for (const space of [' ', '\t', '\n', '\r', '\f', '\v'])
			expect(typeHelper(`(${space}after`, 1)).toBe(`()${space}after`);
	});

	test('leaves ordinary text and brackets before non-whitespace unchanged', () => {
		expect(typeHelper('text', 4)).toBe('text');
		expect(typeHelper('(after', 1)).toBe('(after');
		expect(typeHelper('()', 1)).toBe('()');
	});

	test('leaves out-of-range cursor positions unchanged', () => {
		for (const cursor of [-1, 0, 2])
			expect(typeHelper('(', cursor)).toBe('(');
	});
});

describe('tabComplete', () => {
	test('replaces two hyphens immediately before the cursor with an em dash', () => {
		expect(tabComplete('before--after', 8)).toEqual({ text: 'before—after', cursorPos: 7 });
	});

	test('expands a div class abbreviation immediately before the cursor', () => {
		const prefix = 'before ';
		const abbreviation = 'div.my-class';
		const opening = '<div class="my-class">';
		expect(tabComplete(prefix + abbreviation + ' after', prefix.length + abbreviation.length)).toEqual({
			text: prefix + opening + '</div> after',
			cursorPos: prefix.length + opening.length,
		});
	});

	test('does not expand abbreviations away from the cursor', () => {
		const text = '-- div.first div.second after';
		expect(tabComplete(text, text.length)).toEqual({ text, cursorPos: undefined });
	});
});

describe('image reference completion', () => {
	function atCursor(marked: string) {
		const loc = marked.indexOf('|');
		return { text: marked.replace('|', ''), loc };
	}

	function complete(marked: string, path = 'refs/portrait.png') {
		const { text, loc } = atCursor(marked);
		const completion = imageCompletionAt(text, loc);
		expect(completion).not.toBeNull();
		return completeImageReference(text, completion!, path);
	}

	for (const marked of ['![|]', '![por|]', '![por|trait]', '![por|', '![por|]()']) {
		test(`completes shorthand ${marked}`, () => {
			const text = '![](refs/portrait.png)';
			expect(complete(marked)).toEqual({ text, cursorPos: text.length });
		});
	}

	for (const marked of ['![Portrait](por|)', '![Portrait](por|trait.png)', '![Portrait](por|', '![Portrait](<por|>)']) {
		test(`completes destination ${marked} and preserves alt text`, () => {
			const text = '![Portrait](refs/portrait.png)';
			expect(complete(marked)).toEqual({ text, cursorPos: text.length });
		});
	}

	test('preserves surrounding text and other images', () => {
		const result = complete('Before ![po|] after ![](other.png)');
		expect(result).toEqual({ text: 'Before ![](refs/portrait.png) after ![](other.png)', cursorPos: 'Before ![](refs/portrait.png)'.length });
	});

	test('preserves an existing image title', () => {
		expect(complete('![Portrait](por|trait.png "Title")').text).toBe('![Portrait](refs/portrait.png "Title")');
		expect(complete('![Portrait](<por|trait.png> "Title")').text).toBe('![Portrait](refs/portrait.png "Title")');
	});

	test('replaces the whole destination with balanced or escaped parentheses', () => {
		for (const marked of ['![](my (po|rtrait).png)', '![](my (portrait)|.png)', '![](<my (portrait)|.png>)',
			'![](my \\(po|rtrait\\).png)']) {
			expect(complete(marked).text).toBe('![](refs/portrait.png)');
		}
	});

	test('preserves quoted text after a completed image', () => {
		expect(complete('![](por|) "After"').text).toBe('![](refs/portrait.png) "After"');
	});

	test('completes the nearest image trigger', () => {
		expect(complete('![first ![po|]').text).toBe('![first ![](refs/portrait.png)');
	});

	test('preserves prose after an unterminated reference', () => {
		expect(complete('![](po|rtrait.png and more text').text).toBe('![](refs/portrait.png) and more text');
		expect(complete('![po|rtrait and more text').text).toBe('![](refs/portrait.png) and more text');
	});

	test('allows spaces and paths in queries, decoding percent escapes', () => {
		for (const marked of ['![refs/my im|]', '![](refs/my im|)', '![](refs/my%20im|)']) {
			const { text, loc } = atCursor(marked);
			expect(imageCompletionAt(text, loc)?.query).toBe('refs/my im');
		}
	});

	test('encodes filenames as valid Markdown destinations', () => {
		const result = complete('![|]', "refs/日本 my (image)#%!'*.png");
		const ref = "refs/%E6%97%A5%E6%9C%AC%20my%20%28image%29%23%25%21%27%2A.png";
		expect(result.text).toBe(`![](${ref})`);
		expect(new Remarkable().render(result.text)).toContain(`src="${ref}"`);
	});

	for (const marked of ['text|', '[ordinary|]', '![](done.png)|', '![](https://host/po|)', '![](data:image/po|)',
		'![](//host/po|)', '![](/absolute/po|)', '\\![po|]', '![Alt|](existing.png)', '![Alt](file.png "Tit|le")', '![line\npo|]']) {
		test(`ignores non-local or inactive context ${marked}`, () => {
			const { text, loc } = atCursor(marked);
			expect(imageCompletionAt(text, loc)).toBeNull();
		});
	}

	test('rejects out-of-range cursor positions', () => {
		expect(imageCompletionAt('![', -1)).toBeNull();
		expect(imageCompletionAt('![', 3)).toBeNull();
	});
});

function clipboardEvent(value: string, cursor: number, type = 'copy') {
	const target = {
		value,
		selectionStart: cursor,
		selectionEnd: cursor,
		readOnly: false,
		dispatchEvent: mock((_event: Event) => true),
		setRangeText(text: string, start: number, end: number, _mode: string) {
			this.value = this.value.slice(0, start) + text + this.value.slice(end);
			this.setSelectionRange(start + text.length, start + text.length);
		},
		setSelectionRange(start: number, end: number) {
			this.selectionStart = start;
			this.selectionEnd = end;
		},
		ownerDocument: {
			execCommand: mock((command: string) => {
				expect(command).toBe('delete');
				target.value = target.value.slice(0, target.selectionStart) + target.value.slice(target.selectionEnd);
				target.selectionEnd = target.selectionStart;
				return true;
			}),
		},
	};
	const event = {
		type,
		currentTarget: target,
		clipboardData: { setData: mock((_type: string, _value: string) => {}) },
		preventDefault: mock(() => {}),
	};
	return { target, event, run: () => handleLineClipboard(event as unknown as ClipboardEvent) };
}

describe('whole-line clipboard', () => {
	const lines = [
		{ name: 'first line', value: 'first\nmiddle\nlast', cursor: 0, copied: 'first\n', remaining: 'middle\nlast', cutCursor: 0 },
		{ name: 'newline at end of first line', value: 'first\nmiddle\nlast', cursor: 5, copied: 'first\n', remaining: 'middle\nlast', cutCursor: 0 },
		{ name: 'middle line', value: 'first\nmiddle\nlast', cursor: 8, copied: 'middle\n', remaining: 'first\nlast', cutCursor: 6 },
		{ name: 'last line', value: 'first\nmiddle\nlast', cursor: 17, copied: 'last', remaining: 'first\nmiddle', cutCursor: 12 },
		{ name: 'single line', value: 'only', cursor: 2, copied: 'only', remaining: '', cutCursor: 0 },
		{ name: 'empty first line', value: '\nlast', cursor: 0, copied: '\n', remaining: 'last', cutCursor: 0 },
		{ name: 'empty middle line', value: 'first\n\nlast', cursor: 6, copied: '\n', remaining: 'first\nlast', cutCursor: 6 },
		{ name: 'empty last line', value: 'first\n', cursor: 6, copied: '\n', remaining: 'first', cutCursor: 5 },
	];

	for (const { name, value, cursor, copied, remaining, cutCursor } of lines) {
		test(`copies ${name} without moving the cursor`, () => {
			const { target, event, run } = clipboardEvent(value, cursor);
			run();
			expect(event.clipboardData.setData).toHaveBeenCalledWith('text/plain', copied);
			expect(event.preventDefault).toHaveBeenCalledTimes(1);
			expect(target.value).toBe(value);
			expect(target.selectionStart).toBe(cursor);
			expect(target.selectionEnd).toBe(cursor);
			expect(target.ownerDocument.execCommand).not.toHaveBeenCalled();
		});

		test(`cuts ${name} using native deletion`, () => {
			const { target, event, run } = clipboardEvent(value, cursor, 'cut');
			run();
			expect(event.clipboardData.setData).toHaveBeenCalledWith('text/plain', copied);
			expect(event.preventDefault).toHaveBeenCalledTimes(1);
			expect(target.ownerDocument.execCommand).toHaveBeenCalledTimes(1);
			expect(target.value).toBe(remaining);
			expect(target.selectionStart).toBe(cutCursor);
			expect(target.selectionEnd).toBe(cutCursor);
		});
	}

	for (const type of ['copy', 'cut']) {
		test(`leaves ${type} with a selection unchanged`, () => {
			const { target, event, run } = clipboardEvent('some text', 1, type);
			target.selectionEnd = 4;
			run();
			expect(event.preventDefault).not.toHaveBeenCalled();
			expect(event.clipboardData.setData).not.toHaveBeenCalled();
			expect(target.ownerDocument.execCommand).not.toHaveBeenCalled();
		});

		test(`leaves ${type} in an empty field unchanged`, () => {
			const { event, run } = clipboardEvent('', 0, type);
			run();
			expect(event.preventDefault).not.toHaveBeenCalled();
			expect(event.clipboardData.setData).not.toHaveBeenCalled();
		});

		test(`leaves ${type} without clipboard access unchanged`, () => {
			const { event, run } = clipboardEvent('text', 0, type);
			(event as { clipboardData: unknown }).clipboardData = null;
			run();
			expect(event.preventDefault).not.toHaveBeenCalled();
		});
	}

	test('updates the field and notifies input handlers when native deletion is unavailable', () => {
		const { target, event, run } = clipboardEvent('first\nmiddle\nlast', 8, 'cut');
		target.ownerDocument.execCommand.mockImplementation(() => false);
		run();
		expect(event.clipboardData.setData).toHaveBeenCalledWith('text/plain', 'middle\n');
		expect(target.value).toBe('first\nlast');
		expect(target.selectionStart).toBe(6);
		expect(target.selectionEnd).toBe(6);
		expect(target.dispatchEvent).toHaveBeenCalledTimes(1);
		const input = target.dispatchEvent.mock.calls[0][0];
		expect(input.type).toBe('input');
		expect(input.bubbles).toBe(true);
	});

	test('does not cut a read-only field', () => {
		const { target, event, run } = clipboardEvent('text', 0, 'cut');
		target.readOnly = true;
		run();
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(target.ownerDocument.execCommand).not.toHaveBeenCalled();
	});
});
