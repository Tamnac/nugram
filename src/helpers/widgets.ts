/**
 * Widgets: small local HTML apps shown inline in chat, through the `show_widget`
 * tool or a `<widget name="..." />` tag in message text. Design: mds/widgets-mvp.md
 */
import { createSignal } from 'solid-js';
import { localBackend, type Backend } from './backend';
import { isTauri } from './platform';
import { joinPath } from './skills';

export interface Widget {
	name: string;
	description: string;
	/** Full path to `widget.html`. */
	path: string;
}

export const PROJECT_WIDGET_DIRS = ['widgets', '.widgets'];
export const HOME_WIDGET_DIRS = ['.widgets'];

const DEFAULT_HEIGHT = 400;

const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

function decodeEntities(s: string): string {
	return s.replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(amp|quot|apos|lt|gt));/g, (match, dec?: string, hex?: string, named?: string) => {
		if (named) return entities[named]!;
		const code = dec ? parseInt(dec, 10) : parseInt(hex!, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
	});
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Attributes of a single HTML tag, keys lowercased. Bare attributes get ''. */
function parseAttrs(tag: string): Record<string, string> {
	// No prototype, so attributes like `constructor` aren't mistaken for duplicates
	const attrs: Record<string, string> = Object.create(null);
	const body = tag.replace(/^<\/?[a-zA-Z][\w-]*/, '').replace(/\/?>$/, '');
	const re = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const m of body.matchAll(re)) {
		const key = m[1]!.toLowerCase();
		if (!(key in attrs)) attrs[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
	}
	return attrs;
}

export function parseWidgetDescription(html: string): string {
	for (const [tag] of html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
		const attrs = parseAttrs(tag);
		if (attrs.name?.toLowerCase() === 'description') return attrs.content ?? '';
	}
	return '';
}

/** Pixel height from a tool arg or tag attribute: `300`, `"300"` or `"300px"`. */
export function parseWidgetHeight(value: unknown): number | undefined {
	const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	const n = Number(text.match(/^(\d+)(?:\s*px)?$/i)?.[1]);
	return n > 0 ? n : undefined;
}

