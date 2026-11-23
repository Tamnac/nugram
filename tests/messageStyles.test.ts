import { describe, expect, test } from 'bun:test';
import { Remarkable } from 'remarkable';
import { enableStyle, enableSvg } from '../src/helpers/markdown';
import { sanitize } from '../src/helpers/sanitize';
import { extractStyles, mayHaveStyle, scopeCss, scopeRules, stripStyles, type CssRule } from '../src/helpers/messageStyles';

const parser = new Remarkable({ html: true, typographer: false });
enableSvg(parser);
enableStyle(parser);
const render = (s: string) => sanitize(parser.render(s));

describe('style elements in markdown', () => {
	test('a block keeps blank lines and markdown characters in the CSS', () => {
		const css = '.a > .b { color: red }\n\n.c *, .d _x_ { margin: 0 }';
		const html = render(`before\n\n<style>\n${css}\n</style>\n\nafter`);
		expect(extractStyles(html)).toBe(`\n${css}\n`);
		expect(stripStyles(html)).toBe('<p>before</p>\n\n<p>after</p>\n');
	});

	test('an inline element is kept raw inside a paragraph', () => {
		const html = render('text <style>.a > b { x: *y* }</style> more');
		expect(extractStyles(html)).toBe('.a > b { x: *y* }');
		expect(stripStyles(html)).toBe('<p>text  more</p>\n');
	});

	test('an element inside an svg is found too', () => {
		const html = render('<svg viewBox="0 0 1 1"><style>.ink{fill:red}</style><path d="M0 0"/></svg>');
		expect(extractStyles(html)).toBe('.ink{fill:red}');
		expect(stripStyles(html)).toBe('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
	});

	test('code is not an element', () => {
		const html = render('```html\n<style>.a{}</style>\n```\n\nuse `<style>.b{}</style>` here');
		expect(extractStyles(html)).toBe('');
		expect(stripStyles(html)).toBe(html);
	});

	test('several elements, any case and attributes, are joined in order', () => {
		const html = render('<style media="screen">.a{}</style>\n\n<STYLE>.b{}</STYLE>');
		expect(extractStyles(html)).toBe('.a{}\n.b{}');
	});

	test('an element still streaming is not applied, and hidden from the bubble', () => {
		const html = render('before\n\n<style>body{display:none}');
		expect(extractStyles(html)).toBe('');
		expect(stripStyles(html)).toBe('<p>before</p>\n');
	});

	test('SVG style text has its escaped angle brackets restored', () => {
		const html = render('<svg><style>.a > b { fill: red }</style></svg>');
		expect(html).toContain('&gt;');
		expect(extractStyles(html)).toBe('.a > b { fill: red }');
	});

	test('similar tag names are not styles', () => {
		expect(extractStyles(render('<styles>.a{}</styles>'))).toBe('');
	});

	test('mayHaveStyle', () => {
		expect(mayHaveStyle('x <style>')).toBe(true);
		expect(mayHaveStyle('<STYLE>')).toBe(true);
		expect(mayHaveStyle('no styles here')).toBe(false);
	});
});

describe('scoping', () => {
	const rule = (kind: string, cssText: string): CssRule => ({ kind, cssText });

	test('nests style and conditional rules, hoists keyframes, drops other at-rules', () => {
		const css = scopeRules([
			rule('CSSStyleRule', 'body { color: red; }'),
			rule('CSSKeyframesRule', '@keyframes k { from { opacity: 0; } }'),
			rule('CSSMediaRule', '@media (width > 1px) { .a { color: blue; } }'),
			rule('CSSFontFaceRule', '@font-face { font-family: x; }'),
			rule('CSSImportRule', '@import url(x.css);'),
		]);
		expect(css).toBe([
			'@keyframes k { from { opacity: 0; } }',
			':where(.messageList) {',
			'body { color: red; }',
			'@media (width > 1px) { .a { color: blue; } }',
			'}',
		].join('\n'));
	});

	test('nothing to scope gives no CSS', () => {
		expect(scopeRules([rule('CSSFontFaceRule', '@font-face {}')])).toBe('');
		expect(scopeCss('  \n')).toBe('');
	});

	test('the parsed rules are what get nested', () => {
		const seen: string[] = [];
		const css = scopeCss('.a{}', source => (seen.push(source), [rule('CSSStyleRule', '.a { }')]));
		expect(seen).toEqual(['.a{}']);
		expect(css).toBe(':where(.messageList) {\n.a { }\n}');
	});
});
