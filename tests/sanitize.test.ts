import { test, expect } from 'bun:test';
import { sanitize } from '../src/helpers/sanitize';

test('strips event handler attributes from tags', () => {
	expect(sanitize('<div onclick="steal()">hi</div>'))
		.toBe('<div>hi</div>');
	expect(sanitize("<a href='javascript:alert(1)'>x</a>"))
		.toBe("<a href='alert(1)'>x</a>");
});

test('strips SVG event handlers after quoted angle brackets', () => {
	expect(sanitize('<svg data-label="a > b" onload="steal()"><path title=\'a > b\' onclick="steal()"/></svg>'))
		.toBe('<svg data-label="a > b"><path title=\'a > b\'/></svg>');
});

test('still sanitizes malformed tags with unbalanced quotes', () => {
	expect(sanitize('<img src=x\' onerror=alert(1)>')).not.toContain('onerror');
	expect(sanitize('<img src=x" onerror=alert(1)>')).not.toContain('onerror');
});

test('strips javascript URLs in SVG xlink attributes', () => {
	expect(sanitize('<a xlink:href="javascript:steal()"><text>link</text></a>'))
		.toBe('<a xlink:href="steal()"><text>link</text></a>');
});

test('does not fuse trailing text into a new event handler', () => {
	expect(sanitize('<img src=a onerror=alert(1)> onerror=alert(2)>x'))
		.toBe('<img src=a> onerror=alert(2)>x');
});

test('removes iframes including srcdoc content', () => {
	expect(sanitize('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).toBe('');
});

test('leaves prose that looks like an event handler alone', () => {
	expect(sanitize('<td>all versions (current versions only = 3.36)</td>'))
		.toBe('<td>all versions (current versions only = 3.36)</td>');
	expect(sanitize('<td>current versions only = 0.80</td>'))
		.toBe('<td>current versions only = 0.80</td>');
});

test('still sanitizes attributes on the tags surrounding such prose', () => {
	expect(sanitize('<td title="x" onmouseover="p0wn">only = 42</td>'))
		.toBe('<td title="x">only = 42</td>');
});