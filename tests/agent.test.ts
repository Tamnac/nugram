/**
 * Tests for the sub-agent runner (src/helpers/agent.ts).
 *
 * Runs the real session + tool loop headlessly against bun:sqlite in-memory,
 * with a fake stream injected via the SessionEnv.stream override.
 *
 * Run: bun test
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';

// ── Environment stubs ────────────────────────────────────────────
// Must be installed before importing app modules: `isTauri` is evaluated at
// import time, and we want the session's persistence to hit the SQLite path.

const kvStore = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => kvStore.get(k) ?? null,
	setItem: (k: string, v: string) => kvStore.set(k, v),
	removeItem: (k: string) => kvStore.delete(k),
	clear: () => kvStore.clear(),
};
(globalThis as any).window = {
	__TAURI_INTERNALS__: { invoke: async () => null, transformCallback: (cb: any) => cb },
};
(globalThis as any).document = { querySelector: () => null, hidden: false };

const { _initForTesting, listChats, loadChatMessages, saveChatMessages, createChat, CORE_SCHEMA } = await import('../src/helpers/db');
const { resolveAgentModel, runAgentTask, abortAgentsFor } = await import('../src/helpers/agent');
const { updateSpawnAgentTool, tools, resolveContent } = await import('../src/helpers/tools');
const { getMessageContent } = await import('../src/helpers/messages');
const typesModule = await import('../src/helpers/types');
type AgentSettings = import('../src/helpers/types').AgentSettings;

// ── Schema + adapter (mirrors tests/db.test.ts) ───────────────────────

const SCHEMA = CORE_SCHEMA.join(';') + ';';

function convertParams(query: string): string {
	return query.replace(/\$(\d+)/g, '?$1');
}

function createAdapter(sqlite: BunDatabase) {
	return {
		execute: async (query: string, params?: any[]) => {
			const q = convertParams(query);
			const stmt = sqlite.prepare(q);
			if (params?.length) stmt.run(...params);
			else stmt.run();
			const lastId = (sqlite.prepare('SELECT last_insert_rowid() AS id').get() as any).id;
			const changes = (sqlite.prepare('SELECT changes() AS c').get() as any).c;
			return { rowsAffected: Number(changes), lastInsertId: Number(lastId) };
		},
		select: async (query: string, params?: any[]) => {
			const q = convertParams(query);
			const stmt = sqlite.prepare(q);
			return (params?.length ? stmt.all(...params) : stmt.all()) as any[];
		},
	};
}

// ── Fixtures ────────────────────────────────────────────────────────

const settings: AgentSettings = {
	models: {
		lite: { model: 'small-model', provider: 'nano' },
		medium: { model: '', provider: 'or' },
		ultra: { model: 'big-model', provider: 'or' },
	},
	presets: [
		{ name: 'reviewer', description: 'reviews code', model: 'ultra', prompt: 'You review.' },
		{ name: 'searcher', description: '', model: 'x/explicit', provider: 'zai', prompt: '', tools: { fetch_url: true } },
	],
};

const parent = { model: 'parent-model', provider: 'or' };

/** A fake streamChatCompletion driven by a per-turn behavior function. */
function fakeStream(onTurn: (turn: number, onContent?: (s: string) => void, signal?: AbortSignal) => Promise<any> | any) {
	let turn = 0;
	return async (_model: string, _msgs: any[], _opts: any, _key: string, _site: string, signal: AbortSignal,
		_provider: string, _url: any, onContent?: (s: string) => void) => {
		turn++;
		return onTurn(turn, onContent, signal);
	};
}

const toolCallTurn = (turn: number) => ({
	success: true,
	toolCalls: [{ id: `tc_${turn}`, type: 'function', function: { name: 'random_number', arguments: { min: 1, max: 1 } } }],
});

function makeParentEnv(stream: any) {
	return {
		chatId: () => 'parent-chat',
		model: () => parent.model,
		provider: () => parent.provider,
		providers: () => ({ or: { url: 'http://test', apiKey: 'key', enabled: true } }),
		options: () => ({ stream: true }),
		activeConfig: () => ({ name: '', prompts: [], tools: { random_number: true, spawn_agent: true } }),
		promptMessages: () => [],
		cache: () => 'none' as const,
		cacheLength: () => '5m' as const,
		macros: () => ({}),
		chatFolder: () => '',
		cut: () => -1,
		sendMode: () => 'loop' as const,
		lore: [],
		setLore: () => {},
		requestPermission: async () => true as const,
		shellSession: 'main',
		setError: () => null,
		setInfo: () => null,
		stream,
	} as any;
}