/** Scan roots for `<root>/<name>/widget.html`. Earlier roots win on name collisions. */
export async function discoverWidgets(roots: string[], backend: Backend): Promise<Widget[]> {
	const perRoot = await Promise.all(roots.map(async root => {
		let entries;
		try {
			entries = await backend.readDir(root);
		} catch {
			return [];
		}
		const found = await Promise.all(entries
			.filter(e => e.isDirectory && !e.name.startsWith('.'))
			.map(async (dir): Promise<Widget | null> => {
				let path = joinPath(root, dir.name);
				try {
					const file = (await backend.readDir(path)).find(e => !e.isDirectory && e.name.toLowerCase() === 'widget.html');
					if (!file) return null;
					path = joinPath(path, file.name);
					const description = parseWidgetDescription(await backend.readText(path));
					if (!description)
						console.warn(`widget ${dir.name}: no <meta name="description" content="..."> in ${path}, so the model gets no documentation for it`);
					return { name: dir.name, description, path };
				} catch (e) {
					console.warn(`widget ${dir.name}: failed to read ${path}:`, e);
					return null;
				}
			}));
		return found.filter(w => w !== null);
	}));

	const byName = new Map<string, Widget>();
	for (const widget of perRoot.flat()) {
		const key = widget.name.toLowerCase();
		if (!byName.has(key)) byName.set(key, widget);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatWidgets(widgets: Widget[]): string {
	if (!widgets.length) return '';
	const list = widgets
		.map(w => `- ${w.name}: ${w.description.replace(/\s+/g, ' ').trim()}`)
		.join('\n');
	return '<widgets>\n'
		+ 'Small HTML apps shown inline in chat. Show one with the show_widget tool when it is among your tools, or by writing '
		+ '<widget name="..." arg="..." /> in a message (every attribute except name and height is passed as a string arg).\n\nAvailable widgets:\n'
		+ `${list}\n</widgets>`;
}

// ── Registry ─────────────────────────────────────────────────────────

const [registry, setRegistry] = createSignal<{ widgets: Widget[]; backend: Backend; scanned: boolean }>({ widgets: [], backend: localBackend, scanned: false });

/** The current scan result. Only replaced when the list changes; read it to re-mount widgets then. */
export const widgetRegistry = registry;

let latest: { roots: string[]; backend: Backend } | undefined;
let scanGen = 0;
let scannedAt = 0;
let pendingRescan: Promise<unknown> | undefined;

/** Scan `roots` and publish the result. A scan started later wins; returns false when this one was superseded. */
export async function scanWidgets(roots: string[], backend: Backend): Promise<boolean> {
	latest = { roots, backend };
	const gen = ++scanGen;
	const widgets = await discoverWidgets(roots, backend);
	if (gen !== scanGen) return false;
	scannedAt = Date.now();
	const prev = registry();
	// An unchanged list keeps the old value so mounted widgets don't reload
	if (!prev.scanned || prev.backend !== backend || JSON.stringify(prev.widgets) !== JSON.stringify(widgets))
		setRegistry({ widgets, backend, scanned: true });
	return true;
}

/** Rescan the most recently requested roots, e.g. because the model just wrote a widget. Concurrent calls share one scan. */
export function rescanWidgets(): Promise<unknown> {
	if (!latest) return Promise.resolve();
	pendingRescan ??= scanWidgets(latest.roots, latest.backend).finally(() => { pendingRescan = undefined; });
	return pendingRescan;
}

export function findWidget(name: string): Widget | undefined {
	const key = name.toLowerCase();
	return registry().widgets.find(w => w.name.toLowerCase() === key);
}

// ── Theme ────────────────────────────────────────────────────────────

/**
 * The theme custom properties copied into widget frames, so a widget matches the chat instead of
 * guessing its own palette. Values are copied as written, `light-dark()` included, so the frame
 * resolves them against the same OS setting the app does.
 */
export const WIDGET_THEME_VARS = [
	'--back', '--back-light', '--text', '--accent1', '--quote', '--italic', '--link', '--link-hover',
	'--border-subtle', '--shadow',
	'--rad-sm', '--rad', '--rad-lg',
	'--font-ui', '--font-message', '--font-monospace', '--line-height-normal', '--letter-spacing',
];

export type WidgetTheme = Record<string, string>;

/** The app's current theme values. themes.css declares them on `body`, so that's where to read them. */
export function widgetTheme(): WidgetTheme {
	const style = getComputedStyle(document.body);
	const theme: WidgetTheme = {};
	for (const name of WIDGET_THEME_VARS) {
		const value = style.getPropertyValue(name).trim();
		if (value) theme[name] = value;
	}
	return theme;
}

// `color-scheme` is part of the injected rule so `light-dark()` values resolve in the frame even for
// a widget that never sets it. The widget's own CSS comes later, so it can override any of this.
const THEME_RULE_PREFIX = ':root{color-scheme:light dark;';

/** The rule injected before the widget's own CSS. */
export function widgetThemeCss(theme: WidgetTheme): string {
	const vars = Object.entries(theme).map(([name, value]) => `${name}:${value}`).join(';');
	return `${THEME_RULE_PREFIX}${vars}}`;
}

const THEME_STYLE_ID = 'nugramTheme';
const THEME_MESSAGE = 'nugram-theme';

const jsonScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The theme as an object (for canvas drawing) plus the host's later theme switches, applied to the
 * injected rule. Switching dispatches `widgettheme` (with the vars as `event.detail`) so drawing
 * code can react; a repeat of the theme it already has is ignored.
 */
const themeScript = (theme: WidgetTheme) => `window.widgetTheme = ${jsonScript(theme)};
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

/**
 * Push the current theme into the frames already on screen, so a theme switch updates the widgets
 * without reloading them. Called from App.tsx after `data-theme` changes.
 */
export function broadcastWidgetTheme(theme: WidgetTheme = widgetTheme()) {
	for (const iframe of document.querySelectorAll<HTMLIFrameElement>('.widgetFrame iframe'))
		iframe.contentWindow?.postMessage({ type: THEME_MESSAGE, vars: theme }, '*');
}

// ── Side panel ───────────────────────────────────────────────────────

export interface WidgetSpec {
	name: string;
	args: Record<string, unknown>;
	height?: number | undefined;
}

const [docked, setDocked] = createSignal<WidgetSpec | null>(null);

/** The widget open in the side panel (`WidgetDock`), if any. One at a time; docking another replaces it. */
export const dockedWidget = docked;
export const dockWidget = (spec: WidgetSpec) => setDocked(spec);
export const undockWidget = () => setDocked(null);

// ── Layout ──────────────────────────────────────────────────────────

/** How widgets sit in a message: `block` breaks the text, `float` sits beside it (inline tags only). */
export type WidgetLayout = 'block' | 'float';

const LAYOUT_KEY = 'widget_layout';

/**
 * Kept as an attribute on `body` that css/messages.css keys on, so a change restyles every widget
 * on screen without remounting any of them.
 */
export function setWidgetLayout(layout: WidgetLayout) {
	document.body.dataset.widgetLayout = layout;
	localStorage.setItem(LAYOUT_KEY, layout);
	for (const slot of document.querySelectorAll<HTMLElement>('.widgetSlot')) placeSlot(slot);
}

/** Where each slot stood in its message's text before `float` moved it to the top. */
const homes = new WeakMap<HTMLElement, Comment>();

/**
 * Beside the text, a widget should run along the whole message rather than start at its tag, so
 * `float` moves slots to the top of the message (in order) and `block` puts them back.
 */
function placeSlot(slot: HTMLElement) {
	const home = homes.get(slot);
	if (document.body.dataset.widgetLayout !== 'float') {
		home?.replaceWith(slot);
		homes.delete(slot);
		return;
	}
	const message = slot.closest('.messageContent');
	if (!message || home) return;
	const marker = document.createComment('widget');
	slot.before(marker);
	homes.set(slot, marker);
	message.insertBefore(slot, [...message.children].find(child => !homes.has(child as HTMLElement)) ?? null);
}

if (typeof document !== 'undefined' && document.body)
	document.body.dataset.widgetLayout = localStorage.getItem(LAYOUT_KEY) === 'float' ? 'float' : 'block';

// ── Rendering ────────────────────────────────────────────────────────

/**
 * Tauri's dialog plugin replaces alert/confirm/prompt in every frame, widget frames included,
 * where its IPC call fails: each call logs an unhandled rejection and confirm() returns a
 * (truthy) Promise. A sandboxed frame can't show dialogs anyway, so make them fail plainly.
 */
const DIALOG_STUBS = "for (const [name, result] of [['alert'], ['confirm', false], ['prompt', null]]) "
	+ "window[name] = () => (console.warn('widget: ' + name + '() is not available in widgets, show messages in the page instead'), result);";

/**
 * The widget's HTML with the theme rule, `window.widgetArgs` and the dialog stubs defined first.
 * Goes after a doctype so it stays in standards mode.
 */
export function buildSrcdoc(html: string, args: Record<string, unknown>, theme: WidgetTheme): string {
	const style = `<style id="${THEME_STYLE_ID}">${widgetThemeCss(theme)}</style>`;
	const script = `<script>window.widgetArgs = ${jsonScript(args)};${themeScript(theme)}${DIALOG_STUBS}</script>`;
	const doctype = html.match(/^\uFEFF?\s*<!doctype[^>]*>/i)?.[0] ?? '';
	return doctype + style + script + html.slice(doctype.length);
}

/**
 * Inline `<widget>` tag → mount point for `mountWidgetSlots`. `null` (no name)
 * leaves the tag to be escaped as text. Args are URI-encoded JSON so the
 * sanitizer's attribute stripping can't touch them.
 */
export function widgetSlotHtml(tagContent: string): string | null {
	if (/^<\//.test(tagContent)) return '';
	const { name, height, ...args } = parseAttrs(tagContent);
	if (!name) return null;
	// Validated at mount, so a bad value warns once the stream ends rather than on every chunk
	const h = height !== undefined ? ` data-height="${escapeHtml(height)}"` : '';
	return `<div class="widgetSlot" data-name="${escapeHtml(name)}" data-args="${encodeURIComponent(JSON.stringify(args))}"${h}></div>`;
}

/** What an element currently shows, so a repeated request for the same thing can be skipped. */
interface Mounted { token: object; key: string; path: string | undefined; behind: boolean }

const mounts = new WeakMap<HTMLElement, Mounted>();

const mountKey = (name: string, args: Record<string, unknown>, height: number | undefined) =>
	`${name}\u0000${JSON.stringify(args)}\u0000${height ?? ''}`;

const LAYOUT_BUTTONS = [
	{ layout: 'block', title: 'In the message, between paragraphs', icon: '<path d="M2 3h12M2 6h12"/><rect x="2" y="9" width="12" height="5" rx="1"/>' },
	{ layout: 'float', title: 'In the message, beside the text', icon: '<path d="M2 3h5M2 6h5M2 9h5M2 12h5"/><rect x="9" y="3" width="5" height="9" rx="1"/>' },
	{ layout: 'dock', title: 'In the side panel', icon: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10 2.5v11"/>' },
] as const;

/** The three places a widget can be. The first two are a state of the page (`widgetLayout`), the side panel is per widget. */
function layoutButtons(spec: WidgetSpec): HTMLElement {
	const bar = document.createElement('div');
	bar.className = 'widgetLayoutBtns';
	for (const { layout, title, icon } of LAYOUT_BUTTONS) {
		const button = document.createElement('button');
		button.dataset.layout = layout;
		button.title = title;
		button.ariaLabel = title;
		button.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">${icon}</svg>`;
		button.addEventListener('click', () => layout === 'dock' ? dockWidget(spec) : setWidgetLayout(layout));
		bar.append(button);
	}
	return bar;
}

