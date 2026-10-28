#!/usr/bin/env node
/**
 * Preview a nugram widget the way nugram mounts it: a sandboxed srcdoc iframe of the
 * same size, with the theme vars, `window.widgetArgs` and the dialog stubs inserted first. Writes
 * an HTML page; `--run` and `--screenshot` open it in a headless Chromium browser.
 * Runs on Node, Bun or Deno with no dependencies. Usage: SKILL.md, or `--help`.
 *
 * The mounting helpers mirror src/helpers/widgets.ts in nugram; a test there keeps them in step.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ── Mirrors of nugram's widgets.ts ──

const DEFAULT_HEIGHT = 400;
const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

function decodeEntities(s) {
	return s.replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(amp|quot|apos|lt|gt));/g, (match, dec, hex, named) => {
		if (named) return entities[named];
		const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});
}

function parseAttrs(tag) {
	const attrs = Object.create(null);
	const body = tag.replace(/^<\/?[a-zA-Z][\w-]*/, '').replace(/\/?>$/, '');
	const re = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const m of body.matchAll(re)) {
		const key = m[1].toLowerCase();
		if (!(key in attrs)) attrs[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
	}
	return attrs;
}

export function parseWidgetDescription(html) {
	for (const [tag] of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
		const attrs = parseAttrs(tag);
		if (attrs.name?.toLowerCase() === 'description') return attrs.content ?? '';
	}
	return '';
}

export function parseWidgetHeight(value) {
	const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	const n = Number(text.match(/^(\d+)(?:\s*px)?$/i)?.[1]);
	return n > 0 ? n : undefined;
}

const DIALOG_STUBS = "for (const [name, result] of [['alert'], ['confirm', false], ['prompt', null]]) "
	+ "window[name] = () => (console.warn('widget: ' + name + '() is not available in widgets, show messages in the page instead'), result);";

/** Mirror of WIDGET_THEME_VARS in widgets.ts. */
export const WIDGET_THEME_VARS = [
	'--back', '--back-light', '--text', '--accent1', '--quote', '--italic', '--link', '--link-hover',
	'--border-subtle', '--shadow',
	'--rad-sm', '--rad', '--rad-lg',
	'--font-ui', '--font-message', '--font-monospace', '--line-height-normal', '--letter-spacing',
];

/**
 * Stand-in for the theme nugram injects: the default (modern) theme, copied from src/css/themes.css
 * by the mirror test in tests/widgets.test.ts. Every colour is light-dark(), so --dark picks the half.
 */
export const PREVIEW_THEME = {
	"--back": "light-dark(hsl(44, 16%, 91.5%), hsl(28, 10%, 10%))",
	"--back-light": "light-dark(hsl(44, 14%, 95.5%), hsl(28, 11%, 13.5%))",
	"--text": "light-dark(hsl(20, 18%, 14%), hsl(30, 8%, 87%))",
	"--accent1": "light-dark(hsl(14, 62%, 46%), hsl(16, 68%, 58%))",
	"--quote": "light-dark(hsl(120, 99%, 39%), hsl(120, 69%, 60%))",
	"--italic": "light-dark(hsl(200, 40%, 34%), hsl(200, 55%, 62%))",
	"--link": "light-dark(hsl(14, 65%, 42%), hsl(16, 72%, 62%))",
	"--link-hover": "light-dark(hsl(14, 75%, 34%), hsl(16, 85%, 72%))",
	"--border-subtle": "light-dark(rgba(70, 45, 30, 0.16), rgba(230, 180, 150, 0.18))",
	"--shadow": "light-dark(rgba(70, 45, 30, 0.14), rgba(0, 0, 0, 0.45))",
	"--rad-sm": "5px",
	"--rad": "8px",
	"--rad-lg": "12px",
	"--font-ui": "'system-ui', 'Segoe UI', 'Roboto', sans-serif",
	"--font-message": "'Bahnschrift Light', 'Source Sans Pro', 'system-ui', sans-serif",
	"--font-monospace": "'Consolas', 'Monaco', 'Courier New', monospace",
	"--line-height-normal": "1.35",
	"--letter-spacing": "0",
};

const THEME_RULE_PREFIX = ':root{color-scheme:light dark;';

