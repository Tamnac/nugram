import { describe, expect, test } from 'bun:test';
import { Remarkable } from 'remarkable';
import { thinkingParser, splitRow, enableSvg, enableSupSub, enableMath } from '../src/helpers/markdown';
import { sanitize } from '../src/helpers/sanitize';

const render = (s: string) => thinkingParser.render(s);
const hasMath = (html: string) => html.includes('class="katex"');
const hasDisplay = (html: string) => html.includes('katex-display');

function svgParser(html = true) {
	const parser = new Remarkable({ html, typographer: false });
	enableSupSub(parser);
	enableMath(parser);
	enableSvg(parser);
	const htmltag = parser.renderer.rules.htmltag;
	parser.renderer.rules.htmltag = (tokens, idx, options, env) => {
		if (/^<\/?span(?:\s|>)/i.test(tokens[idx].content)) return htmltag(tokens, idx, options, env);
		return tokens[idx].content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	};
	return parser;
}

const svg = [
	'<svg viewBox="0 0 440 600" width="440" xmlns="http://www.w3.org/2000/svg">',
	'<defs>',
	'<style>.ink{font-family:cursive;fill:#2b1a0e}</style>',
	'<filter id="grain"><feTurbulence baseFrequency=".06"/><feDisplacementMap in="SourceGraphic" scale="5"/></filter>',
	'</defs>',
	'<g filter="url(#grain)"><path d="M0 0L10 10"/><text class="ink">"Yet." **literal** $x$ ^2^</text></g>',
	'</svg>',
].join('\n');

describe('SVG', () => {
	test('preserves a complete standalone SVG with definitions and styles', () => {
		const html = svgParser().render(`Before\n${svg}\nAfter`);
		expect(html).toBe(`<p>Before</p>\n${svg}\n<p>After</p>\n`);
	});

	test('blank lines do not split the SVG into Markdown blocks', () => {
		const spaced = svg.replace('<defs>\n', '<defs>\n\n').replace('</defs>\n', '</defs>\n\n');
		expect(svgParser().render(`${spaced}\n`)).toBe(`${spaced}\n`);
	});

	test('inline SVG bypasses individual tag escaping while surrounding Markdown still renders', () => {
		const inline = '<svg><g><text>**literal**</text><path d="M0 0"/></g></svg>';
		expect(svgParser().render(`**Before** ${inline} *after*`))
			.toBe(`<p><strong>Before</strong> ${inline} <em>after</em></p>\n`);
		expect(svgParser().render(`${inline} **after**`))
			.toBe(`<p>${inline} <strong>after</strong></p>\n`);
	});

	test('nested SVGs, quoted attributes, comments and CDATA do not end the element early', () => {
		const nested = '<svg data-label="a > b"><!-- </svg> --><svg><text data-label="</svg>"><![CDATA[</svg>]]></text></svg><path/></svg>';
		expect(svgParser().render(`${nested}\nAfter`)).toBe(`${nested}\n<p>After</p>\n`);
	});

	test('self-closing and consecutive SVGs remain intact', () => {
		const first = '<svg width="10"/>';
		const second = '<svg><rect width="10" height="10"/></svg>';
		expect(svgParser().render(`${first}\n${second}\n`)).toBe(`${first}\n${second}\n`);
		expect(svgParser().render(`See ${first} ${second}.`)).toBe(`<p>See ${first} ${second}.</p>\n`);
	});

	test('SVG in fenced and inline code remains escaped', () => {
		const parser = svgParser();
		const fenced = parser.render(`\`\`\`svg\n${svg}\n\`\`\``);
		expect(fenced).toContain('<pre><code');
		expect(fenced).toContain('&lt;svg');
		expect(fenced).not.toContain('<svg');
		const inline = parser.render('`<svg><path/></svg>`');
		expect(inline).toContain('<code>&lt;svg&gt;&lt;path/&gt;&lt;/svg&gt;</code>');
	});

	test('respects disabled raw HTML and leaves thinking rendering unchanged', () => {
		expect(svgParser(false).render(svg)).not.toContain('<svg');
		expect(thinkingParser.render(svg)).not.toContain('<svg');
	});

	test('unknown tags outside SVG are still escaped', () => {
		const html = svgParser().render(`<Character>Before</Character> <svg><path/></svg>`);
		expect(html).toContain('&lt;Character&gt;Before&lt;/Character&gt;');
		expect(html).toContain('<svg><path/></svg>');
	});

	test('incomplete SVG does not consume subsequent Markdown blocks', () => {
		const html = svgParser().render('<svg><path/>\n\n# After');
		expect(html).toContain('<h1>After</h1>');
		expect(html).toContain('&lt;svg&gt;&lt;path/&gt;');
		expect(html).not.toContain('<svg');
	});

	test('repeated incomplete SVGs are escaped without repeated full scans', () => {
		const count = 5000;
		for (const input of ['<svg>\n'.repeat(count), 'Hello <svg>x '.repeat(count), '<svg a="b" '.repeat(count), '<svg a="'.repeat(count)]) {
			const html = svgParser().render(input);
			expect(html).not.toContain('<svg');
			expect(html.match(/&lt;svg/g)?.length).toBe(count);
		}
	});

	test('non-SVG child tags stay escaped in block and inline SVGs', () => {
		const content = '<svg><foreignObject><iframe src="https://example.com"></iframe></foreignObject><script>alert(1)</script><Character/><path/></svg>';
		for (const html of [svgParser().render(content), svgParser().render(`See ${content}`)]) {
			expect(html).toContain('&lt;foreignObject&gt;');
			expect(html).toContain('&lt;iframe');
			expect(html).toContain('&lt;script&gt;');
			expect(html).toContain('&lt;Character/&gt;');
			expect(html).toContain('<path/>');
			expect(html).not.toContain('<iframe');
			expect(html).not.toContain('<script');
		}
	});

	test('malformed comments and attributes cannot hide non-SVG tags', () => {
		for (const content of [
			'<svg><!--> <script>alert(1)</script> --></svg>',
			'<svg><!-- --!> <script>alert(1)</script> --></svg>',
			'<svg><g a=x" ><script>alert(1)</script> <g b=y"></g></svg>',
		]) {
			const html = svgParser().render(content);
			expect(html).not.toContain('<script>');
			expect(html).toContain('&lt;script&gt;');
		}
	});

	test('SVG in blockquotes and lists keeps its container', () => {
		expect(svgParser().render('> <svg>\n> <path/>\n> </svg>\n'))
			.toBe('<blockquote>\n<svg>\n<path/>\n</svg>\n</blockquote>\n');
		const html = svgParser().render('- <svg>\n  <path/>\n  </svg>');
		expect(html).toContain('<li><svg>\n<path/>\n</svg>');
		expect(html).toContain('</li>');
	});

	test('raw SVG still goes through the existing sanitizer', () => {
		const unsafe = '<svg data-label="a > b" onload="steal()"><path data-label="a > b" onclick="steal()"/><a xlink:href="javascript:steal()"><text>link</text></a></svg>';
		const html = sanitize(svgParser().render(unsafe));
		expect(html).toContain('<svg data-label="a > b"><path data-label="a > b"/><a xlink:href="steal()">');
		expect(html).not.toContain('onload');
		expect(html).not.toContain('onclick');
		expect(html).not.toContain('javascript:');
	});
});

