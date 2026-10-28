import { test, expect, describe } from 'bun:test';
import { applyMeta, effectiveTools, emptyDraft, toChatMeta, toolOverridesFor, type ChatState } from '../src/helpers/chatState';

const names = ['a', 'b', 'c'];

const state = (over: Partial<ChatState> = {}): ChatState => ({
	configName: 'Default', model: 'm', provider: 'or', macros: {}, cut: -1, theme: 'modern', background: undefined,
	sendMode: 'loop', autoCompact: false, loreId: 'lore', chatFolder: '', backend: 'local',
	toolApprove: 'off', toolApproveOutside: 'off', toolOverrides: {}, draft: emptyDraft(), ...over,
});

const ctx = (configTools?: Record<string, boolean>) => ({ configName: 'Default', configTools, toolNames: names, defaultSendMode: 'loop' as const });

describe('tool overrides', () => {
	test('no overrides keep the config selection as is', () => {
		expect(effectiveTools(undefined, {}, names)).toBeUndefined();
		expect(effectiveTools({ a: true }, {}, names)).toEqual({ a: true });
	});

	test('overrides apply over a materialized config selection', () => {
		// No config record means every tool is on; a partial override must not turn the rest off
		expect(effectiveTools(undefined, { b: false }, names)).toEqual({ a: true, b: false, c: true });
		expect(effectiveTools({ a: true }, { c: true }, names)).toEqual({ a: true, b: false, c: true });
	});

	test('a legacy full snapshot becomes only its differences', () => {
		expect(toolOverridesFor({ a: true, b: true }, { a: true, b: false, c: true }, names)).toEqual({ b: false, c: true });
		expect(toolOverridesFor(undefined, { a: true }, names)).toEqual({ b: false, c: false });
		expect(toolOverridesFor({ a: true }, { a: true }, names)).toEqual({});
	});
});

describe('applyMeta', () => {
	test('migrates legacy tools against the target config', () => {
		const next = applyMeta(state(), { tools: { a: true } }, ctx({ a: true, b: true }));
		expect(next.toolOverrides).toEqual({ b: false });
	});

	test('keeps tools, cut and draft when absent, resets the rest', () => {
		const draft = { ...emptyDraft(), text: 'hi' };
		const prev = state({ toolOverrides: { a: false }, cut: 3, draft, chatFolder: '/x', toolApprove: 'chat', macros: { k: 'v', agents: 'scanned' } });
		const next = applyMeta(prev, {}, ctx());
		expect(next.toolOverrides).toEqual({ a: false });
		expect(next.cut).toBe(3);
		expect(next.draft).toBe(draft);
		expect(next.chatFolder).toBe('');
		expect(next.toolApprove).toBe('off');
		expect(next.macros).toEqual({ k: 'v' });
	});
});

describe('toChatMeta', () => {
	test('round-trips through applyMeta', () => {
		const s = state({ toolOverrides: { a: false }, chatFolder: '/p', backend: 'ssh:box', autoCompact: true, macros: { k: 'v', widgets: 'w' } });
		const meta = toChatMeta(s);
		expect(meta.macros).toEqual({ k: 'v' });
		expect(meta.tools).toBeUndefined();
		expect(applyMeta(state(), meta, ctx())).toEqual({ ...s, macros: { k: 'v' } });
	});

	test('the draft is stored only when there is one', () => {
		expect(toChatMeta(state()).draft).toBeUndefined();
		expect(toChatMeta(state({ draft: { ...emptyDraft(), images: ['img-1'] } })).draft?.images).toEqual(['img-1']);
	});
});