const noParentSession = { messages: [], flush: async () => {} } as any;

function spawn(args: any, stream: any, extra?: Partial<Parameters<typeof runAgentTask>[0]>) {
	return runAgentTask({
		args,
		parentChatId: 'parent-chat',
		parentEnv: makeParentEnv(stream),
		parentSession: noParentSession,
		settings,
		...extra,
	});
}

// ── resolveAgentModel ──────────────────────────────────────────────

describe('resolveAgentModel', () => {
	test('defaults to self (parent model + provider)', () => {
		expect(resolveAgentModel({}, settings, parent)).toEqual({ model: 'parent-model', provider: 'or' });
		expect(resolveAgentModel({ model: 'self' }, settings, parent)).toEqual({ model: 'parent-model', provider: 'or' });
	});

	test('resolves configured tiers with their provider', () => {
		expect(resolveAgentModel({ model: 'lite' }, settings, parent)).toEqual({ model: 'small-model', provider: 'nano' });
		expect(resolveAgentModel({ model: 'ultra' }, settings, parent)).toEqual({ model: 'big-model', provider: 'or' });
	});

	test('errors on unconfigured tier', () => {
		const r = resolveAgentModel({ model: 'medium' }, settings, parent);
		expect(r).toHaveProperty('error');
		expect((r as any).error).toContain('not configured');
	});

	test('errors on unknown model value', () => {
		expect(resolveAgentModel({ model: 'gpt-9000' }, settings, parent)).toHaveProperty('error');
	});

	test('preset with tier model resolves through settings', () => {
		const r = resolveAgentModel({ preset: 'reviewer' }, settings, parent) as any;
		expect(r.model).toBe('big-model');
		expect(r.provider).toBe('or');
		expect(r.preset.name).toBe('reviewer');
	});

	test('preset with explicit model uses its own provider', () => {
		const r = resolveAgentModel({ preset: 'Searcher' }, settings, parent) as any; // case-insensitive
		expect(r.model).toBe('x/explicit');
		expect(r.provider).toBe('zai');
	});

	test('preset takes precedence over model arg', () => {
		const r = resolveAgentModel({ preset: 'reviewer', model: 'lite' }, settings, parent) as any;
		expect(r.model).toBe('big-model');
	});

	test('tier prompt is surfaced when a tier is used without a preset', () => {
		const withPrompt: AgentSettings = {
			...settings,
			models: { ...settings.models, lite: { ...settings.models.lite, prompt: 'Be brief.' } },
		};
		const r = resolveAgentModel({ model: 'lite' }, withPrompt, parent) as any;
		expect(r.model).toBe('small-model');
		expect(r.prompt).toBe('Be brief.');
		// self has no tier prompt
		expect(resolveAgentModel({ model: 'self' }, withPrompt, parent) as any).not.toHaveProperty('prompt');
	});

	test('errors on unknown preset, listing available ones', () => {
		const r = resolveAgentModel({ preset: 'nope' }, settings, parent) as any;
		expect(r.error).toContain('reviewer');
		expect(r.error).toContain('searcher');
	});
});

// ── updateSpawnAgentTool ───────────────────────────────────────────

describe('updateSpawnAgentTool', () => {
	const toolProps = () => (tools.find(t => t.function.name === 'spawn_agent')!.function.parameters as any).properties;

	test('model enum reflects configured tiers only', () => {
		updateSpawnAgentTool(settings);
		expect(toolProps().model.enum).toEqual(['self', 'lite', 'ultra']);
		expect(toolProps().model.description).toContain('small-model');
	});

	test('preset enum + description list user presets', () => {
		updateSpawnAgentTool(settings);
		expect(toolProps().preset.enum).toEqual(['reviewer', 'searcher']);
		expect(toolProps().preset.description).toContain('reviews code');
	});

	test('no presets → enum removed', () => {
		updateSpawnAgentTool({ ...settings, presets: [] });
		expect(toolProps().preset.enum).toBeUndefined();
		updateSpawnAgentTool(settings); // restore
	});
});

