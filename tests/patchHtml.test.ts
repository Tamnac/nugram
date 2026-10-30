import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { patchHtml } from '../src/helpers/patchHtml';

const window = new Window();
Object.assign(globalThis, { Node: window.Node });

function setup(html: string) {
	const container = window.document.createElement('div') as unknown as HTMLElement;
	container.innerHTML = html;
	return container;
}

describe('patchHtml', () => {
	test('result matches the new html', () => {
		const el = setup('<p>a</p><ul><li>x</li></ul>');
		patchHtml(el, '<h1>t</h1><p>a</p><p class="c" id="i">b</p>');
		expect(el.innerHTML).toBe('<h1>t</h1><p>a</p><p class="c" id="i">b</p>');
		patchHtml(el, '');
		expect(el.innerHTML).toBe('');
	});

	test('appended text keeps earlier nodes and the growing element', () => {
		const el = setup('<p>one</p><p>two <em>th</em></p>');
		const [first, second] = Array.from(el.children);
		const emphasis = second.querySelector('em')!;
		const text = emphasis.firstChild;
		patchHtml(el, '<p>one</p><p>two <em>three</em></p><p>four</p>');
		expect(el.innerHTML).toBe('<p>one</p><p>two <em>three</em></p><p>four</p>');
		expect(el.children[0]).toBe(first);
		expect(el.children[1]).toBe(second);
		expect(second.querySelector('em')).toBe(emphasis);
		expect(emphasis.firstChild).toBe(text);
	});

	test('a different element type is replaced, attributes are synced', () => {
		const el = setup('<p class="a" title="t">x</p>');
		const p = el.firstElementChild!;
		patchHtml(el, '<p class="b">x</p>');
		expect(el.firstElementChild).toBe(p);
		expect(el.innerHTML).toBe('<p class="b">x</p>');
		patchHtml(el, '<ol><li>x</li></ol>');
		expect(el.firstElementChild).not.toBe(p);
		expect(el.innerHTML).toBe('<ol><li>x</li></ol>');
	});

	test('prepare changes the new tree before comparing', () => {
		const el = setup('');
		const prepare = (root: HTMLElement) => root.querySelectorAll('pre').forEach(pre => pre.classList.add('wrapped'));
		patchHtml(el, '<pre>a</pre>', { prepare });
		const pre = el.firstElementChild!;
		patchHtml(el, '<pre>ab</pre>', { prepare });
		expect(el.firstElementChild).toBe(pre);
		expect(el.innerHTML).toBe('<pre class="wrapped">ab</pre>');
	});

	test('keep leaves state added after rendering alone', () => {
		const el = setup('<img data-local-src="a.png">');
		el.firstElementChild!.setAttribute('src', 'blob:resolved');
		patchHtml(el, '<img data-local-src="a.png"><p>more</p>', {
			keep: (live, next) => live.tagName === 'IMG' && live.getAttribute('data-local-src') === next.getAttribute('data-local-src'),
		});
		expect(el.innerHTML).toBe('<img data-local-src="a.png" src="blob:resolved"><p>more</p>');
	});
});
