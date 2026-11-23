/**
 * Re-running a call of a `rerunnable` tool with edited arguments (session.rerunToolCall).
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';

const kvStore = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => kvStore.get(k) ?? null,
	setItem: (k: string, v: string) => kvStore.set(k, v),
	removeItem: (k: string) => kvStore.delete(k),
	clear: () => kvStore.clear(),
};
(globalThis as any).navigator ??= { platform: 'Win32' };
(globalThis as any).window ??= {};

const { createChatSession } = await import('../src/helpers/session');
const { resolveContent } = await import('../src/helpers/tools');
const { localBackend } = await import('../src/helpers/backend');
import type { ChatMessage, ToolCall } from '../src/helpers/types';

const call = (id: string, name: string, args: object): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

function sessionWith(messages: ChatMessage[]) {
	const session = createChatSession({
		chatId: () => 'rerun',
		model: () => 'm', provider: () => 'or',
		providers: () => ({ or: { url: 'http://test', apiKey: 'key', enabled: true } }),
		options: () => ({ stream: true }),
		activeConfig: () => ({ name: '', prompts: [], tools: {} }),
		promptMessages: () => [],
		cache: () => 'none', cacheLength: () => '5m',
		macros: () => ({}), chatFolder: () => '', cut: () => -1, sendMode: () => 'single',
		lore: [], setLore: () => {},
		requestPermission: async () => true,
		backend: () => localBackend,
		setError: () => null, setInfo: () => null,
	} as any);
	session.load(messages, 0);
	return session;
}

const turn = (calls: ToolCall[], edited = false): ChatMessage => ({
	role: 'assistant', content: [''], currentVersionIndex: 0,
	tool_calls: [calls],
	tool_results: [calls.map(c => ({
		tool_call_id: c.id, name: c.function.name,
		...(edited ? { content: 'edited text' } : { data: { ok: true, value: 0, min: 1, max: 100 } }),
	}))],
});

describe('rerunToolCall', () => {
	test('replaces the call arguments and the result, even over a text edit', async () => {
		const session = sessionWith([turn([call('a', 'random_number', { min: 1, max: 100, outcomes: 'old' })], true)]);
		await session.rerunToolCall(session.messages[0], 0, 0, 'a', { min: 5, max: 5 });

		const msg = session.messages[0];
		expect(msg.tool_calls![0][0].function.arguments).toEqual({ min: 5, max: 5 });
		const result = msg.tool_results![0][0];
		expect(result.content).toBeUndefined();
		expect(result.data).toMatchObject({ ok: true, value: 5, min: 5, max: 5 });
		expect(resolveContent(result)).toBe('Random(5, 5): 5');
	});

	test('a failing rerun records the error', async () => {
		const session = sessionWith([turn([call('a', 'random_number', {})])]);
		await session.rerunToolCall(session.messages[0], 0, 0, 'a', { min: 9, max: 1 });
		expect(session.messages[0].tool_results![0][0].data).toMatchObject({ ok: false });
		expect(session.messages[0].tool_results![0][0].data!.error).toContain('min (9) > max (1)');
	});

	test('leaves other calls and tools that are not rerunnable alone', async () => {
		const session = sessionWith([turn([call('a', 'random_number', { min: 1, max: 2 }), call('b', 'shell', { command: 'echo' })])]);
		const before = JSON.stringify(session.messages[0].tool_results);
		await session.rerunToolCall(session.messages[0], 0, 0, 'b', { command: 'rm -rf x' });
		expect(JSON.stringify(session.messages[0].tool_results)).toBe(before);
		expect(session.messages[0].tool_calls![0][1].function.arguments).toEqual({ command: 'echo' });
		expect(session.toolsRunning()).toBe(false);
	});
});
