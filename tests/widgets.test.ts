import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildSrcdoc, broadcastWidgetTheme, discoverWidgets, formatWidgets, parseWidgetDescription, parseWidgetHeight, widgetSlotHtml, widgetTheme, WIDGET_THEME_VARS, type WidgetTheme } from '../src/helpers/widgets';
import type { Backend } from '../src/helpers/backend';

const theme: WidgetTheme = { '--back': 'light-dark(#eee, #111)', '--rad': '8px' };

describe('parseWidgetDescription', () => {
	test('double and single quotes, either attribute order', () => {
		expect(parseWidgetDescription('<head><meta name="description" content="Month view"></head>')).toBe('Month view');
		expect(parseWidgetDescription("<meta content='Month view' name='Description' />")).toBe('Month view');
	});

	test('skips other meta tags and decodes entities', () => {
		const html = '<meta charset="utf-8"><meta name="viewport" content="x"><meta name="description" content="a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;">';
		expect(parseWidgetDescription(html)).toBe('a & b <c> "d" \'e\'');
	});

	test('a > inside the content is not the end of the tag', () => {
		expect(parseWidgetDescription('<meta name="description" content="Args: n (> 0), dir (\'<-\' or \'->\')">')).toBe("Args: n (> 0), dir ('<-' or '->')");
	});

	test('decodes &apos; and numeric references', () => {
		expect(parseWidgetDescription('<meta name="description" content="it&apos;s&#10;two &#x2192; lines &#0; &#xFFFFFF;">'))
			.toBe("it's\ntwo → lines &#0; &#xFFFFFF;");
	});

	test('missing meta yields an empty description', () => {
		expect(parseWidgetDescription('<html><body>hi</body></html>')).toBe('');
	});
});

describe('discoverWidgets', () => {
	const tree: Record<string, Array<[string, boolean]>> = {
		'/a': [['calendar', true], ['empty', true], ['notes.txt', false]],
		'/a/calendar': [['Widget.HTML', false]],
		'/a/empty': [['readme.md', false]],
		'/b': [['Calendar', true], ['counter', true]],
		'/b/Calendar': [['widget.html', false]],
		'/b/counter': [['widget.html', false]],
	};
	const files: Record<string, string> = {
		'/a/calendar/Widget.HTML': '<meta name="description" content="first">',
		'/b/Calendar/widget.html': '<meta name="description" content="second">',
		'/b/counter/widget.html': '<p>no meta</p>',
	};
	const backend = {
		readDir: async (dir: string) => {
			const entries = tree[dir];
			if (!entries) throw new Error('no such dir');
			return entries.map(([name, isDirectory]) => ({ name, isDirectory }));
		},
		readText: async (path: string) => {
			if (!(path in files)) throw new Error('no such file');
			return files[path];
		},
	} as unknown as Backend;

	test('finds <root>/<name>/widget.html, earlier root wins, missing roots skipped', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(await discoverWidgets(['/missing', '/a', '/b'], backend)).toEqual([
				{ name: 'calendar', description: 'first', path: '/a/calendar/Widget.HTML' },
				{ name: 'counter', description: '', path: '/b/counter/widget.html' },
			]);
			// The missing root is expected and stays quiet; the undocumented widget doesn't
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]![0])).toContain('widget counter: no <meta name="description"');
		} finally {
			warn.mockRestore();
		}
	});
});

describe('formatWidgets', () => {
	test('empty list yields no macro text', () => {
		expect(formatWidgets([])).toBe('');
	});

	test('lists names with collapsed descriptions and explains usage', () => {
		const out = formatWidgets([{ name: 'calendar', description: 'Month view.\nArgs: date', path: '/w/calendar/widget.html' }]);
		expect(out.startsWith('<widgets>\n')).toBe(true);
		expect(out.endsWith('\n</widgets>')).toBe(true);
		expect(out).toContain('show_widget tool when it is among your tools');
		expect(out).toContain('<widget name="..."');
		expect(out).toContain('- calendar: Month view. Args: date');
	});
});