describe('math', () => {
	test('multi-line \\[ block', () => {
		const html = render('Before\n\\[\n\\text{error}=\\frac{1}{K}\\sum_{k=1}^{K}\\|R_k-G_k\\|_2^2.\n\\]\nAfter');
		expect(hasDisplay(html)).toBe(true);
		expect(html).toContain('<p>Before</p>');
		expect(html).toContain('<p>After</p>');
		expect(html).not.toContain('<sup>');
	});

	test('single-line $$ block and inline display', () => {
		expect(hasDisplay(render('$$x^2$$'))).toBe(true);
		expect(hasDisplay(render('see $$x^2$$ here'))).toBe(true);
	});

	test('inline \\( and strict $', () => {
		expect(hasMath(render('a \\(x_1\\) b'))).toBe(true);
		expect(hasMath(render('a $x_1$ b'))).toBe(true);
		expect(hasDisplay(render('a $x_1$ b'))).toBe(false);
	});

	test('currency is not math', () => {
		for (const s of ['costs $5 and $10', '$5-$10', 'pay $ 5 now$', 'a $x $ b', 'escaped \\$x$'])
			expect(hasMath(render(s))).toBe(false);
	});

	test('unclosed delimiters stay text', () => {
		expect(hasMath(render('\\[\nx = 1'))).toBe(false);
		expect(hasMath(render('$$x'))).toBe(false);
	});

	test('math inside code is literal', () => {
		expect(hasMath(render('`$x$`'))).toBe(false);
		expect(hasMath(render('```\n$$x$$\n```'))).toBe(false);
	});

	test('table rows keep math with pipes in one cell', () => {
		const html = render([
			'| Setting | What it computes |',
			'|---|---|',
			'| `:l2` | Error: \\(\\max_k \\|R_k-G_k\\|_2/\\|G_k\\|_2\\). |',
			'| abs | $|x|$ and $$\\|x\\|$$ |',
			'| code | `a || b` |',
			'| plain | a \\| b |',
		].join('\n'));
		const rows = html.split('<tr>').slice(1).map(r => (r.match(/<t[hd][ >]/g) ?? []).length);
		expect(rows).toEqual([2, 2, 2, 2, 2]);
		expect(html.match(/class="katex"/g)?.length).toBe(3);
		expect(hasDisplay(html)).toBe(true);
		expect(html).toContain('<code>a || b</code>');
		expect(html).toContain('a | b');
	});

	test('splitRow', () => {
		expect(splitRow('| a | b |')).toEqual([' a ', ' b ']);
		expect(splitRow('a | b')).toEqual(['a ', ' b']);
		expect(splitRow('| $5 | $10 |')).toEqual([' $5 ', ' $10 ']);
		expect(splitRow('| `x | y |')).toEqual([' `x ', ' y ']);
	});

	test('invalid latex does not throw', () => {
		expect(() => render('$$\\frac{$$')).not.toThrow();
	});
});
