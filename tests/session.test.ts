import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../src/helpers/types';

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
const { localBackend } = await import('../src/helpers/backend');

function sessionWith(message: ChatMessage, stream: (...args: any[]) => Promise<any>) {
	const session = createChatSession({
		chatId: () => '',
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
		stream,
	} as any);
	session.load([message], 0);
	return session;
}

const message = (): ChatMessage => ({
	role: 'assistant', content: ['', 'second version'], currentVersionIndex: 0,
	thinking: ['', 'second thinking'], ids: ['', 'second-id'],
});

describe('redoing an older empty version', () => {
	test('preserves later versions while streaming the replacement', async () => {
		const session = sessionWith(message(), async (...args: any[]) => {
			args[9]('replacement');
			args[10]('replacement thinking');
			return { success: true };
		});

		await session.sendMessage(0, false);

		expect(session.messages[0].content).toEqual(['replacement', 'second version']);
		expect(session.messages[0].thinking).toEqual(['replacement thinking', 'second thinking']);
		expect(session.messages[0].ids).toEqual(['', 'second-id']);
		expect(session.messages[0].currentVersionIndex).toBe(0);
	});

	test('restores all versions when the replacement fails', async () => {
		const session = sessionWith(message(), async () => ({ success: false, error: 'network' }));

		await session.sendMessage(0, false);

		expect(session.messages[0].content).toEqual(['', 'second version']);
		expect(session.messages[0].thinking).toEqual(['', 'second thinking']);
		expect(session.messages[0].ids).toEqual(['', 'second-id']);
		expect(session.messages[0].currentVersionIndex).toBe(0);
	});
});