/** The rule nugram injects before the widget's own CSS. */
export function widgetThemeCss(theme) {
	return THEME_RULE_PREFIX + Object.entries(theme).map(([name, value]) => `${name}:${value}`).join(';') + '}';
}

const THEME_STYLE_ID = 'nugramTheme';
const THEME_MESSAGE = 'nugram-theme';

const jsonScript = value => JSON.stringify(value).replace(/</g, '\\u003c');

const themeScript = theme => `window.widgetTheme = ${jsonScript(theme)};
(() => {
	const apply = vars => {
		if (JSON.stringify(window.widgetTheme) === JSON.stringify(vars)) return;
		window.widgetTheme = vars;
		let css = '';
		for (const [name, value] of Object.entries(vars)) css += name + ':' + value + ';';
		const rule = document.getElementById('${THEME_STYLE_ID}');
		if (rule) rule.textContent = ${JSON.stringify(THEME_RULE_PREFIX)} + css + '}';
		dispatchEvent(new CustomEvent('widgettheme', { detail: vars }));
	};
	addEventListener('message', event => {
		if (event.source === window.parent && event.data && event.data.type === '${THEME_MESSAGE}') apply(event.data.vars);
	});
})();`;

export function buildSrcdoc(html, args, theme) {
	const style = `<style id="${THEME_STYLE_ID}">${widgetThemeCss(theme)}</style>`;
	const script = `<script>window.widgetArgs = ${jsonScript(args)};${themeScript(theme)}${DIALOG_STUBS}</script>`;
	const doctype = html.match(/^\uFEFF?\s*<!doctype[^>]*>/i)?.[0] ?? '';
	return doctype + style + script + html.slice(doctype.length);
}

/** What an inline `<widget ... />` tag passes: every attribute but name and height, as strings. */
export function tagArgs(tag) {
	const { name, height, ...args } = parseAttrs(tag);
	return { name, height, args };
}

// ── Preview page ──

/** Runs inside each frame (preview only, not in nugram): reports errors, size and text to the page. */
function reporter() {
	const errors = [];
	const post = () => {
		const root = document.documentElement;
		const body = document.body;
		parent.postMessage({
			widgetPreview: true,
			errors,
			text: body ? body.innerText.slice(0, 3000) : '',
			contentHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0),
			contentWidth: Math.max(root.scrollWidth, body ? body.scrollWidth : 0),
			frameHeight: innerHeight,
			frameWidth: innerWidth,
		}, '*');
	};
	const show = value => value instanceof Error ? value.message
		: typeof value === 'object' && value !== null ? (() => { try { return JSON.stringify(value); } catch { return String(value); } })()
		: String(value);
	const record = text => { errors.push(text); post(); };
	addEventListener('error', e => {
		const el = e.target;
		if (el && el !== window && (el.src || el.href)) record(`failed to load ${el.src || el.href}`);
		else record(`${/^uncaught/i.test(e.message) ? '' : 'Uncaught '}${e.message}${e.lineno ? ` (line ${e.lineno})` : ''}`);
	}, true);
	addEventListener('unhandledrejection', e => record(`unhandled rejection: ${show(e.reason)}`));
	for (const level of ['error', 'warn']) {
		const original = console[level];
		console[level] = (...values) => {
			record(`console.${level}: ${values.map(show).join(' ')}`);
			original.apply(console, values);
		};
	}
	addEventListener('load', () => {
		post();
		new MutationObserver(post).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
		addEventListener('resize', post);
	});
}

/** Runs in the preview page: collects frame reports into #widget-preview-report. */
function host(labels) {
	const frames = [...document.querySelectorAll('iframe')];
	const reports = frames.map(() => null);
	const out = document.getElementById('widget-preview-report');
	const render = () => {
		out.textContent = reports.map((r, i) => {
			const lines = [`frame ${i + 1}: ${labels[i]}`];
			if (!r) return [...lines, '  no report: the widget is still loading, threw before load, or --no-report is set'].join('\n');
			lines.push(r.errors.length ? '  problems:' : '  problems: none', ...r.errors.map(e => `    ${e}`));
			const tall = r.contentHeight > r.frameHeight;
			lines.push(`  size: content ${r.contentWidth}x${r.contentHeight}px, frame ${r.frameWidth}x${r.frameHeight}px${tall ? ' (taller than the frame: check it scrolls)' : ''}${r.contentWidth > r.frameWidth ? ' (wider than the frame)' : ''}`);
			const text = r.text.split('\n').map(l => l.trim()).filter(Boolean);
			lines.push(text.length ? '  text:' : '  text: (none)', ...text.map(l => `    ${l}`));
			return lines.join('\n');
		}).join('\n\n');
	};
	addEventListener('message', e => {
		const i = frames.findIndex(f => f.contentWindow === e.source);
		if (i < 0 || !e.data?.widgetPreview) return;
		reports[i] = e.data;
		render();
	});
	render();
}

const escapeAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c');

function previewPage({ name, html, frames, width, report, theme }) {
	// On one line, so error line numbers still match the widget's file
	const reporterTag = `<script>(${String(reporter).replace(/\n\s*/g, ' ')})()</script>`;
	const frameHtml = frames.map(f => {
		let doc = buildSrcdoc(html, f.args, theme);
		// Right after nugram's own script, before any widget code
		if (report) doc = doc.replace('</script>', () => '</script>' + reporterTag);
		return `<div class="bubble"><div class="label">${escapeText(f.label)}</div>`
			+ `<div class="widgetFrame" style="height: ${f.height}px"><iframe sandbox="allow-scripts" srcdoc="${escapeAttr(doc)}"></iframe></div></div>`;
	}).join('\n');
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>widget preview: ${escapeText(name)}</title>
<style>
	body { margin: 0; padding: 16px; color-scheme: light dark; background: #eceae6; color: #222; font: 13px/1.4 system-ui, sans-serif; }
	.bubble { width: ${width}px; background: #fff; border-radius: 10px; padding: 10px; margin-bottom: 16px; }
	@media (prefers-color-scheme: dark) {
		body { background: #1e1f22; color: #ddd; }
		.bubble { background: #2b2d31; }
	}
	.label { font-family: ui-monospace, monospace; font-size: 12px; opacity: 0.7; white-space: pre-wrap; word-break: break-all; }
	.widgetFrame { resize: vertical; overflow: hidden; margin: 6px 0; }
	.widgetFrame iframe { width: 100%; height: 100%; border: none; display: block; }
	#widget-preview-report { width: ${width + 20}px; white-space: pre-wrap; font-size: 12px; }
</style>
</head>
<body>
${frameHtml}
<pre id="widget-preview-report"></pre>
<script>(${host})(${scriptJson(frames.map(f => f.label))})</script>
</body>
</html>
`;
}

// ── Static checks ──

function staticChecks(html, description) {
	const problems = [];
	if (!description) problems.push('no <meta name="description" content="...">: the model gets no documentation for this widget');
	if (!/^\uFEFF?\s*<!doctype html/i.test(html)) problems.push('does not start with <!DOCTYPE html>: renders in quirks mode');
	const urls = [...html.matchAll(/<(?:script|img|link|iframe|source|audio|video|embed)\b[^>]*?\s(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)]
		.map(m => m[1]).filter(url => !/^(?:[a-z][\w+.-]*:|#)/i.test(url));
	if (urls.length) problems.push(`relative or protocol-relative URLs don't load in widgets, inline them or use https://: ${[...new Set(urls)].join(', ')}`);
	if (/\b(?:localStorage|sessionStorage|document\.cookie)\b/.test(html)) problems.push('uses localStorage/sessionStorage/cookies: they throw in the widget sandbox');
	if (/(?<![\w.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/.test(html)) problems.push('calls alert/confirm/prompt: stubbed in nugram (warns, returns undefined/false/null)');
	if (/<form\b/i.test(html)) problems.push('has a <form>: submit events don\'t fire in the sandbox, handle clicks instead');
	if (/\bwindow\.open\s*\(|target\s*=\s*["']?_blank/i.test(html)) problems.push('opens windows or _blank links: blocked in the sandbox');
	return problems;
}

// ── Headless browser ──

function findBrowser(explicit) {
	if (explicit) return explicit;
	const env = process.env;
	if (env.CHROME_PATH) return env.CHROME_PATH;
	const candidates = process.platform === 'win32'
		? [
			[env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'],
			[env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'],
			[env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'],
			[env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'],
			[env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'],
			[env.LOCALAPPDATA, 'Chromium/Application/chrome.exe'],
		].filter(([base]) => base).map(([base, rel]) => join(base, rel))
		: process.platform === 'darwin'
			? ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'].map(app => `/Applications/${app}.app/Contents/MacOS/${app}`)
			: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']
				.flatMap(bin => (env.PATH ?? '').split(delimiter).map(dir => join(dir, bin)));
	return candidates.find(path => existsSync(path));
}

/** Runs the browser headless against the page. Same-process frames keep the frame's timers on
 *  virtual time, and preferredColorScheme pins light/dark regardless of the OS setting. */
function runHeadless(browser, url, extra, dark) {
	const profile = mkdtempSync(join(tmpdir(), 'widget-preview-profile-'));
	try {
		const result = spawnSync(browser, [
			'--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
			`--user-data-dir=${profile}`, '--disable-site-isolation-trials', '--virtual-time-budget=5000',
			`--blink-settings=preferredColorScheme=${dark ? 0 : 1}`, ...extra, url,
		], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
		if (result.error) throw result.error;
		return result;
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
}

// ── CLI ──

const HELP = `Usage: node preview.mjs <widget folder or widget.html> [options]

Frames (repeatable; default: one frame with no args):
  --args '<json>'       args as the show_widget tool passes them
  --tag '<widget .../>' an inline tag as the model writes it; attributes become string args

Options:
  --height <px>         frame height for --args frames (default ${DEFAULT_HEIGHT}); tags use their own height attribute
  --width <px>          message width (default 720)
  --theme '<json>'      theme vars to override in the frame (default: the modern theme stand-in),
                        e.g. --theme '{"--accent1": "#0f0", "--rad": "0px"}'
  --out <file>          where to write the preview page (default: temp dir)
  --no-report           mount exactly as nugram does, without the reporting script
  --run                 load the page in a headless browser and print each frame's report
  --screenshot <png>    save a screenshot of the page
  --dark                with --run/--screenshot: prefers-color-scheme: dark (default light)
  --browser <path>      Chromium-based browser to use (default: $CHROME_PATH, then Edge/Chrome/Chromium)

Exit code: 0 no problems, 1 problems found, 2 usage or browser error.`;

function parseCli(argv) {
	const opts = { frames: [], width: 720, height: DEFAULT_HEIGHT, report: true, run: false, dark: false, theme: PREVIEW_THEME };
	const value = i => {
		if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
		return argv[i + 1];
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--args': {
				const source = value(i++);
				let args;
				try { args = JSON.parse(source); } catch (e) { throw new Error(`--args is not valid JSON: ${e.message}`); }
				if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('--args must be a JSON object');
				opts.frames.push({ kind: 'args', args, source });
				break;
			}
			case '--tag': opts.frames.push({ kind: 'tag', source: value(i++) }); break;
			case '--height': {
				const source = value(i++);
				opts.height = parseWidgetHeight(source);
				if (!opts.height) throw new Error(`--height must be pixels, got ${source}`);
				break;
			}
			case '--theme': {
				const source = value(i++);
				let theme;
				try { theme = JSON.parse(source); } catch (e) { throw new Error(`--theme is not valid JSON: ${e.message}`); }
				if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) throw new Error('--theme must be a JSON object');
				for (const [name, v] of Object.entries(theme))
					if (!name.startsWith('--') || typeof v !== 'string') throw new Error(`--theme: expected a string value for a custom property, got ${name}: ${v}`);
				opts.theme = { ...PREVIEW_THEME, ...theme };
				opts.themeSource = source;
				break;
			}
			case '--width': opts.width = Number(value(i++)); if (!(opts.width > 0)) throw new Error('--width must be a positive number'); break;
			case '--out': opts.out = value(i++); break;
			case '--screenshot': opts.screenshot = value(i++); break;
			case '--browser': opts.browser = value(i++); break;
			case '--no-report': opts.report = false; break;
			case '--run': opts.run = true; break;
			case '--dark': opts.dark = true; break;
			case '-h': case '--help': opts.help = true; break;
			default:
				if (arg.startsWith('-') || opts.target) throw new Error(`unexpected argument ${arg}`);
				opts.target = arg;
		}
	}
	return opts;
}

function locate(target) {
	const path = resolve(target);
	if (!existsSync(path)) throw new Error(`${path} does not exist`);
	if (!statSync(path).isDirectory()) return { name: basename(dirname(path)), file: path };
	const entry = readdirSync(path).find(f => f.toLowerCase() === 'widget.html');
	if (!entry) throw new Error(`no widget.html in ${path}`);
	return { name: basename(path), file: join(path, entry) };
}

function main(argv) {
	const opts = parseCli(argv);
	if (opts.help || !opts.target) {
		console.log(HELP);
		return opts.help ? 0 : 2;
	}
	const { name, file } = locate(opts.target);
	const html = readFileSync(file, 'utf8');
	const description = parseWidgetDescription(html);
	const problems = staticChecks(html, description);

	const specs = opts.frames.length ? opts.frames : [{ kind: 'args', args: {} }];
	const frames = specs.map(spec => {
		if (spec.kind === 'args')
			return { args: spec.args, height: opts.height, label: spec.source ? `show_widget args: ${spec.source}` : 'no args' };
		const tag = tagArgs(spec.source);
		if (!tag.name) problems.push(`tag has no name attribute, so nugram shows it as text: ${spec.source}`);
		else if (tag.name.toLowerCase() !== name.toLowerCase()) problems.push(`tag names "${tag.name}" but this widget is "${name}": ${spec.source}`);
		const height = tag.height === undefined ? undefined : parseWidgetHeight(tag.height);
		if (tag.height !== undefined && height === undefined) problems.push(`tag height "${tag.height}" isn't pixels, nugram falls back to ${DEFAULT_HEIGHT}: ${spec.source}`);
		return { args: tag.args, height: height ?? DEFAULT_HEIGHT, label: `tag: ${spec.source}` };
	});

	const out = resolve(opts.out ?? join(tmpdir(), `widget-preview-${name}.html`));
	writeFileSync(out, previewPage({ name, html, frames, width: opts.width, report: opts.report, theme: opts.theme }));
	const url = pathToFileURL(out).href;

	console.log(`widget ${name}: ${file}`);
	console.log(`\nListed to the model as:\n- ${name}: ${description.replace(/\s+/g, ' ').trim()}`);
	console.log(problems.length ? `\nChecks:\n${problems.map(p => `- ${p}`).join('\n')}` : '\nChecks: no problems found');
	console.log(`Theme: ${opts.themeSource ?? "modern (nugram's default); --theme '<json>' to change it"}`);
	console.log(`\nPreview page: ${url}`);

	if (!opts.run && !opts.screenshot) {
		console.log('\nAdd --run to print what each frame rendered, --screenshot <png> for an image, --dark for dark mode.');
		return problems.length ? 1 : 0;
	}

	const browser = findBrowser(opts.browser);
	if (!browser) {
		console.error('\nNo Chromium-based browser found. Pass --browser <path> or set CHROME_PATH (Chrome, Edge, Chromium and Brave work).');
		return 2;
	}

	let failed = problems.length > 0;
	if (opts.run) {
		const result = runHeadless(browser, url, ['--dump-dom'], opts.dark);
		const match = result.stdout.match(/<pre id="widget-preview-report">([\s\S]*?)<\/pre>/);
		if (!match) {
			console.error(`\nThe browser returned no page. stderr:\n${result.stderr.trim()}`);
			return 2;
		}
		const report = decodeEntities(match[1]);
		console.log(`\nRendered (${opts.dark ? 'dark' : 'light'}):\n${report}`);
		if (/^ {2}(?:problems:$|no report)/m.test(report)) failed = true;
	}
	if (opts.screenshot) {
		const shot = resolve(opts.screenshot);
		rmSync(shot, { force: true });
		const height = 32 + frames.reduce((sum, f) => sum + f.height + 60, 0) + (opts.report ? 400 : 0);
		const result = runHeadless(browser, url, [`--screenshot=${shot}`, `--window-size=${opts.width + 60},${height}`], opts.dark);
		if (!existsSync(shot)) {
			console.error(`\nNo screenshot written. stderr:\n${result.stderr.trim()}`);
			return 2;
		}
		console.log(`\nScreenshot (${opts.dark ? 'dark' : 'light'}): ${shot}`);
	}
	return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (e) {
		console.error(`error: ${e.message}`);
		process.exitCode = 2;
	}
}