/** What stands in for a widget that is open in the side panel. */
function dockedNote(name: string): HTMLElement {
	const el = note(`widget ${name} is open in the side panel`);
	const button = document.createElement('button');
	button.className = 'widgetNoteBtn';
	button.textContent = 'Show here';
	button.addEventListener('click', undockWidget);
	el.append(' ', button);
	return el;
}

function note(text: string): HTMLElement {
	const el = document.createElement('div');
	el.className = 'widgetNote';
	el.textContent = text;
	return el;
}

/** A miss right after a scan isn't worth another one. */
const MISS_RESCAN_AFTER_MS = 2000;

/**
 * With `fill` the frame takes all of `el` (the side panel). A widget open in the side panel is
 * replaced elsewhere by a note, so it never runs twice.
 *
 * Replace `el`'s children with the widget in a sandboxed iframe, or a note when it can't be shown.
 * The file is read on every mount, so edits show up the next time the widget is shown.
 * A repeat of what `el` already shows is ignored, so effects that re-run for unrelated reasons
 * (a stream starting or ending anywhere in the chat) don't reload the iframe. Nothing shown
 * (no scan yet, unknown name) is always retried, since that's when a rescan can help.
 */
export function mountWidget(el: HTMLElement, name: string, args: Record<string, unknown>, height?: number, fill = false) {
	const key = mountKey(name, args, height);
	const open = docked();
	const behind = !fill && !!open && mountKey(open.name, open.args, open.height) === key;
	const mounted = mounts.get(el);
	if (mounted?.key === key && mounted.behind === behind && mounted.path !== undefined && mounted.path === findWidget(name)?.path) return;
	return mount({ el, name, args, key, height, fill, behind }, true);
}