describe('buildSrcdoc', () => {
	/** The injected script, run the way a frame would: with the rule element, a message listener and events. */
	function injectedScript(theme: WidgetTheme) {
		const script = buildSrcdoc('', {}, theme).match(/<script>([\s\S]*)<\/script>/)![1]!;
		const listeners: Array<(event: any) => void> = [];
		const events: Array<{ type: string; detail: unknown }> = [];
		const style = { textContent: '' };
		const win: Record<string, any> = { parent: {} };
		class FakeCustomEvent {
			constructor(readonly type: string, init?: { detail?: unknown }) { this.detail = init?.detail; }
			detail: unknown;
		}
		new Function('window', 'document', 'addEventListener', 'dispatchEvent', 'CustomEvent', script)(
			win,
			{ getElementById: () => style },
			(_type: string, listener: any) => listeners.push(listener),
			(event: any) => events.push({ type: event.type, detail: event.detail }),
			FakeCustomEvent);
		return { win, style, events, send: (source: unknown, data: unknown) => listeners.forEach(l => l({ source, data })) };
	}

	test('defines the theme, widgetArgs and dialog stubs before the document', () => {
		const out = buildSrcdoc('<p>hi</p>', { date: 'today' }, theme);
		expect(out).toStartWith('<style id="nugramTheme">:root{color-scheme:light dark;--back:light-dark(#eee, #111);--rad:8px}</style>');
		expect(out).toContain('<script>window.widgetArgs = {"date":"today"};window.widgetTheme = {"--back":"light-dark(#eee, #111)","--rad":"8px"};');
		expect(out).toEndWith('</script><p>hi</p>');
	});

	test('an empty theme still sets color-scheme', () => {
		expect(buildSrcdoc('', {}, {})).toStartWith('<style id="nugramTheme">:root{color-scheme:light dark;}</style>');
	});

	test('keeps a doctype first', () => {
		const out = buildSrcdoc('<!DOCTYPE html><html></html>', {}, theme);
		expect(out).toStartWith('<!DOCTYPE html><style id="nugramTheme">');
		expect(out).toEndWith('</script><html></html>');
	});

	test('follows a theme message from the host, and nothing else', () => {
		const { win, style, events, send } = injectedScript(theme);
		expect(win.widgetTheme).toEqual(theme);
		send({}, { type: 'nugram-theme', vars: { '--text': '#fff' } });
		send(win.parent, { type: 'other', vars: { '--text': '#fff' } });
		expect(style.textContent).toBe('');
		expect(events).toEqual([]);
		send(win.parent, { type: 'nugram-theme', vars: { '--text': '#fff' } });
		expect(style.textContent).toBe(':root{color-scheme:light dark;--text:#fff;}');
		expect(win.widgetTheme).toEqual({ '--text': '#fff' });
		expect(events).toEqual([{ type: 'widgettheme', detail: { '--text': '#fff' } }]);
		// A repeat of the theme it already has is ignored, so a frame that just loaded can be sent it again
		send(win.parent, { type: 'nugram-theme', vars: { '--text': '#fff' } });
		expect(events.length).toBe(1);
	});

	test('dialogs warn and return what a sandboxed frame would', () => {
		const { win } = injectedScript({});
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(win.alert('x')).toBeUndefined();
			expect(win.confirm('x')).toBe(false);
			expect(win.prompt('x')).toBeNull();
			expect(warn).toHaveBeenCalledTimes(3);
			expect(String(warn.mock.calls[1]![0])).toContain('confirm() is not available');
		} finally {
			warn.mockRestore();
		}
	});

	test('a </script> inside an arg cannot close the tag', () => {
		const out = buildSrcdoc('', { x: '</script><b>' }, {});
		expect(out.match(/<\/script>/g)?.length).toBe(1);
		expect(out).toContain('\\u003c/script>');
	});
});

describe('widgetTheme and broadcastWidgetTheme', () => {
	/** Runs `fn` with the globals a browser would provide, then puts them back. */
	function withGlobals(globals: Record<string, unknown>, fn: () => void) {
		const previous = new Map(Object.keys(globals).map(k => [k, (globalThis as any)[k]]));
		Object.assign(globalThis, globals);
		try { fn(); } finally { for (const [k, v] of previous) (globalThis as any)[k] = v; }
	}

	test('reads the vars off body, skipping the ones that are unset', () => {
		const values: Record<string, string> = { '--back': '#fff', '--rad': ' 8px ' };
		withGlobals({ document: { body: {} }, getComputedStyle: () => ({ getPropertyValue: (name: string) => values[name] ?? '' }) }, () => {
			expect(widgetTheme()).toEqual({ '--back': '#fff', '--rad': '8px' });
		});
	});

	test('a theme switch reaches every frame still on screen', () => {
		const posts: unknown[] = [];
		const frames = [{ contentWindow: { postMessage: (message: unknown) => posts.push(message) } }, { contentWindow: null }];
		withGlobals({ document: { querySelectorAll: () => frames } }, () => broadcastWidgetTheme({ '--back': '#000' }));
		expect(posts).toEqual([{ type: 'nugram-theme', vars: { '--back': '#000' } }]);
	});
});

// The preview script in the widget-authoring skill copies nugram's mounting helpers
const preview: any = await import('../skills/widget-authoring/preview.mjs' as string);

