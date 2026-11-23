/**
 * Widgets: small local HTML apps shown inline in chat, through the `show_widget`
 * tool or a `<widget name="..." />` tag in message text. Design: mds/widgets-mvp.md
 */
import { createContext, createSignal } from 'solid-js';
import { localBackend, type Backend } from './backend';
import { isTauri } from './platform';
import { joinPath } from './skills';
import { loadWidgetState, resetWidgetState, saveWidgetState } from './widgetState';
import type { ChatMessage, ToolResult } from './types';

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

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

/** Scan roots for `<root>/<name>/widget.html`. If two roots have a widget with the same name, the earlier root's is used. */
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
		+ '<widget name="..." arg="..." /> in a message (every attribute except name, height, id, inherit and state is passed as a string arg). '
		+ 'A widget keeps the state it saves only when it has an id (id="..." on the tag; show_widget returns one).\n\nAvailable widgets:\n'
		+ `${list}\n</widgets>`;
}

// ── Registry ─────────────────────────────────────────────────────────

const [registry, setRegistry] = createSignal<{ widgets: Widget[]; backend: Backend; scanned: boolean }>({ widgets: [], backend: localBackend, scanned: false });

/** The current scan result. It is only replaced when the list changes, so effects that read it re-mount widgets only then. */
export const widgetRegistry = registry;

let latest: { roots: string[]; backend: Backend } | undefined;
let scanGen = 0;
let scannedAt = 0;
let pendingRescan: Promise<unknown> | undefined;

