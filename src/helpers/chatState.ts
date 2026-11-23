import { DERIVED_MACROS } from './Extras';
import { normalizeTheme } from './types';
import type { BackgroundSettings, ChatDraft, ChatMeta, Fold, Provider, ToolApprove } from './types';

/**
 * Everything that belongs to one chat rather than to the app: the live form of
 * `ChatMeta` plus the unsent draft. Kept in a Solid store and written with path setters,
 * which can change object-valued fields (macros, background, toolOverrides, draft) in
 * place, so compare and copy those by value, not by reference. Plan: mds/live-chats.md
 */
export interface ChatState {
	configName: string;
	model: string;
	provider: Provider;
	/** Hand-written macros plus the ones scanned from the environment (`DERIVED_MACROS`, not persisted). */
	macros: Record<string, string>;
	cut: number;
	folds: Fold[];
	theme: string;
	background: BackgroundSettings | undefined;
	sendMode: 'loop' | 'single';
	autoCompact: boolean;
	loreId: string;
	chatFolder: string;
	/** 'local' or an SshBackendConfig id. */
	backend: string;
	toolApprove: ToolApprove;
	toolApproveOutside: ToolApprove;
	/** Tool selection on top of the config's: only the tools this chat sets differently. */
	toolOverrides: Record<string, boolean>;
	draft: ChatDraft;
}

export const emptyDraft = (): ChatDraft => ({ text: '', images: [], files: [], role: 'user' });

const isEmptyDraft = (d: ChatDraft) => !d.text && !d.images.length && !d.files.length && d.role === 'user';

/** Whether `selection` enables tool `name`: an undefined selection enables every tool, otherwise only `true` entries are enabled. */
export const toolEnabled = (selection: Record<string, boolean> | undefined, name: string) => !selection || selection[name] === true;

/** The chat's tool selection: the config's, with the chat's overrides applied. */
export function effectiveTools(base: Record<string, boolean> | undefined, overrides: Record<string, boolean>, names: string[]): Record<string, boolean> | undefined {
	if (!Object.keys(overrides).length) return base;
	return { ...Object.fromEntries(names.map(n => [n, toolEnabled(base, n)])), ...overrides };
}

/** Overrides that turn `base` into `selection`. Migrates the full snapshots older chats stored as `ChatMeta.tools`. */
export function toolOverridesFor(base: Record<string, boolean> | undefined, selection: Record<string, boolean>, names: string[]): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const n of names) {
		const on = toolEnabled(selection, n);
		if (on !== toolEnabled(base, n)) out[n] = on;
	}
	return out;
}

export const userMacros = (macros: Record<string, string>) =>
	Object.fromEntries(Object.entries(macros).filter(([k]) => !DERIVED_MACROS.includes(k)));

/** The persisted form. Copies every field, so calling it inside an effect tracks them all. */
export function toChatMeta(s: ChatState, imageFolder?: string): ChatMeta {
	const meta: ChatMeta = {
		macros: userMacros(s.macros),
		configName: s.configName,
		cut: s.cut,
		theme: s.theme,
		model: s.model,
		provider: s.provider,
		sendMode: s.sendMode,
		loreId: s.loreId,
		// Written even when empty, because applyMeta treats a missing toolOverrides as "keep the current overrides"
		toolOverrides: { ...s.toolOverrides },
	};
	if (s.folds.length) meta.folds = s.folds.map(f => ({ ...f }));
	if (s.chatFolder) meta.chatFolder = s.chatFolder;
	if (imageFolder) meta.imageFolder = imageFolder;
	if (s.background) meta.background = { ...s.background };
	if (s.autoCompact) meta.autoCompact = true;
	if (s.toolApprove !== 'off') meta.toolApprove = s.toolApprove;
	if (s.toolApproveOutside !== 'off') meta.toolApproveOutside = s.toolApproveOutside;
	if (s.backend !== 'local') meta.backend = s.backend;
	const d = s.draft;
	if (!isEmptyDraft(d)) meta.draft = { ...d, images: [...d.images], files: d.files.map(f => ({ ...f })) };
	return meta;
}

/**
 * The state after applying (possibly partial) meta over `prev`. Config, macros, cut, folds,
 * theme, model, provider, tools and draft keep their previous value when absent;
 * the rest fall back to defaults. Derived macros are dropped, to be re-scanned.
 */
export function applyMeta(prev: ChatState, meta: Partial<ChatMeta>, ctx: {
	/** Resolved by the caller: `meta.configName` when that config exists, else the current one. */
	configName: string;
	configTools: Record<string, boolean> | undefined;
	toolNames: string[];
	defaultSendMode: 'loop' | 'single';
}): ChatState {
	return {
		configName: ctx.configName,
		model: meta.model ?? prev.model,
		provider: meta.provider ?? prev.provider,
		macros: userMacros(meta.macros ?? prev.macros),
		cut: meta.cut ?? prev.cut,
		folds: meta.folds ?? prev.folds,
		theme: meta.theme !== undefined ? normalizeTheme(meta.theme) : prev.theme,
		background: meta.background,
		sendMode: meta.sendMode ?? ctx.defaultSendMode,
		autoCompact: meta.autoCompact ?? false,
		loreId: meta.loreId || crypto.randomUUID().slice(0, 8),
		chatFolder: meta.chatFolder || '',
		backend: meta.backend || 'local',
		toolApprove: meta.toolApprove || 'off',
		toolApproveOutside: meta.toolApproveOutside || 'off',
		toolOverrides: meta.tools !== undefined
			? toolOverridesFor(ctx.configTools, meta.tools, ctx.toolNames)
			: meta.toolOverrides ?? prev.toolOverrides,
		draft: meta.draft ?? prev.draft,
	};
}