describe('preview.mjs mirrors widgets.ts', () => {
	const pages = [
		'<!DOCTYPE html><meta name="description" content="a > b &amp; &#10;c"><p>x</p>',
		"\uFEFF  <!doctype html>\n<meta content='d' name=Description>",
		'<p>no doctype, no meta</p>',
	];
	const tags = [
		'<widget name="a" x="1" height="300px" />',
		"<Widget name='b' constructor='c' t=&#39;q&#39; bare>",
		'<widget x="no name"/>',
	];

	test('description, height and srcdoc', () => {
		for (const html of pages) {
			expect(preview.parseWidgetDescription(html)).toBe(parseWidgetDescription(html));
			expect(preview.buildSrcdoc(html, { k: '</script>' }, theme)).toBe(buildSrcdoc(html, { k: '</script>' }, theme));
			expect(preview.buildSrcdoc(html, {}, {})).toBe(buildSrcdoc(html, {}, {}));
		}
		expect([...preview.WIDGET_THEME_VARS]).toEqual([...WIDGET_THEME_VARS]);
		for (const h of [300, '300', '300px', 'tall', 0, null])
			expect(preview.parseWidgetHeight(h)).toBe(parseWidgetHeight(h));
	});

	test('the stand-in theme is the default (modern) theme from themes.css', () => {
		const css = readFileSync(new URL('../src/css/themes.css', import.meta.url), 'utf8');
		const varsIn = (selector: string) => {
			const at = css.indexOf(`${selector} {`);
			if (at < 0) throw new Error(`themes.css has no ${selector} block`);
			const start = at + selector.length + 2;
			const vars: Record<string, string> = {};
			for (const line of css.slice(start, css.indexOf('\n}', start)).split('\n')) {
				const m = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/);
				if (m) vars[m[1]!] = m[2]!;
			}
			return vars;
		};
		const modern = { ...varsIn('body'), ...varsIn('body[data-theme="modern"]') };
		expect(Object.keys(preview.PREVIEW_THEME).sort()).toEqual([...WIDGET_THEME_VARS].sort());
		for (const [name, value] of Object.entries(preview.PREVIEW_THEME))
			expect(`${name}: ${value}`).toBe(`${name}: ${modern[name]}`);
	});

	test('inline tag args', () => {
		for (const tag of tags) {
			const html = widgetSlotHtml(tag);
			const mirrored = preview.tagArgs(tag);
			if (html === null) {
				expect(mirrored.name).toBeUndefined();
				continue;
			}
			expect(JSON.parse(decodeURIComponent(html.match(/data-args="([^"]*)"/)![1]!))).toEqual(mirrored.args);
		}
	});
});

test('parseWidgetHeight accepts numbers, digit strings and px', () => {
	expect([300, '300', ' 300px ', '300 PX'].map(parseWidgetHeight)).toEqual([300, 300, 300, 300]);
	expect([0, -5, 1.5, '0', 'tall', '30em', '', null, undefined].map(parseWidgetHeight)).toEqual(Array(9).fill(undefined));
});

describe('widgetSlotHtml', () => {
	const slot = (tag: string) => {
		const html = widgetSlotHtml(tag);
		if (html === null) return null;
		const attr = (k: string) => html.match(new RegExp(`${k}="([^"]*)"`))?.[1];
		const args = attr('data-args');
		return { name: attr('data-name'), args: args === undefined ? undefined : JSON.parse(decodeURIComponent(args)), height: attr('data-height') };
	};

	test('self-closing and open tags become slots', () => {
		expect(slot('<widget name="counter" start="5" />')).toEqual({ name: 'counter', args: { start: '5' }, height: undefined });
		expect(slot('<widget name="counter">')).toEqual({ name: 'counter', args: {}, height: undefined });
		expect(widgetSlotHtml('<widget name="c"/>')).toStartWith('<div class="widgetSlot"');
	});

	test('closing tag renders nothing', () => {
		expect(widgetSlotHtml('</widget>')).toBe('');
	});

	test('missing name leaves the tag alone', () => {
		expect(widgetSlotHtml('<widget date="today" />')).toBeNull();
	});

	test('single quotes and unquoted values', () => {
		expect(slot("<Widget name='cal' title='say \"hi\"' n=3>")?.args).toEqual({ title: 'say "hi"', n: '3' });
	});

	test('height is passed through for mount-time validation, never an arg', () => {
		expect(slot('<widget name="a" height="250px" />')).toEqual({ name: 'a', args: {}, height: '250px' });
		expect(slot('<widget name="a" height=\'"><b>\' />')?.height).toBe('&quot;&gt;&lt;b&gt;');
	});

	test('Object.prototype names are ordinary args', () => {
		expect(slot('<widget name="a" constructor="x" toString="y" __proto__="z" />')?.args)
			.toEqual(JSON.parse('{"constructor":"x","tostring":"y","__proto__":"z"}'));
	});

	test('numeric references can carry a newline', () => {
		expect(slot('<widget name="a" steps="one&#10;two" />')?.args).toEqual({ steps: 'one\ntwo' });
	});

	test('values are escaped in the output', () => {
		const html = widgetSlotHtml('<widget name=\'a"><script>\' x=\'" onload="y\' />')!;
		expect(html).not.toContain('<script>');
		expect(html).toContain('data-name="a&quot;&gt;&lt;script&gt;"');
		expect(html).not.toMatch(/\sonload=/);
		expect(slot('<widget name="a" x=\'" onload="y\' />')?.args).toEqual({ x: '" onload="y' });
	});
});