// ── runAgentTask ────────────────────────────────────────────────────

describe('runAgentTask', () => {
	let rawSqlite: BunDatabase;

	beforeEach(() => {
		kvStore.clear();
		rawSqlite = new BunDatabase(':memory:');
		rawSqlite.exec('PRAGMA foreign_keys = ON');
		rawSqlite.exec(SCHEMA);
		// Real parent row so agent chats can link via parent_id (FK enforced)
		rawSqlite.exec("INSERT INTO chats (id, name, created, updated) VALUES ('parent-chat', 'Parent', 0, 0)");
		_initForTesting(createAdapter(rawSqlite));
	});

	// Chats spawned by the runner (excludes the seeded parent row)
	const agentChats = async () => (await listChats()).filter(c => c.id !== 'parent-chat');

	test('refuses missing task and unknown preset without touching the db', async () => {
		expect(await spawn({}, fakeStream(() => ({ success: true })))).toContain('task is required');
		expect(await spawn({ task: 'x', preset: 'nope' }, fakeStream(() => ({ success: true }))))
			.toContain('Unknown preset');
		expect(await agentChats()).toHaveLength(0);
	});

	test('runs a tool turn then a final answer, persists the agent chat', async () => {
		const stream = fakeStream((turn, onContent) => {
			if (turn === 1) return toolCallTurn(turn);
			onContent?.('FINAL ANSWER');
			return { success: true };
		});

		const result = await spawn({ task: 'Do the thing' }, stream);
		expect(result).toContain('[Agent finished — 2 turns');
		expect(result).toContain('FINAL ANSWER');

		const chats = await agentChats();
		expect(chats).toHaveLength(1);
		expect(chats[0].name).toBe('Agent: Do the thing');
		expect(chats[0].parent_id).toBe('parent-chat');

		const msgs = await loadChatMessages(chats[0].id);
		expect(getMessageContent(msgs[0])).toBe('Do the thing');
		expect(msgs[0].role).toBe('user');
		const toolMsg = msgs.find(m => m.tool_calls?.[0]?.length);
		// Results persist as structured data; the model-facing text is formatted from it
		expect(toolMsg?.tool_results?.[0]?.[0]?.data?.value).toBeNumber();
		expect(resolveContent(toolMsg!.tool_results![0][0])).toContain('Random number');
		expect(getMessageContent(msgs[msgs.length - 1])).toBe('FINAL ANSWER');
	});

	test('inherits all parent tools (minus spawn_agent/create_timer) when config has no explicit selection', async () => {
		const stream = fakeStream((turn, onContent) => {
			if (turn === 1) return toolCallTurn(turn);
			onContent?.('done');
			return { success: true };
		});
		const env = makeParentEnv(stream);
		env.activeConfig = () => ({ name: '', prompts: [] }); // tools undefined = all enabled

		const result = await spawn({ task: 'Use a tool' }, stream, { parentEnv: env });
		expect(result).toContain('[Agent finished');
		const chats = await agentChats();
		const msgs = await loadChatMessages(chats[0].id);
		expect(resolveContent(msgs.find(m => m.tool_calls?.[0]?.length)!.tool_results![0][0])).toContain('Random number');
	});

	test('preset tools replace the parent selection instead of extending it', async () => {
		let sentTools: Record<string, boolean> | undefined;
		const stream = async (...args: any[]) => {
			sentTools = args[13];
			args[8]?.('done');
			return { success: true };
		};
		const presetSettings: AgentSettings = {
			...settings,
			presets: [{ name: 'reader', description: '', model: 'self', prompt: '', tools: { fetch_url: true } }],
		};

		expect(await spawn({ task: 'Read a page', preset: 'reader' }, stream, { settings: presetSettings }))
			.toContain('[Agent finished');
		expect(sentTools!.fetch_url).toBe(true);
		expect(sentTools!.random_number).toBe(false);
		expect(sentTools!.spawn_agent).toBe(false);
		expect(sentTools!.create_timer).toBe(false);
	});

	test('continues with a new user turn when a response is cut off by the output limit', async () => {
		const stream = fakeStream((turn, onContent) => {
			if (turn === 1) return { success: true, finishReason: 'length' }; // e.g. ran out of budget while thinking
			onContent?.('FULL ANSWER');
			return { success: true };
		});

		const result = await spawn({ task: 'Long answer' }, stream);
		expect(result).toContain('[Agent finished — 2 turns');
		expect(result).toContain('FULL ANSWER');

		const msgs = await loadChatMessages((await agentChats())[0].id);
		expect(msgs.filter(m => m.role === 'user' && getMessageContent(m).includes('cut off'))).toHaveLength(1);
	});

	test('a model that keeps getting cut off still stops at the turn cap', async () => {
		const stream = fakeStream(() => ({ success: true, finishReason: 'length' }));
		expect(await spawn({ task: 'Never fits', max_turns: 3 }, stream)).toContain('3-turn cap');
	});

	test('stops at the turn cap when the model keeps calling tools', async () => {
		const stream = fakeStream(turn => toolCallTurn(turn));
		const result = await spawn({ task: 'Loop forever', max_turns: 2 }, stream);
		expect(result).toContain('hit the 2-turn cap');
		expect(result).toContain('2 turns');

		// The last turn is nudged to wrap up, so the cap doesn't cut off mid-work silently
		const msgs = await loadChatMessages((await agentChats())[0].id);
		const nudges = msgs.filter(m => m.role === 'user' && getMessageContent(m).includes('final turn'));
		expect(nudges).toHaveLength(1);
	});

	test('no final-turn nudge when the agent finishes before the cap', async () => {
		const stream = fakeStream((_turn, onContent) => {
			onContent?.('done');
			return { success: true };
		});
		await spawn({ task: 'Quick', max_turns: 5 }, stream);
		const msgs = await loadChatMessages((await agentChats())[0].id);
		expect(msgs.filter(m => m.role === 'user')).toHaveLength(1);
	});

	test('abortAgentsFor(parent) aborts a running agent', async () => {
		const stream = fakeStream((_turn, _onContent, signal) =>
			new Promise(resolve => signal!.addEventListener('abort', () => resolve({ success: false, error: 'aborted' })))
		);

		const pending = spawn({ task: 'Never finishes' }, stream);
		await new Promise(r => setTimeout(r, 20)); // let it create the chat + start streaming
		abortAgentsFor('parent-chat');
		const result = await pending;
		expect(result).toContain('[Agent aborted');
	});

	test('surfaces stream errors as a failed status, not a throw', async () => {
		const stream = fakeStream((_t, _c, _s) => {
			return { success: false, error: 'boom' };
		});
		const result = await spawn({ task: 'Explode' }, stream);
		expect(result).toContain('failed');
		expect(result).toContain('boom');
	});

	test('agent chat is linked to its spawning chat via parent_id (no shared history)', async () => {
		const parentId = await createChat('Parent');
		const parentMsgs = [
			{ role: 'user', content: ['earlier question'], currentVersionIndex: 0 },
			{ role: 'assistant', content: ['earlier answer'], currentVersionIndex: 0 },
		] as any[];
		await saveChatMessages(parentMsgs as any, parentId);

		const stream = fakeStream((_turn, onContent) => {
			onContent?.('done');
			return { success: true };
		});

		const result = await runAgentTask({
			args: { task: 'Standalone task' },
			parentChatId: parentId,
			parentEnv: makeParentEnv(stream),
			parentSession: { messages: parentMsgs, flush: async () => {} } as any,
			settings,
		});
		expect(result).toContain('[Agent finished');

		const agentChat = (await listChats()).find(c => c.parent_id === parentId)!;
		expect(agentChat.parent_id).toBe(parentId);
		expect(agentChat.fork_message_id).toBeNull();
		// Fresh: starts with the task only, not the parent's history
		const msgs = await loadChatMessages(agentChat.id);
		expect(getMessageContent(msgs[0])).toBe('Standalone task');
		expect(getMessageContent(msgs[msgs.length - 1])).toBe('done');
	});

	test('error result strings never reject the tool loop', async () => {
		// db not initialized for this chat id shape — force an internal throw via a broken parentSession
		const result = await runAgentTask({
			args: { task: 'x' },
			parentChatId: 'does-not-exist',
			parentEnv: makeParentEnv(fakeStream(() => ({ success: true }))),
			parentSession: { messages: [{}], flush: async () => {} } as any,
			settings,
		});
		expect(result).toContain('spawn_agent error');
	});
});