interface MountRequest { el: HTMLElement; name: string; args: Record<string, unknown>; key: string; height: number | undefined; fill: boolean; behind: boolean }

async function mount(request: MountRequest, mayRescan: boolean) {
	const { el, name, args, key, height, fill, behind } = request;
	const token = {};
	mounts.set(el, { token, key, path: findWidget(name)?.path, behind });
	el.replaceChildren();
	if (behind) {
		el.append(dockedNote(name));
		return;
	}

	if (!isTauri) {
		el.append(note(`widget ${name}: widgets need the desktop app`));
		return;
	}
	// Callers re-mount when the registry changes, so the first scan fills this in
	if (!registry().scanned) return;

	const widget = findWidget(name);
	if (!widget) {
		if (mayRescan && Date.now() - scannedAt > MISS_RESCAN_AFTER_MS) {
			await rescanWidgets();
			if (mounts.get(el)?.token === token) void mount(request, false);
			return;
		}
		const available = registry().widgets.map(w => w.name).join(', ') || 'none';
		console.warn(`widget ${name} not found. Available: ${available}`);
		el.append(note(`widget ${name} not found`));
		return;
	}

	let html: string;
	try {
		html = await registry().backend.readText(widget.path);
	} catch (e: any) {
		console.warn(`widget ${name}: failed to read ${widget.path}:`, e);
		if (mounts.get(el)?.token === token) el.append(note(`widget ${name}: ${e?.message ?? e}`));
		return;
	}
	if (mounts.get(el)?.token !== token) return;

	const frame = document.createElement('div');
	frame.className = fill ? 'widgetFrame fill' : 'widgetFrame';
	if (!fill) frame.style.height = `${height ?? DEFAULT_HEIGHT}px`;
	const iframe = document.createElement('iframe');
	// No allow-same-origin: that would make the widget same-origin with the app and its Tauri IPC.
	iframe.setAttribute('sandbox', 'allow-scripts');
	iframe.srcdoc = buildSrcdoc(html, args, widgetTheme());
	// A theme switch can land while the frame is still loading (and a widget can reload itself),
	// so send it once the frame is up too
	iframe.addEventListener('load', () => iframe.contentWindow?.postMessage({ type: THEME_MESSAGE, vars: widgetTheme() }, '*'));
	frame.append(iframe);
	if (!fill) frame.append(layoutButtons({ name, args, height }));
	el.append(frame);
}

/** Mount every `.widgetSlot` (from `widgetSlotHtml`) under `container`. */
export function mountWidgetSlots(container: HTMLElement) {
	for (const slot of container.querySelectorAll<HTMLElement>('.widgetSlot')) {
		const name = slot.dataset.name ?? '';
		let args: Record<string, unknown> = {};
		try {
			args = JSON.parse(decodeURIComponent(slot.dataset.args ?? ''));
		} catch (e) {
			console.warn(`widget ${name}: malformed args, mounting without them:`, e);
		}
		const rawHeight = slot.dataset.height;
		const height = parseWidgetHeight(rawHeight);
		if (rawHeight !== undefined && height === undefined)
			console.warn(`widget ${name}: ignoring height "${rawHeight}", expected pixels like 300 or 300px`);
		placeSlot(slot);
		void mountWidget(slot, name, args, height);
	}
}