/** Scan `roots` and publish the result. If a later scan starts before this one finishes, its result is used and this returns false. */
export async function scanWidgets(roots: string[], backend: Backend): Promise<boolean> {
	latest = { roots, backend };
	const gen = ++scanGen;
	const widgets = await discoverWidgets(roots, backend);
	if (gen !== scanGen) return false;
	scannedAt = Date.now();
	const prev = registry();
	// Keep the old value if the list is unchanged, so mounted widgets don't reload
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
 * The theme custom properties copied into widget frames, so a widget can use the chat's colors and
 * fonts instead of defining its own. Values are copied as written, `light-dark()` included, so the frame
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
 * Script that sets `window.widgetTheme` (for canvas drawing) and applies later theme switches from
 * the host to the injected rule. Each switch dispatches `widgettheme` (with the vars as `event.detail`)
 * so drawing code can react; a message with the theme the frame already has is ignored.
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
 * Send the current theme to the mounted widget frames, so a theme switch updates the widgets
 * without reloading them. Called from App.tsx after `data-theme` changes.
 */
export function broadcastWidgetTheme(theme: WidgetTheme = widgetTheme()) {
	for (const iframe of document.querySelectorAll<HTMLIFrameElement>('.widgetFrame iframe'))
		iframe.contentWindow?.postMessage({ type: THEME_MESSAGE, vars: theme }, '*');
}

// ── Instances ────────────────────────────────────────────────────────

/** The chat a mounted widget belongs to, as far as the widget can reach it. */
export interface WidgetHost {
	chatId: string;
	/** Adds a user message to the chat (see `formatWidgetMessage`); throws when it is refused. `label` is the instance id, or the name for a widget without one. */
	send(label: string, text: string, respond: boolean): void;
	/** Scrolls the chat to the widget with this instance id, if it is in the chat. */
	reveal(id: string): void;
}

/** Provided by `ChatView`, read by the components that mount widgets. */
export const WidgetHostContext = createContext<WidgetHost>();

/**
 * What it takes to show one widget. With an `id`, the widget has state that survives reloads;
 * `inherit` names an instance whose state this one starts from (unless `state` is `fresh`).
 */
export interface WidgetSpec {
	name: string;
	args: Record<string, unknown>;
	height?: number | undefined;
	id?: string | undefined;
	inherit?: string | undefined;
	state?: 'copy' | 'fresh' | undefined;
	host?: WidgetHost | undefined;
}

const MESSAGE_TAG = 'widget_message';

/** The text of a message a widget sent. The model sees it as user content with this label. */
export function formatWidgetMessage(label: string, text: string): string {
	return `<${MESSAGE_TAG} id="${escapeHtml(label)}">${text.replace(/<(?=\/widget_message)/gi, '&lt;')}</${MESSAGE_TAG}>`;
}

const WIDGET_MESSAGE_RE = new RegExp(`^<${MESSAGE_TAG} id="([^"]*)">([\\s\\S]*)</${MESSAGE_TAG}>$`);

/** The label and text of a message made by `formatWidgetMessage`, or null for any other text. */
export function parseWidgetMessage(content: string): { label: string; text: string } | null {
	const m = content.match(WIDGET_MESSAGE_RE);
	return m ? { label: decodeEntities(m[1]!), text: m[2]!.replace(/&lt;(?=\/widget_message)/gi, '<') } : null;
}

/**
 * Instance ids in use anywhere in the chat: every version of every message, ids of earlier
 * `show_widget` results (also those nested in run_js logs) and ids on inline tags. A regenerated
 * reply must not get an id of a version it replaces, or it would inherit that version's state.
 */
export function usedWidgetIds(messages: ChatMessage[]): Set<string> {
	const used = new Set<string>();
	for (const message of messages) {
		for (const content of message.content) addTagIds(content, used);
		for (const results of message.tool_results ?? []) addResultIds(results, used);
	}
	return used;
}

function addTagIds(content: string, ids: Set<string>) {
	for (const [tag] of content.matchAll(/<widget\b[^>]*>/gi)) {
		const { id } = parseAttrs(tag);
		if (id) ids.add(id);
	}
}

function addResultIds(results: ToolResult[], ids: Set<string>) {
	const fromResult = (name: string | undefined, data: Record<string, any> | undefined) => {
		if (name === 'show_widget' && typeof data?.id === 'string') ids.add(data.id);
		if (Array.isArray(data?.log))
			for (const entry of data.log) fromResult(entry?.call?.function?.name, entry?.result?.data);
	};
	for (const result of results) fromResult(result.name, result.data);
}

/** Index of the message whose shown version holds the widget with this instance id, or -1. */
export function findWidgetMessage(messages: ChatMessage[], id: string): number {
	return messages.findIndex(message => {
		const version = message.currentVersionIndex ?? 0;
		const ids = new Set<string>();
		addTagIds(message.content[version] ?? '', ids);
		addResultIds(message.tool_results?.[version] ?? [], ids);
		return ids.has(id);
	});
}

/** `<name lowercased>-<n>` for the smallest n from 1 that isn't in `used`. */
export function generateWidgetId(name: string, used: ReadonlySet<string>): string {
	const base = name.toLowerCase();
	let n = 1;
	while (used.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

// ── Side panel ───────────────────────────────────────────────────────

const [docked, setDocked] = createSignal<WidgetSpec | null>(null);

/** The widget open in the side panel (`WidgetDock`), if any. One at a time; docking another replaces it. */
export const dockedWidget = docked;
export const dockWidget = (spec: WidgetSpec) => setDocked(spec);
export const undockWidget = () => setDocked(null);

// ── Layout ──────────────────────────────────────────────────────────

/** How widgets are placed in a message: `block` between paragraphs, `float` beside the text (inline tags only). */
export type WidgetLayout = 'block' | 'float';

const LAYOUT_KEY = 'widget_layout';

/**
 * Stored as an attribute on `body` that css/messages.css selects on, so a change restyles every
 * widget on screen without remounting any of them.
 */
export function setWidgetLayout(layout: WidgetLayout) {
	document.body.dataset.widgetLayout = layout;
	localStorage.setItem(LAYOUT_KEY, layout);
	for (const slot of document.querySelectorAll<HTMLElement>('.widgetSlot')) placeSlot(slot);
}

/** Comment markers at each slot's original position in the message, from before `float` moved it to the top. */
const homes = new WeakMap<HTMLElement, Comment>();

/**
 * Beside the text, a widget should start at the top of the message rather than at its tag, so
 * `float` moves slots to the top of the message (in order) and `block` moves them back.
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
 * (truthy) Promise. A sandboxed frame can't show dialogs anyway, so replace them with stubs that
 * log a warning and return a falsy result.
 */
const DIALOG_STUBS = "for (const [name, result] of [['alert'], ['confirm', false], ['prompt', null]]) "
	+ "window[name] = () => (console.warn('widget: ' + name + '() is not available in widgets, show messages in the page instead'), result);";

const REQUEST_MESSAGE = 'nugram-widget';
const REPLY_MESSAGE = 'nugram-widget-reply';

/** What the frame knows about its instance when it loads. `state` is JSON text. */
export interface WidgetInstance { id: string | null; state: string | null }

/**
 * Script that defines `widgetId`, `widgetState`, `widgetSave` and `widgetSend`. The last two ask the
 * host (`handleFrameRequest`) and resolve or reject with its reply.
 */
const instanceScript = (instance: WidgetInstance) => `window.widgetId = ${jsonScript(instance.id)};
window.widgetState = ${(instance.state ?? 'null').replace(/</g, '\\u003c')};
(() => {
	const pending = new Map();
	let last = 0;
	const request = (op, body) => new Promise((resolve, reject) => {
		const id = ++last;
		pending.set(id, { resolve, reject });
		window.parent.postMessage({ type: '${REQUEST_MESSAGE}', id, op, ...body }, '*');
	});
	addEventListener('message', event => {
		const reply = event.data;
		if (event.source !== window.parent || !reply || reply.type !== '${REPLY_MESSAGE}') return;
		const entry = pending.get(reply.id);
		if (!entry) return;
		pending.delete(reply.id);
		if (reply.ok) entry.resolve(); else entry.reject(new Error(reply.error));
	});
	window.widgetSave = state => {
		let json;
		try { json = JSON.stringify(state); } catch (e) { return Promise.reject(e); }
		if (json === undefined) return Promise.reject(new Error('widgetSave: the state is not JSON-serializable'));
		return request('save', { json });
	};
	window.widgetSend = (text, options) => request('send', { text: String(text), respond: !!(options && options.respond) });
})();`;

/**
 * The widget's HTML with the theme rule, `window.widgetArgs`, the instance API and the dialog stubs
 * defined first. Inserted after the doctype, if any, so the page stays in standards mode.
 */
export function buildSrcdoc(html: string, args: Record<string, unknown>, theme: WidgetTheme, instance: WidgetInstance = { id: null, state: null }): string {
	const style = `<style id="${THEME_STYLE_ID}">${widgetThemeCss(theme)}</style>`;
	const script = `<script>window.widgetArgs = ${jsonScript(args)};${themeScript(theme)}${DIALOG_STUBS}${instanceScript(instance)}</script>`;
	const doctype = html.match(/^\uFEFF?\s*<!doctype[^>]*>/i)?.[0] ?? '';
	return doctype + style + script + html.slice(doctype.length);
}

/**
 * Converts an inline `<widget>` tag into a mount point for `mountWidgetSlots`.
 * Returns `null` (no name) to leave the tag escaped as text, and '' for a
 * closing tag. Args are URI-encoded JSON so the sanitizer's attribute
 * stripping can't change them. `id`, `inherit` and `state` are not args.
 */
export function widgetSlotHtml(tagContent: string): string | null {
	if (/^<\//.test(tagContent)) return '';
	const { name, height, id, inherit, state, ...args } = parseAttrs(tagContent);
	if (!name) return null;
	// Validated at mount, so an invalid value logs one warning after the stream ends instead of one per chunk
	const optional = (key: string, value: string | undefined) => value ? ` data-${key}="${escapeHtml(value)}"` : '';
	return `<div class="widgetSlot" data-name="${escapeHtml(name)}" data-args="${encodeURIComponent(JSON.stringify(args))}"`
		+ `${optional('height', height)}${optional('id', id)}${optional('inherit', inherit)}${optional('state', state)}></div>`;
}

/** What an element currently shows, so a repeated request for the same thing can be skipped. */
interface Mounted { token: object; key: string; path: string | undefined; behind: boolean }

const mounts = new WeakMap<HTMLElement, Mounted>();

const mountKey = (spec: WidgetSpec) =>
	[spec.name, JSON.stringify(spec.args), spec.height ?? '', spec.id ?? '', spec.inherit ?? '', spec.state ?? ''].join('\u0000');

const LAYOUT_BUTTONS = [
	{ layout: 'block', title: 'In the message, between paragraphs', icon: '<path d="M2 3h12M2 6h12"/><rect x="2" y="9" width="12" height="5" rx="1"/>' },
	{ layout: 'float', title: 'In the message, beside the text', icon: '<path d="M2 3h5M2 6h5M2 9h5M2 12h5"/><rect x="9" y="3" width="5" height="9" rx="1"/>' },
	{ layout: 'dock', title: 'In the side panel', icon: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10 2.5v11"/>' },
] as const;

const RESET_BUTTON = { title: "Reset: clear the widget's saved state and reload it", icon: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3"/>' };

/**
 * Buttons for the three widget placements, and a reset button when `reset` is given. The first two
 * placements set the page-wide layout (`setWidgetLayout`); the side panel is per widget.
 */
function layoutButtons(spec: WidgetSpec, reset: (() => void) | undefined): HTMLElement {
	const bar = document.createElement('div');
	bar.className = 'widgetLayoutBtns';
	const add = (title: string, icon: string, onClick: () => void, layout?: string) => {
		const button = document.createElement('button');
		if (layout) button.dataset.layout = layout;
		button.title = title;
		button.ariaLabel = title;
		button.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">${icon}</svg>`;
		button.addEventListener('click', onClick);
		bar.append(button);
	};
	if (reset) add(RESET_BUTTON.title, RESET_BUTTON.icon, reset);
	for (const { layout, title, icon } of LAYOUT_BUTTONS)
		add(title, icon, () => layout === 'dock' ? dockWidget(spec) : setWidgetLayout(layout), layout);
	return bar;
}

/** Note shown in place of a widget that is open in the side panel. */
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

// ── Frame requests ───────────────────────────────────────────────────────

/** What the host knows about a mounted frame. Requests are matched to it by `event.source`, never by anything the frame says about itself. */
interface FrameInfo { host: WidgetHost | undefined; id: string | undefined; label: string }

const frames = new WeakMap<object, FrameInfo>();
let listening = false;

/** Handles a `widgetSave` or `widgetSend` request; throws to reject it. */
function handleFrameRequest(frame: FrameInfo, request: { op: string; json?: unknown; text?: unknown; respond?: unknown }) {
	if (request.op === 'save') {
		if (!frame.host || !frame.id) throw new Error('widgetSave: this widget has no id, so it has no saved state. Show it with an id (show_widget `id`, or id="..." on the tag)');
		saveWidgetState(frame.host.chatId, frame.id, String(request.json));
	} else {
		if (!frame.host) throw new Error('widgetSend: this widget is not in a chat');
		frame.host.send(frame.label, String(request.text), request.respond === true);
	}
}

function listenForFrames() {
	if (listening) return;
	listening = true;
	window.addEventListener('message', event => {
		const frame = event.source ? frames.get(event.source) : undefined;
		const request = event.data;
		if (!frame || !request || request.type !== REQUEST_MESSAGE || (request.op !== 'save' && request.op !== 'send')) return;
		let reply: { ok: boolean; error?: string };
		try {
			handleFrameRequest(frame, request);
			reply = { ok: true };
		} catch (e: any) {
			reply = { ok: false, error: e?.message ?? String(e) };
		}
		(event.source as Window).postMessage({ type: REPLY_MESSAGE, id: request.id, ...reply }, '*');
	});
}

// ── Mounting ──────────────────────────────────────────────────────────

/** An unknown widget name triggers a rescan only if the last scan is older than this. */
const MISS_RESCAN_AFTER_MS = 2000;

/**
 * Replace `el`'s children with the widget in a sandboxed iframe, or a note when it can't be shown.
 * The file is read on every mount, so edits show up the next time the widget is shown.
 * A repeat of what `el` already shows is ignored, so effects that re-run for unrelated reasons
 * (a stream starting or ending anywhere in the chat) don't reload the iframe. If the last mount
 * showed nothing (no scan yet, unknown name), it is always retried, since a rescan may find it.
 *
 * With `fill` the frame fills `el` (the side panel). A widget open in the side panel is
 * replaced elsewhere by a note, so it never runs twice.
 */
export function mountWidget(el: HTMLElement, spec: WidgetSpec, fill = false) {
	const key = mountKey(spec);
	const open = docked();
	const behind = !fill && !!open && mountKey(open) === key;
	const mounted = mounts.get(el);
	if (mounted?.key === key && mounted.behind === behind && mounted.path !== undefined && mounted.path === findWidget(spec.name)?.path) return;
	return mount({ el, spec, key, fill, behind }, true);
}

interface MountRequest { el: HTMLElement; spec: WidgetSpec; key: string; fill: boolean; behind: boolean }

async function mount(request: MountRequest, mayRescan: boolean) {
	const { el, spec, key, fill, behind } = request;
	const { name, args, height, id, inherit, state, host } = spec;
	const token = {};
	mounts.set(el, { token, key, path: findWidget(name)?.path, behind });
	if (id) el.dataset.widgetId = id;
	else delete el.dataset.widgetId;
	el.replaceChildren();
	if (behind) {
		el.append(dockedNote(name));
		return;
	}

	if (!isTauri) {
		el.append(note(`widget ${name}: widgets need the desktop app`));
		return;
	}
	// Callers re-mount when the registry changes, so `el` is filled after the first scan
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
	let savedState: string | null;
	try {
		[html, savedState] = await Promise.all([
			registry().backend.readText(widget.path),
			id && host ? loadWidgetState(host.chatId, id, inherit, state) : null,
		]);
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
	iframe.srcdoc = buildSrcdoc(html, args, widgetTheme(), { id: id ?? null, state: savedState });
	// A theme switch can happen while the frame is still loading (and a widget can reload itself),
	// so send it once the frame is up too
	iframe.addEventListener('load', () => iframe.contentWindow?.postMessage({ type: THEME_MESSAGE, vars: widgetTheme() }, '*'));
	frame.append(iframe);
	const reset = id && host
		? () => {
			resetWidgetState(host.chatId, id);
			void mount(request, false);
		}
		: undefined;
	if (!fill) frame.append(layoutButtons(spec, reset));
	el.append(frame);
	// The iframe has a window once it is in the document
	if (iframe.contentWindow) {
		listenForFrames();
		frames.set(iframe.contentWindow, { host, id, label: id ?? name });
	}
}

/** Mount every `.widgetSlot` (from `widgetSlotHtml`) under `container`. */
export function mountWidgetSlots(container: HTMLElement, host?: WidgetHost) {
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
		void mountWidget(slot, {
			name, args, height, host,
			id: slot.dataset.id,
			inherit: slot.dataset.inherit,
			state: slot.dataset.state === 'fresh' ? 'fresh' : 'copy',
		});
	}
}
