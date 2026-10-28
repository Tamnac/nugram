/**
 * Tests for the SQLite storage layer (src/helpers/db.ts).
 *
 * Uses bun:sqlite with an in-memory database to verify all DB operations
 * against a real SQLite engine — same queries, same schema, no mocks.
 *
 * Run: bun test
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import {
	_initForTesting,
	createChat,
	listChats,
	getChat,
	renameChat,
	deleteChat,
	duplicateChat,
	forkChat,
	materializeForks,
	loadChatMessages,
	saveChatMessages,
	saveDirtyChatMessages,
	deleteMessageRow,
	loadChatMessagesWindowed,
	searchMessagesFTS,
	rebuildFTS,
	FTS_SCHEMA,
	CORE_SCHEMA,
	getMessageCount,
	getCurrentChatId,
	setCurrentChatId,
	setChatTags,
	tagFolder,
	renameTag,
	deleteTag,
	saveChatMeta,
	loadChatMeta,
	saveAttachment,
	loadAttachment,
	pruneAttachments,
	ConcurrencyError,
} from '../src/helpers/db';
import { findSearchMessageIndex } from '../src/helpers/search';
import { FORK_MIGRATION_SQL } from '../src/helpers/forkMigration';
import type { ChatMessage, ChatMeta } from '../src/helpers/types';
import { resolveContent } from '../src/helpers/tools';

// ── Schema (owned by db.ts so the tests can't drift from what ships) ───

const SCHEMA = CORE_SCHEMA.join(';') + ';';

// FTS schema is owned by db.ts (applied in initDatabase) — reuse it verbatim
// so the tests can't drift from what ships.
const FTS_SQL = FTS_SCHEMA.join(';\n') + ';';

// ── bun:sqlite adapter matching tauri-plugin-sql interface ─────────────

function convertParams(query: string): string {
	// $1, $2 ... → ?1, ?2 ... (SQLite numbered params)
	return query.replace(/\$(\d+)/g, '?$1');
}

function createAdapter(sqlite: BunDatabase) {
	return {
		execute: async (query: string, params?: any[]) => {
			const q = convertParams(query);
			// Unparameterised calls may carry several statements (the fork migration)
			if (params?.length) sqlite.prepare(q).run(...params);
			else sqlite.exec(q);
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

// ── Helpers ────────────────────────────────────────────────────────────

function msg(role: string, content: string, extra?: Partial<ChatMessage>): ChatMessage {
	return {
		role: role as ChatMessage['role'],
		content: [content],
		currentVersionIndex: 0,
		...extra,
	};
}

/** Add messages to the end of a chat, the way the app persists new ones. */
async function append(chatId: string, ...added: ChatMessage[]): Promise<ChatMessage[]> {
	const all = await loadChatMessages(chatId);
	const from = all.length;
	all.push(...added);
	await saveDirtyChatMessages(added.map((_, i) => from + i), all, chatId);
	return all;
}

const dbIdsOf = (ms: ChatMessage[]) => ms.map(m => m._dbId!);
const texts = async (chatId: string) => (await loadChatMessages(chatId)).map(m => m.content[0]);

// ── Test suite ─────────────────────────────────────────────────────────

// localStorage polyfill for bun test environment
const storage = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => storage.get(k) ?? null,
	setItem: (k: string, v: string) => storage.set(k, v),
	removeItem: (k: string) => storage.delete(k),
	clear: () => storage.clear(),
};

let rawSqlite: BunDatabase;

describe('SQLite Storage Layer', () => {
	beforeEach(() => {
		storage.clear();
		rawSqlite = new BunDatabase(':memory:');
		rawSqlite.exec('PRAGMA foreign_keys = ON');
		rawSqlite.exec(SCHEMA);
		rawSqlite.exec(FTS_SQL);
		_initForTesting(createAdapter(rawSqlite));
	});

	// ── Chat CRUD ──────────────────────────────────────────────────────

	describe('Chat CRUD', () => {
		test('createChat returns id and sets as current', async () => {
			const id = await createChat('Test Chat');
			expect(id).toBeTruthy();

			const chat = await getChat(id);
			expect(chat).not.toBeNull();
			expect(chat!.name).toBe('Test Chat');
			expect(chat!.parent_id).toBeNull();
			expect(chat!.fork_message_id).toBeNull();

			const currentId = await getCurrentChatId();
			expect(currentId).toBe(id);
		});

		test('listChats returns chats ordered by updated desc', async () => {
			const id1 = await createChat('First');
			const id2 = await createChat('Second');

			// Force distinct timestamps since both may be created in same ms
			await new Promise(r => setTimeout(r, 1)); // just to sequence
			const chats = await listChats();
			expect(chats.length).toBe(2);
			// Both created in same tick — verify both are present
			const ids = chats.map(c => c.id);
			expect(ids).toContain(id1);
			expect(ids).toContain(id2);
		});

		test('renameChat updates name', async () => {
			const id = await createChat('Old Name');
			await renameChat(id, 'New Name');

			const chat = await getChat(id);
			expect(chat!.name).toBe('New Name');
		});

		test('deleteChat removes chat and its messages', async () => {
			const id = await createChat('Doomed');
			await saveChatMessages([msg('user', 'hello')], id);

			await deleteChat(id);

			expect(await getChat(id)).toBeNull();
			expect((await loadChatMessages(id)).length).toBe(0);
		});

		test('getCurrentChatId creates default chat if none exist', async () => {
			// Fresh DB — no chats
			const id = await getCurrentChatId();
			expect(id).toBeTruthy();

			const chat = await getChat(id);
			expect(chat).not.toBeNull();
		});
	});

	// ── Message operations ─────────────────────────────────────────────

	describe('Message save & load', () => {
		test('saveChatMessages + loadChatMessages roundtrip', async () => {
			const chatId = await createChat('Test');
			const messages = [
				msg('user', 'Hello'),
				msg('assistant', 'Hi there', { thinking: ['let me think...'] }),
				msg('user', 'How are you?'),
			];

			await saveChatMessages(messages, chatId);
			const loaded = await loadChatMessages(chatId);

			expect(loaded.length).toBe(3);
			expect(loaded[0].content[0]).toBe('Hello');
			expect(loaded[1].content[0]).toBe('Hi there');
			expect(loaded[1].thinking![0]).toBe('let me think...');
			expect(loaded[2].content[0]).toBe('How are you?');
		});

		test('image attachment ids roundtrip per version', async () => {
			const chatId = await createChat('Test');
			const messages = [
				msg('user', 'look at this', { images: [['att-1', 'att-2']] }),
				msg('assistant', 'nice'),
			];

			await saveChatMessages(messages, chatId);
			const loaded = await loadChatMessages(chatId);

			expect(loaded[0].images).toEqual([['att-1', 'att-2']]);
			expect(loaded[1].images).toBeUndefined();
		});

		test('saveChatMessages assigns _dbId to each message', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'A'), msg('assistant', 'B')];

			await saveChatMessages(messages, chatId);

			expect(messages[0]._dbId).toBeDefined();
			expect(messages[1]._dbId).toBeDefined();
			expect(messages[0]._dbId).not.toBe(messages[1]._dbId);
		});

		test('loaded messages have _dbId set', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'Hello')], chatId);

			const loaded = await loadChatMessages(chatId);
			expect(loaded[0]._dbId).toBeDefined();
			expect(typeof loaded[0]._dbId).toBe('number');
		});

		test('saveChatMessages full replace assigns new _dbIds', async () => {
			const chatId = await createChat('Test');
			const messages1 = [msg('user', 'A')];
			await saveChatMessages(messages1, chatId);
			const oldId = messages1[0]._dbId;

			const messages2 = [msg('user', 'B'), msg('assistant', 'C')];
			await saveChatMessages(messages2, chatId);

			expect(messages2[0]._dbId).toBeDefined();
			expect(messages2[0]._dbId).not.toBe(oldId); // new id after full replace
		});

		test('message versioning roundtrips', async () => {
			const chatId = await createChat('Test');
			const messages = [
				msg('assistant', 'v1', {
					content: ['v1', 'v2'],
					currentVersionIndex: 1,
					models: ['model-a', 'model-b'],
					thinking: ['think1', 'think2'],
				}),
			];

			await saveChatMessages(messages, chatId);
			const loaded = await loadChatMessages(chatId);

			expect(loaded[0].content).toEqual(['v1', 'v2']);
			expect(loaded[0].currentVersionIndex).toBe(1);
			expect(loaded[0].models).toEqual(['model-a', 'model-b']);
			expect(loaded[0].thinking).toEqual(['think1', 'think2']);
		});

		test('tool_calls and tool_results roundtrip', async () => {
			const chatId = await createChat('Test');
			const toolCalls = [[{ id: 'tc1', type: 'function' as const, function: { name: 'test', arguments: { x: 1 } } }]];
			const toolResults = [[{ tool_call_id: 'tc1', name: 'test', content: 'result' }]];
			const messages = [
				msg('assistant', 'done', { tool_calls: toolCalls, tool_results: toolResults }),
			];

			await saveChatMessages(messages, chatId);
			const loaded = await loadChatMessages(chatId);

			expect(loaded[0].tool_calls).toEqual(toolCalls);
			expect(loaded[0].tool_results).toEqual(toolResults);
		});

		test('structured tool result data survives a save/load cycle', async () => {
			const chatId = await createChat('Test');
			const toolCalls = [[{ id: 'tc1', type: 'function' as const, function: { name: 'shell', arguments: { command: 'ls' } } }]];
			// Data-backed result (no content) plus one carrying a user-edited override
			const toolResults = [[
				{ tool_call_id: 'tc1', name: 'shell', data: { ok: true, exit_code: 0, duration_ms: 1500, stdout: 'a\nb', stderr: '' } },
				{ tool_call_id: 'tc2', name: 'shell', data: { ok: false, exit_code: 1, duration_ms: 0, stdout: 'x', stderr: 'boom' }, content: 'trimmed by user' },
			]];
			await saveChatMessages([msg('assistant', 'done', { tool_calls: toolCalls, tool_results: toolResults })], chatId);
			const loaded = await loadChatMessages(chatId);

			expect(loaded[0].tool_results).toEqual(toolResults);
			// Text is regenerated from the reloaded data, and the override still wins
			expect(resolveContent(loaded[0].tool_results![0][0])).toBe('Exit code: 0 (1.5s)\n\na\nb');
			expect(resolveContent(loaded[0].tool_results![0][1])).toBe('trimmed by user');
		});
	});

	// ── Dirty (incremental) saves ──────────────────────────────────────

	describe('Dirty saves', () => {
		test('update existing message preserves _dbId', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'original')];
			await saveChatMessages(messages, chatId);
			const originalDbId = messages[0]._dbId;

			messages[0] = { ...messages[0], content: ['edited'] };
			await saveDirtyChatMessages([0], messages, chatId);

			const loaded = await loadChatMessages(chatId);
			expect(loaded[0].content[0]).toBe('edited');
			expect(loaded[0]._dbId).toBe(originalDbId); // same id
		});

		test('append new message via dirty save assigns _dbId', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'first')];
			await saveChatMessages(messages, chatId);

			// Append
			messages.push(msg('assistant', 'second'));
			await saveDirtyChatMessages([1], messages, chatId);

			expect(messages[1]._dbId).toBeDefined();

			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(2);
			expect(loaded[1].content[0]).toBe('second');
		});

		test('mixed update + insert in one dirty save', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(messages, chatId);
			const idA = messages[0]._dbId;

			messages[0] = { ...messages[0], content: ['A-edited'] };
			messages.push(msg('user', 'C'));
			await saveDirtyChatMessages([0, 2], messages, chatId);

			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(3);
			expect(loaded[0].content[0]).toBe('A-edited');
			expect(loaded[0]._dbId).toBe(idA); // preserved
			expect(loaded[2].content[0]).toBe('C');
			expect(loaded[2]._dbId).toBeDefined(); // newly assigned
		});

		test('dirty save skips indices past array length', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'A')];
			await saveChatMessages(messages, chatId);

			// Simulate: index 5 is in dirty set but array only has 1 message
			await saveDirtyChatMessages([0, 5], messages, chatId);

			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(1);
		});
	});

	// ── Delete by _dbId ────────────────────────────────────────────────

	describe('Delete message by _dbId', () => {
		test('deleteMessageRow removes the specific message', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, chatId);

			await deleteMessageRow(messages[1]._dbId!);

			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(2);
			expect(loaded[0].content[0]).toBe('A');
			expect(loaded[1].content[0]).toBe('C');
		});

		test('delete preserves other messages _dbIds', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, chatId);
			const idA = messages[0]._dbId;
			const idC = messages[2]._dbId;

			await deleteMessageRow(messages[1]._dbId!);

			const loaded = await loadChatMessages(chatId);
			expect(loaded[0]._dbId).toBe(idA);
			expect(loaded[1]._dbId).toBe(idC);
		});

		test('delete middle message does not affect message count of other messages', async () => {
			const chatId = await createChat('Test');
			const messages = [
				msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C'),
				msg('assistant', 'D'), msg('user', 'E'),
			];
			await saveChatMessages(messages, chatId);

			// Delete B and D
			await deleteMessageRow(messages[1]._dbId!);
			await deleteMessageRow(messages[3]._dbId!);

			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(3);
			expect(loaded.map(m => m.content[0])).toEqual(['A', 'C', 'E']);
		});

		test('delete re-indexes so appended messages do not collide', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, chatId);

			// Delete middle message — simulates the in-memory splice
			await deleteMessageRow(messages[1]._dbId!, chatId);
			const inMemory = [messages[0], messages[2]];

			// Append a new message at array index 2 (= inMemory.length)
			inMemory.push(msg('assistant', 'NEW'));
			await saveDirtyChatMessages([2], inMemory, chatId);

			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(3);
			expect(loaded.map(m => m.content[0])).toEqual(['A', 'C', 'NEW']);
		});

		test('load repairs idx gaps left by older builds', async () => {
			const chatId = await createChat('Test');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C'), msg('assistant', 'D')];
			await saveChatMessages(messages, chatId);

			// Simulate old-build delete: remove row directly without re-indexing.
			// Leaves idx gap: 0, 2, 3
			rawSqlite.exec(`DELETE FROM messages WHERE id = ${messages[1]._dbId}`);

			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(3);
			expect(loaded.map(m => m.content[0])).toEqual(['A', 'C', 'D']);

			// Verify idx values were repaired to 0, 1, 2
			const rows = rawSqlite.prepare(
				`SELECT idx FROM messages WHERE chat_id = ? ORDER BY idx`
			).all(chatId) as { idx: number }[];
			expect(rows.map(r => r.idx)).toEqual([0, 1, 2]);

			// Append should now work without overwriting
			const inMemory = [...loaded, msg('user', 'NEW')];
			await saveDirtyChatMessages([3], inMemory, chatId);

			const reloaded = await loadChatMessages(chatId);
			expect(reloaded.length).toBe(4);
			expect(reloaded.map(m => m.content[0])).toEqual(['A', 'C', 'D', 'NEW']);
		});
	});

	// ── Duplicate ──────────────────────────────────────────────────────

	describe('Duplicate chat', () => {
		test('duplicateChat creates independent copy', async () => {
			const chatId = await createChat('Original');
			const messages = [msg('user', 'Hello'), msg('assistant', 'Hi')];
			await saveChatMessages(messages, chatId);

			const copyId = await duplicateChat(chatId, 'Copy');
			const copy = await getChat(copyId);
			expect(copy!.name).toBe('Copy');
			expect(copy!.parent_id).toBeNull(); // no fork link

			const copyMsgs = await loadChatMessages(copyId);
			expect(copyMsgs.length).toBe(2);
			expect(copyMsgs[0].content[0]).toBe('Hello');

			// Different _dbIds than original
			expect(copyMsgs[0]._dbId).not.toBe(messages[0]._dbId);
		});

		test('editing duplicate does not affect original', async () => {
			const chatId = await createChat('Original');
			await saveChatMessages([msg('user', 'shared')], chatId);

			const copyId = await duplicateChat(chatId);
			const copyMsgs = await loadChatMessages(copyId);
			copyMsgs[0] = { ...copyMsgs[0], content: ['modified'] };
			await saveDirtyChatMessages([0], copyMsgs, copyId);

			const origMsgs = await loadChatMessages(chatId);
			expect(origMsgs[0].content[0]).toBe('shared'); // unchanged
		});
	});

	// ── Fork ───────────────────────────────────────────────────────────

	describe('Fork (copy)', () => {
		test('forkChat copies messages up to the index and records where it came from', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1); // fork after message B
			const fork = await getChat(forkId);

			expect(fork!.parent_id).toBe(parentId);
			expect(fork!.fork_message_id).toBe(messages[1]._dbId!);

			const copied = await loadChatMessages(forkId);
			expect(copied.map(m => m.content[0])).toEqual(['A', 'B']);
			expect(copied[0]._dbId).not.toBe(messages[0]._dbId); // its own rows
			expect(await texts(parentId)).toEqual(['A', 'B', 'C']);
		});

		test('fork keeps its own messages after the copied ones', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')], parentId);

			const forkId = await forkChat(parentId, 1);
			await append(forkId, msg('assistant', 'Fork reply'));

			expect(await texts(forkId)).toEqual(['A', 'B', 'Fork reply']);
			const idxs = rawSqlite.prepare('SELECT idx FROM messages WHERE chat_id = ? ORDER BY idx').all(forkId) as { idx: number }[];
			expect(idxs.map(r => r.idx)).toEqual([0, 1, 2]);
		});

		test('copies every column of a message', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('assistant', 'A', {
				content: ['A', 'A2'], currentVersionIndex: 1, thinking: ['t', 't2'],
				tool_calls: [[{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }], []],
				tool_results: [[{ tool_call_id: 'c1', name: 'x', content: 'res' }], []],
				models: ['m', 'm2'], providers: ['p', 'p2'],
				files: [[{ id: 'text-1', path: 'a.ts', chars: 5 }]],
			})], parentId);

			const forkId = await forkChat(parentId, 0);
			const [orig] = await loadChatMessages(parentId);
			const [copy] = await loadChatMessages(forkId);
			expect(copy._dbId).not.toBe(orig._dbId);
			expect({ ...copy, _dbId: 0 }).toEqual({ ...orig, _dbId: 0 });
		});

		test('editing the parent does not change the fork', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1);

			messages[1] = { ...messages[1], content: ['B-edited'] };
			await saveDirtyChatMessages([1], messages, parentId);

			expect(await texts(forkId)).toEqual(['A', 'B']);
		});

		test('editing the fork does not change the parent', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], parentId);

			const forkId = await forkChat(parentId, 1);
			const forkMsgs = await loadChatMessages(forkId);
			forkMsgs[1] = { ...forkMsgs[1], content: ['B-edited'] };
			await saveDirtyChatMessages([1], forkMsgs, forkId);
			await deleteMessageRow(forkMsgs[0]._dbId!, forkId);

			expect(await texts(forkId)).toEqual(['B-edited']);
			expect(await texts(parentId)).toEqual(['A', 'B']);
		});

		test('deleting a parent message does not touch the fork', async () => {
			const parentId = await createChat('Parent');
			const messages = [
				msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C'),
				msg('assistant', 'D'), msg('user', 'E'),
			];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 3);
			await deleteMessageRow(messages[1]._dbId!);

			expect(await texts(forkId)).toEqual(['A', 'B', 'C', 'D']);
		});

		test('parent messages after the fork point are not copied', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], parentId);

			const forkId = await forkChat(parentId, 0);
			await append(parentId, msg('user', 'C'));

			expect(await texts(forkId)).toEqual(['A']);
		});

		test('out-of-range index throws and creates nothing', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], parentId);

			await expect(forkChat(parentId, 2)).rejects.toThrow('out of range (0..1)');
			await expect(forkChat(parentId, -1)).rejects.toThrow('out of range');
			expect((await listChats()).length).toBe(1);
		});

		test('forking a fork records the fork itself as the parent', async () => {
			const gpId = await createChat('Grandparent');
			await saveChatMessages([msg('user', 'gp0'), msg('assistant', 'gp1'), msg('user', 'gp2')], gpId);

			const parentId = await forkChat(gpId, 2);
			const parentMsgs = await append(parentId, msg('assistant', 'p0'));

			// Fork inside the range that was copied from the grandparent
			const childId = await forkChat(parentId, 1);
			const child = await getChat(childId);
			expect(child!.parent_id).toBe(parentId);
			expect(child!.fork_message_id).toBe(parentMsgs[1]._dbId!);
			expect(await texts(childId)).toEqual(['gp0', 'gp1']);

			const grandchildId = await forkChat(parentId, 3);
			expect(await texts(grandchildId)).toEqual(['gp0', 'gp1', 'gp2', 'p0']);
		});

		test('fork copies are marked with their origin, duplicates are not', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(parent, parentId);

			const originOf = (chatId: string) =>
				(rawSqlite.prepare('SELECT origin_id FROM messages WHERE chat_id = ? ORDER BY idx').all(chatId) as { origin_id: number | null }[]).map(r => r.origin_id);

			const forkId = await forkChat(parentId, 1);
			expect(originOf(forkId)).toEqual(dbIdsOf(parent));
			expect(originOf(parentId)).toEqual([null, null]);
			expect(originOf(await duplicateChat(parentId))).toEqual([null, null]);

			// A fork of a fork still points at the original rows
			expect(originOf(await forkChat(forkId, 1))).toEqual(dbIdsOf(parent));
		});

		test('a failed copy leaves no fork behind', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], parentId);
			const base = createAdapter(rawSqlite);
			_initForTesting({
				...base,
				execute: async (q: string, p?: any[]) => {
					if (q.includes('INSERT INTO messages')) throw new Error('disk full');
					return base.execute(q, p);
				},
			});

			await expect(forkChat(parentId, 1)).rejects.toThrow('disk full');
			expect((await listChats()).map(c => c.id)).toEqual([parentId]);
		});

		test('a copy that raced a write to the source is undone', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], parentId);
			const base = createAdapter(rawSqlite);
			_initForTesting({
				...base,
				execute: async (q: string, p?: any[]) => {
					const result = await base.execute(q, p);
					if (q.includes('INSERT INTO messages'))
						rawSqlite.prepare('UPDATE chats SET version = version + 1 WHERE id = ?').run(parentId);
					return result;
				},
			});

			await expect(forkChat(parentId, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
			expect((await listChats()).map(c => c.id)).toEqual([parentId]);
			expect((rawSqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(2);
		});

		test('forking a chat with idx gaps keeps the boundary and copies everything before it', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C'), msg('assistant', 'D')], parentId);
			rawSqlite.prepare('UPDATE messages SET idx = idx + 100 WHERE chat_id = ?').run(parentId);
			rawSqlite.prepare('DELETE FROM messages WHERE chat_id = ? AND idx = 101').run(parentId); // B

			const forkId = await forkChat(parentId, 1);

			expect(await texts(forkId)).toEqual(['A', 'C']);
			const idxs = rawSqlite.prepare('SELECT idx FROM messages WHERE chat_id = ? ORDER BY idx').all(forkId) as { idx: number }[];
			expect(idxs.map(r => r.idx)).toEqual([0, 1]);
		});
	});

	// ── Parent link on delete ──────────────────────────────────────────

	describe('Deleting a parent chat', () => {
		test('forks keep their messages and lose the link', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')], parentId);

			const forkId = await forkChat(parentId, 1);
			await append(forkId, msg('assistant', 'Fork D'));

			await deleteChat(parentId);

			const fork = await getChat(forkId);
			expect(fork!.parent_id).toBeNull();
			expect(fork!.fork_message_id).toBeNull();
			expect(await texts(forkId)).toEqual(['A', 'B', 'Fork D']);
		});

		test('sub-agent chats keep their messages and lose the link', async () => {
			const parentId = await createChat('Parent');
			const agentId = await createChat('Agent', undefined, undefined, false, parentId);
			await saveChatMessages([msg('user', 'task'), msg('assistant', 'done')], agentId);
			expect((await getChat(agentId))!.fork_message_id).toBeNull();

			await deleteChat(parentId);

			expect((await getChat(agentId))!.parent_id).toBeNull();
			expect(await texts(agentId)).toEqual(['task', 'done']);
		});

		test('children move up to the deleted chat\'s parent, then lose the link at the top', async () => {
			const aId = await createChat('A');
			await saveChatMessages([msg('user', 'A0'), msg('assistant', 'A1')], aId);
			const bId = await forkChat(aId, 1);
			const cId = await forkChat(bId, 1);
			const agentId = await createChat('Agent', undefined, undefined, false, bId);
			expect((await getChat(cId))!.fork_message_id).not.toBeNull();

			await deleteChat(bId);

			expect((await getChat(cId))!.parent_id).toBe(aId);
			expect((await getChat(cId))!.fork_message_id).not.toBeNull(); // still a fork
			expect((await getChat(agentId))!.parent_id).toBe(aId);
			expect((await getChat(agentId))!.fork_message_id).toBeNull(); // still not one
			expect(await texts(cId)).toEqual(['A0', 'A1']);

			await deleteChat(aId);

			expect((await getChat(cId))!.parent_id).toBeNull();
			expect((await getChat(cId))!.fork_message_id).toBeNull();
		});
	});

	// ── Windowed loading ───────────────────────────────────────────────

	describe('Windowed loading', () => {
		test('basic LIMIT/OFFSET', async () => {
			const chatId = await createChat('Test');
			const messages = Array.from({ length: 10 }, (_, i) => msg('user', `msg-${i}`));
			await saveChatMessages(messages, chatId);

			const page1 = await loadChatMessagesWindowed(chatId, 3, 0);
			expect(page1.length).toBe(3);
			expect(page1[0].content[0]).toBe('msg-0');

			const page2 = await loadChatMessagesWindowed(chatId, 3, 3);
			expect(page2.length).toBe(3);
			expect(page2[0].content[0]).toBe('msg-3');

			const lastPage = await loadChatMessagesWindowed(chatId, 3, 9);
			expect(lastPage.length).toBe(1);
			expect(lastPage[0].content[0]).toBe('msg-9');
		});

		test('windowed loading in a fork', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages(Array.from({ length: 5 }, (_, i) => msg('user', `parent-${i}`)), parentId);

			const forkId = await forkChat(parentId, 4); // copy all 5
			await append(forkId, ...Array.from({ length: 3 }, (_, i) => msg('user', `fork-${i}`)));

			const window = await loadChatMessagesWindowed(forkId, 4, 3);
			expect(window.map(m => m.content[0])).toEqual(['parent-3', 'parent-4', 'fork-0', 'fork-1']);
		});
	});

	// ── Search ─────────────────────────────────────────────────────────

	describe('Attachments', () => {
		test('save and load an attachment', async () => {
			await saveAttachment('att-1', 'image/webp', 'AAAA');
			expect(await loadAttachment('att-1')).toEqual({ mime: 'image/webp', data: 'AAAA' });
			expect(await loadAttachment('missing')).toBeNull();
		});

		test('persists versioned text-file attachment references', async () => {
			const chatId = await createChat('Files');
			const files = [[{ id: 'text-1', path: 'src/a.ts', chars: 120 }]];
			await saveChatMessages([msg('user', 'review', { files })], chatId);
			const loaded = await loadChatMessages(chatId);
			expect(loaded[0].files).toEqual(files);
		});

		test('an inlined file body is never written to the message row', async () => {
			const chatId = await createChat('Inlined');
			const data = { path: 'a.ts', body: 'const a = 1;', start: 0, end: 1, total: 1 };
			await saveChatMessages([msg('user', 'review', { files: [[{ id: 'text-2', path: 'a.ts', chars: 12, data }]] })], chatId);
			const loaded = await loadChatMessages(chatId);
			expect(loaded[0].files).toEqual([[{ id: 'text-2', path: 'a.ts', chars: 12 }]]);
		});

		test('pruning keeps referenced attachments and drops the rest', async () => {
			const chatId = await createChat('Test');
			await saveAttachment('kept', 'image/webp', 'A');
			await saveAttachment('kept-old-version', 'image/webp', 'B');
			await saveAttachment('kept-file', 'application/x-nugram-text-file+json', '{}');
			await saveAttachment('kept-tool-image', 'image/webp', 'D');
			await saveAttachment('orphan', 'image/webp', 'C');
			await saveChatMessages([
				{ role: 'user', content: ['v0', 'v1'], currentVersionIndex: 1, images: [['kept-old-version'], ['kept']], files: [[{ id: 'kept-file', path: 'a.ts', chars: 10 }], []] },
				{
					role: 'assistant', content: [''], currentVersionIndex: 0,
					tool_results: [[{ tool_call_id: 'c1', name: 'read_file', data: { path: 'a.png', images: ['kept-tool-image'] } }]],
				},
				msg('assistant', 'no images', { files: [[{ path: 'missing-id', chars: 0 } as any]] }),
			], chatId);

			await pruneAttachments();

			expect(await loadAttachment('kept')).not.toBeNull();
			expect(await loadAttachment('kept-old-version')).not.toBeNull();
			expect(await loadAttachment('kept-file')).not.toBeNull();
			expect(await loadAttachment('kept-tool-image')).not.toBeNull();
			expect(await loadAttachment('orphan')).toBeNull();
		});

		test('pruning keeps run_js snapshots and images of nested results', async () => {
			const chatId = await createChat('Test');
			await saveAttachment('jsstate-kept', 'application/x-nugram-js-state', '{}');
			await saveAttachment('jsstate-orphan', 'application/x-nugram-js-state', '{}');
			await saveAttachment('nested-image', 'image/webp', 'A');
			const nested = (id: string, data?: object) => ({
				call: { id, type: 'function', function: { name: 'read_file', arguments: {} } },
				...(data && { result: { tool_call_id: id, name: 'read_file', data } }),
			});
			await saveChatMessages([{
				role: 'assistant', content: [''], currentVersionIndex: 0,
				tool_results: [[
					{
						tool_call_id: 'j', name: 'run_js',
						data: { ok: true, state: 'jsstate-kept', log: [{ print: 'hi' }, nested('j:1', { path: 'a.png', images: ['nested-image'] }), nested('j:2')] },
					},
					{ tool_call_id: 'k', name: 'run_js', data: { ok: false, timedOut: true, log: [] } },
				]],
			}], chatId);

			await pruneAttachments();

			expect(await loadAttachment('jsstate-kept')).not.toBeNull();
			expect(await loadAttachment('nested-image')).not.toBeNull();
			expect(await loadAttachment('jsstate-orphan')).toBeNull();
		});

		test('pruning keeps attachments of unsent drafts', async () => {
			const chatId = await createChat('Test');
			await saveAttachment('draft-image', 'image/webp', 'A');
			await saveAttachment('draft-file', 'application/x-nugram-text-file+json', '{}');
			await saveAttachment('orphan', 'image/webp', 'B');
			await saveChatMeta({
				macros: {}, configName: 'Default', cut: -1, theme: 'modern', model: 'm', provider: 'or',
				draft: { text: '', images: ['draft-image'], files: [{ id: 'draft-file', path: 'a.ts', chars: 1 }], role: 'user' },
			}, chatId);

			await pruneAttachments();

			expect(await loadAttachment('draft-image')).not.toBeNull();
			expect(await loadAttachment('draft-file')).not.toBeNull();
			expect(await loadAttachment('orphan')).toBeNull();
		});

		test('deleting a chat leaves attachments for maintenance pruning', async () => {
			const chatId = await createChat('Test');
			await saveAttachment('att-old', 'image/webp', 'A');
			await saveAttachment('att-fresh', 'image/webp', 'B');
			rawSqlite.exec(`UPDATE attachments SET created = ${Date.now() - 2 * 24 * 3_600_000} WHERE id = 'att-old'`);
			await saveChatMessages([msg('user', 'hi', { images: [['att-old', 'att-fresh']] })], chatId);

			await deleteChat(chatId);

			expect(await loadAttachment('att-old')).not.toBeNull();
			expect(await loadAttachment('att-fresh')).not.toBeNull();

			await pruneAttachments(24 * 3_600_000);

			expect(await loadAttachment('att-old')).toBeNull();
			expect(await loadAttachment('att-fresh')).not.toBeNull();
		});

	});

	describe('Message search (FTS)', () => {
		// count(*) on the FTS table reads through to `messages`, so it reports rows
		// that were never indexed. The shadow docsize table counts real index entries.
		const indexedCount = () => (rawSqlite.prepare('SELECT count(*) AS c FROM messages_fts_docsize').get() as any).c;
		/** Throws if the index disagrees with the content table. */
		const integrityCheck = () => rawSqlite.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);

		test('finds messages by content', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([
				msg('user', 'The quick brown fox'),
				msg('assistant', 'jumps over the lazy dog'),
				msg('user', 'something else'),
			], chatId);

			const results = await searchMessagesFTS('brown fox');
			expect(results.length).toBe(1);
			expect(results[0].chatName).toBe('Test');
			expect(results[0].idx).toBe(0);
			expect(results[0].role).toBe('user');
			expect(results[0].snippet).toContain('<b>brown</b>');
		});

		test('search hits in a fork resolve to the displayed message', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')], parentId);
			const forkId = await forkChat(parentId, 2);
			const messages = await append(forkId, msg('assistant', 'Context'), msg('user', 'needle'));

			const [hit] = await searchMessagesFTS('needle');
			expect(hit.chatId).toBe(forkId);
			expect(hit.idx).toBe(4);
			expect(findSearchMessageIndex(messages, hit.dbId)).toBe(4);

			const reloaded = await loadChatMessages(forkId);
			expect(findSearchMessageIndex(reloaded, hit.dbId)).toBe(4);
		});

		test('a message copied into forks is reported once, in the original', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'needle here'), msg('assistant', 'B')], parentId);
			const forkA = await forkChat(parentId, 0);
			const forkB = await forkChat(parentId, 1);
			await forkChat(forkB, 1); // copy of a copy still counts toward the same message

			const results = await searchMessagesFTS('needle');
			expect(results.length).toBe(1);
			expect(results[0].chatId).toBe(parentId);
			expect(results[0].copies).toBe(3);
			expect(forkA).not.toBe(parentId);
		});

		test('forks collapse inside the scoped set, and a diverged copy still shows', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'needle here'), msg('assistant', 'B')], parentId);
			rawSqlite.prepare("UPDATE chats SET chat_folder = '/a' WHERE id = ?").run(parentId);
			const forkId = await forkChat(parentId, 0);
			rawSqlite.prepare("UPDATE chats SET chat_folder = '/b' WHERE id = ?").run(forkId);
			await append(forkId, msg('user', 'another needle'));

			// Original out of scope: the fork's copy is what matches
			const inB = await searchMessagesFTS('needle', { folders: ['/b'] });
			expect(inB.map(r => [r.chatId, r.idx, r.copies]).sort((a, b) => (a[1] as number) - (b[1] as number))).toEqual([[forkId, 0, undefined], [forkId, 1, undefined]]);
		});

		test('copies cannot fill the result limit', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'needle'), msg('assistant', 'B')], parentId);
			for (let i = 0; i < 10; i++) await forkChat(parentId, 0); // more copies than the first look at the ranking holds
			const other = await createChat('Other');
			await saveChatMessages([msg('user', 'needle elsewhere')], other);

			const results = await searchMessagesFTS('needle', { limit: 2 });
			expect(results.map(r => r.chatId).sort()).toEqual([parentId, other].sort());
		});

		test('a duplicate is not collapsed', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'needle here')], parentId);
			const copyId = await duplicateChat(parentId);

			const results = await searchMessagesFTS('needle');
			expect(results.map(r => r.chatId).sort()).toEqual([parentId, copyId].sort());
			expect(results.every(r => r.copies === undefined)).toBe(true);
		});

		test('searches across all chats', async () => {
			const chat1 = await createChat('Chat 1');
			await saveChatMessages([msg('user', 'alpha bravo')], chat1);

			const chat2 = await createChat('Chat 2');
			await saveChatMessages([msg('user', 'bravo charlie')], chat2);

			const results = await searchMessagesFTS('bravo');
			expect(results.length).toBe(2);
			expect(results.map(r => r.chatName).sort()).toEqual(['Chat 1', 'Chat 2']);
		});

		test('returns empty for no match', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'hello world')], chatId);

			expect(await searchMessagesFTS('xyz123')).toEqual([]);
		});

		describe('folder scoping', () => {
			const folderMeta = (chatFolder: string): ChatMeta => ({
				macros: {}, configName: 'Default', cut: -1, theme: 'fantasy',
				tools: {}, model: 'test-model', provider: 'or', loreId: 'lore', chatFolder,
			});

			async function seedFolders() {
				const inA = await createChat('In A');
				await saveChatMeta(folderMeta('/work/a'), inA);
				await saveChatMessages([msg('user', 'bravo in a')], inA);

				const inB = await createChat('In B');
				await saveChatMeta(folderMeta('/work/b'), inB);
				await saveChatMessages([msg('user', 'bravo in b')], inB);

				const loose = await createChat('Loose');
				await saveChatMessages([msg('user', 'bravo unfoldered')], loose);
			}

			test('scopes to a single folder', async () => {
				await seedFolders();
				const results = await searchMessagesFTS('bravo', { folders: ['/work/a'] });
				expect(results.map(r => r.chatName)).toEqual(['In A']);
			});

			test('scopes to several folders', async () => {
				await seedFolders();
				const results = await searchMessagesFTS('bravo', { folders: ['/work/a', '/work/b'] });
				expect(results.map(r => r.chatName).sort()).toEqual(['In A', 'In B']);
			});

			test("'' matches unfoldered chats", async () => {
				await seedFolders();
				const results = await searchMessagesFTS('bravo', { folders: [''] });
				expect(results.map(r => r.chatName)).toEqual(['Loose']);
			});

			test("'' combines with named folders", async () => {
				await seedFolders();
				const results = await searchMessagesFTS('bravo', { folders: ['', '/work/b'] });
				expect(results.map(r => r.chatName).sort()).toEqual(['In B', 'Loose']);
			});

			test('an empty folder list matches nothing', async () => {
				await seedFolders();
				expect(await searchMessagesFTS('bravo', { folders: [] })).toEqual([]);
			});

			test('omitting folders searches everywhere', async () => {
				await seedFolders();
				expect((await searchMessagesFTS('bravo')).length).toBe(3);
			});

			test('limit applies after folder filtering', async () => {
				// Fill the global limit with hits outside the target folder
				for (let i = 0; i < 3; i++) {
					const noise = await createChat(`Noise ${i}`);
					await saveChatMeta(folderMeta('/noise'), noise);
					await saveChatMessages([msg('user', 'bravo noise')], noise);
				}
				const target = await createChat('Target');
				await saveChatMeta(folderMeta('/target'), target);
				await saveChatMessages([msg('user', 'bravo target')], target);

				const results = await searchMessagesFTS('bravo', { folders: ['/target'], limit: 2 });
				expect(results.map(r => r.chatName)).toEqual(['Target']);
			});
		});

		test('prefix-matches the final term', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'refactoring the parser')], chatId);

			expect((await searchMessagesFTS('refac')).length).toBe(1);
		});

		test('snippet escapes HTML', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'the <script>alpha</script> tag')], chatId);

			const results = await searchMessagesFTS('alpha');
			expect(results[0].snippet).toContain('&lt;script&gt;');
			expect(results[0].snippet).not.toContain('<script>');
		});

		test('reports non-active version matches', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([
				{ role: 'assistant', content: ['first draft zebra', 'second draft'], currentVersionIndex: 1 },
			], chatId);

			const results = await searchMessagesFTS('zebra');
			expect(results.length).toBe(1);
			expect(results[0].versionIndex).toBe(0);
		});

		test('tolerates FTS syntax characters in the query', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'quoted "text" here')], chatId);

			// Each of these throws if passed to MATCH unsanitized
			for (const q of ['"', 'a"b', '-foo', 'NEAR', 'x OR', '((', '*', 'a AND "b'])
				expect(await searchMessagesFTS(q)).toBeArray();

			expect((await searchMessagesFTS('"quoted"')).length).toBe(1);
		});

		// ── Index sync ─────────────────────────────────────────────────

		test('index follows message edits', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'original text')], chatId);
			expect((await searchMessagesFTS('original')).length).toBe(1);

			const loaded = await loadChatMessages(chatId);
			loaded[0].content = ['replaced text'];
			await saveDirtyChatMessages([0], loaded, chatId);

			expect(await searchMessagesFTS('original')).toEqual([]);
			expect((await searchMessagesFTS('replaced')).length).toBe(1);
			integrityCheck();
		});

		test('index follows single-message deletes', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'keepme'), msg('assistant', 'dropme')], chatId);

			const loaded = await loadChatMessages(chatId);
			await deleteMessageRow(loaded[1]._dbId!);

			expect(await searchMessagesFTS('dropme')).toEqual([]);
			expect((await searchMessagesFTS('keepme')).length).toBe(1);
			integrityCheck();
		});

		test('index survives saveChatMessages replace', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'firstpass')], chatId);
			await saveChatMessages([msg('user', 'secondpass')], chatId);

			expect(await searchMessagesFTS('firstpass')).toEqual([]);
			expect((await searchMessagesFTS('secondpass')).length).toBe(1);
			integrityCheck();
		});

		test('deleteChat cascade clears the index', async () => {
			const chatId = await createChat('Doomed');
			await saveChatMessages([msg('user', 'ephemeral content')], chatId);
			expect((await searchMessagesFTS('ephemeral')).length).toBe(1);

			await deleteChat(chatId);

			expect(await searchMessagesFTS('ephemeral')).toEqual([]);
			expect(indexedCount()).toBe(0);
			integrityCheck();
		});

		test('diacritic-folded matches are kept, not dropped', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'we met at the café downtown')], chatId);

			// FTS folds diacritics so this matches, but a literal indexOf would not
			const results = await searchMessagesFTS('cafe');
			expect(results.length).toBe(1);
			expect(results[0].snippet).toContain('caf');
		});

		test('rebuildFTS repairs a partially built index on init', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'alpha one'), msg('user', 'beta two')], chatId);

			// Drop one row from the index only — a crash mid-rebuild looks like this
			const row = rawSqlite.prepare(`SELECT id, content FROM messages WHERE content LIKE '%alpha%'`).get() as any;
			rawSqlite.prepare(`INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', ?1, ?2)`).run(row.id, row.content);
			expect(await searchMessagesFTS('alpha')).toEqual([]);
			expect(indexedCount()).toBe(1);

			// The count mismatch is what initDatabase checks to trigger a rebuild
			await rebuildFTS();
			expect((await searchMessagesFTS('alpha')).length).toBe(1);
			expect((await searchMessagesFTS('beta')).length).toBe(1);
			integrityCheck();
		});

		test('rebuildFTS backfills an empty index', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'backfilled content')], chatId);

			// Simulate a DB that predates the FTS table
			rawSqlite.exec(`INSERT INTO messages_fts(messages_fts) VALUES('delete-all')`);
			expect(indexedCount()).toBe(0);
			expect(await searchMessagesFTS('backfilled')).toEqual([]);

			await rebuildFTS();
			expect((await searchMessagesFTS('backfilled')).length).toBe(1);
			integrityCheck();
		});
	});

	// ── Message count ──────────────────────────────────────────────────

	describe('Message count', () => {
		test('counts standalone chat messages', async () => {
			const chatId = await createChat('Test');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], chatId);

			expect(await getMessageCount(chatId)).toBe(2);
		});

		test('counts fork messages: copied plus its own', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')], parentId);

			const forkId = await forkChat(parentId, 1); // copies A, B
			await append(forkId, msg('assistant', 'D'));

			expect(await getMessageCount(forkId)).toBe(3);
		});

		test('fork count ignores later parent deletions', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 2);
			await deleteMessageRow(messages[1]._dbId!);

			expect(await getMessageCount(forkId)).toBe(3);
			expect(await getMessageCount(parentId)).toBe(2);
		});
	});

	// ── Chat metadata ────────────────────────────────────────────────────

	describe('Chat metadata', () => {
		const sampleMeta: ChatMeta = {
			macros: { '{{user}}': 'Alice' },
			configName: 'Fantasy RP',
			cut: 5,
			theme: 'fantasy',
			tools: { search_lore: true, random_number: false },
			model: 'claude-sonnet-4-20250514',
			provider: 'or',
			loreId: 'abc123',
		};

		test('saveChatMeta + loadChatMeta roundtrip', async () => {
			const chatId = await createChat('Test');
			await saveChatMeta(sampleMeta, chatId);

			const loaded = await loadChatMeta(chatId);
			expect(loaded).not.toBeNull();
			expect(loaded!.configName).toBe('Fantasy RP');
			expect(loaded!.macros).toEqual({ '{{user}}': 'Alice' });
			expect(loaded!.cut).toBe(5);
			expect(loaded!.theme).toBe('fantasy');
			expect(loaded!.tools).toEqual({ search_lore: true, random_number: false });
			expect(loaded!.model).toBe('claude-sonnet-4-20250514');
			expect(loaded!.loreId).toBe('abc123');
		});

		test('configName stored as queryable column', async () => {
			const id1 = await createChat('Chat 1');
			await saveChatMeta({ ...sampleMeta, configName: 'Fantasy RP' }, id1);

			const id2 = await createChat('Chat 2');
			await saveChatMeta({ ...sampleMeta, configName: 'Coding' }, id2);

			const id3 = await createChat('Chat 3');
			await saveChatMeta({ ...sampleMeta, configName: 'Fantasy RP' }, id3);

			const chat = await getChat(id1);
			expect(chat!.config_name).toBe('Fantasy RP');
		});

		test('loadChatMeta returns null for chat with no metadata', async () => {
			const chatId = await createChat('Empty');
			expect(await loadChatMeta(chatId)).toBeNull();
		});

		test('saveChatMeta overwrites previous metadata', async () => {
			const chatId = await createChat('Test');
			await saveChatMeta(sampleMeta, chatId);
			await saveChatMeta({ ...sampleMeta, configName: 'Coding', theme: 'modern' }, chatId);

			const loaded = await loadChatMeta(chatId);
			expect(loaded!.configName).toBe('Coding');
			expect(loaded!.theme).toBe('modern');
		});

		test('createChat with configName and meta', async () => {
			const { configName, ...rest } = sampleMeta;
			const chatId = await createChat('Test', 'Fantasy RP', JSON.stringify(rest));

			const chat = await getChat(chatId);
			expect(chat!.config_name).toBe('Fantasy RP');

			const loaded = await loadChatMeta(chatId);
			expect(loaded!.configName).toBe('Fantasy RP');
			expect(loaded!.theme).toBe('fantasy');
		});

		test('duplicateChat copies metadata', async () => {
			const chatId = await createChat('Original');
			await saveChatMeta(sampleMeta, chatId);
			await saveChatMessages([msg('user', 'hello')], chatId);

			const copyId = await duplicateChat(chatId);
			const copyMeta = await loadChatMeta(copyId);
			expect(copyMeta).not.toBeNull();
			expect(copyMeta!.configName).toBe('Fantasy RP');
			expect(copyMeta!.theme).toBe('fantasy');
			expect(copyMeta!.macros).toEqual({ '{{user}}': 'Alice' });
		});

		test('duplicates and forks leave the draft behind', async () => {
			const chatId = await createChat('Original');
			await saveChatMeta({ ...sampleMeta, draft: { text: 'unsent', images: [], files: [], role: 'user' } }, chatId);
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], chatId);

			const copyMeta = await loadChatMeta(await duplicateChat(chatId));
			const forkMeta = await loadChatMeta(await forkChat(chatId, 1));
			expect(copyMeta!.theme).toBe('fantasy');
			expect(copyMeta!.draft).toBeUndefined();
			expect(forkMeta!.draft).toBeUndefined();
			expect((await loadChatMeta(chatId))!.draft?.text).toBe('unsent');
		});

		test('forkChat copies metadata', async () => {
			const parentId = await createChat('Parent');
			await saveChatMeta(sampleMeta, parentId);
			const messages = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1);
			const forkMeta = await loadChatMeta(forkId);
			expect(forkMeta).not.toBeNull();
			expect(forkMeta!.configName).toBe('Fantasy RP');
			expect(forkMeta!.theme).toBe('fantasy');
		});

		test('loadChatMeta uses current chat when no id given', async () => {
			const chatId = await createChat('Current');
			await saveChatMeta(sampleMeta, chatId);

			// chatId is current (createChat sets it)
			const loaded = await loadChatMeta();
			expect(loaded!.configName).toBe('Fantasy RP');
		});
	});

	// ── setCurrentChatId ──────────────────────────────────────────────

	describe('setCurrentChatId', () => {
		test('persists and is returned by getCurrentChatId', async () => {
			const id1 = await createChat('A');
			const id2 = await createChat('B');

			// createChat sets current to id2
			expect(await getCurrentChatId()).toBe(id2);

			setCurrentChatId(id1);
			expect(await getCurrentChatId()).toBe(id1);
		});
	});

	// ── Implicit chatId (no argument) ─────────────────────────────────

	describe('Implicit chatId via getCurrentChatId', () => {
		test('saveChatMessages and loadChatMessages use current chat', async () => {
			await createChat('Current');
			await saveChatMessages([msg('user', 'implicit save')]);

			const loaded = await loadChatMessages();
			expect(loaded.length).toBe(1);
			expect(loaded[0].content[0]).toBe('implicit save');
		});

		test('saveDirtyChatMessages uses current chat', async () => {
			await createChat('Current');
			const messages = [msg('user', 'A')];
			await saveChatMessages(messages);

			messages[0] = { ...messages[0], content: ['A-edited'] };
			await saveDirtyChatMessages([0], messages);

			const loaded = await loadChatMessages();
			expect(loaded[0].content[0]).toBe('A-edited');
		});
	});

	// ── Empty chat edge cases ─────────────────────────────────────────

	describe('Empty chat operations', () => {
		test('loadChatMessages on empty chat returns []', async () => {
			const chatId = await createChat('Empty');
			expect(await loadChatMessages(chatId)).toEqual([]);
		});

		test('getMessageCount on empty chat returns 0', async () => {
			const chatId = await createChat('Empty');
			expect(await getMessageCount(chatId)).toBe(0);
		});

		test('duplicateChat of empty chat', async () => {
			const chatId = await createChat('Empty');
			const copyId = await duplicateChat(chatId);

			expect(await loadChatMessages(copyId)).toEqual([]);
			expect(await getMessageCount(copyId)).toBe(0);
		});
	});

	// ── Batch overflow (>60 rows) ────────────────────────────────────

	describe('Batch insert overflow', () => {
		test('saving >60 messages works across batch boundary', async () => {
			const chatId = await createChat('Big');
			const count = 70;
			const messages = Array.from({ length: count }, (_, i) => msg('user', `msg-${i}`));

			await saveChatMessages(messages, chatId);

			// All _dbIds assigned and contiguous
			for (let i = 0; i < count; i++) {
				expect(messages[i]._dbId).toBeDefined();
			}
			// Contiguous ids
			for (let i = 1; i < count; i++) {
				expect(messages[i]._dbId).toBe(messages[i - 1]._dbId! + 1);
			}

			// Roundtrip
			const loaded = await loadChatMessages(chatId);
			expect(loaded.length).toBe(count);
			expect(loaded[0].content[0]).toBe('msg-0');
			expect(loaded[69].content[0]).toBe('msg-69');
		});
	});

	// ── Duplicate of a forked chat ───────────────────────────────────

	describe('Duplicate of forked chat', () => {
		test('duplicating a fork copies all its messages and drops the fork link', async () => {
			const parentId = await createChat('Parent');
			const parentMsgs = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(parentMsgs, parentId);

			const forkId = await forkChat(parentId, 1); // copies A, B
			await append(forkId, msg('assistant', 'D'));

			const copyId = await duplicateChat(forkId);
			const copy = await getChat(copyId);

			expect(copy!.parent_id).toBeNull();
			expect(copy!.fork_message_id).toBeNull();
			expect(await texts(copyId)).toEqual(['A', 'B', 'D']);

			const copyMsgs = await loadChatMessages(copyId);
			expect(copyMsgs[0]._dbId).not.toBe(parentMsgs[0]._dbId);
		});
	});

	// ── Pointer forks become copies (forkMigration.ts) ──────────────────

	describe('Pointer-fork migration', () => {
		const migrate = () => rawSqlite.exec(FORK_MIGRATION_SQL);
		const userVersion = () => (rawSqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

		/** A chat as the pointer model stored it: only its own messages, borrowing the parent's up to `ceiling`. */
		async function legacyFork(parentId: string, ceiling: number, own: ChatMessage[]): Promise<string> {
			const id = await createChat('Legacy fork');
			rawSqlite.prepare('UPDATE chats SET parent_id = ?, fork_message_id = ? WHERE id = ?').run(parentId, ceiling, id);
			await saveChatMessages(own, id);
			return id;
		}

		const dbIds = (ms: ChatMessage[]) => ms.map(m => m._dbId!);
		const storedIdx = (chatId: string) =>
			(rawSqlite.prepare('SELECT idx FROM messages WHERE chat_id = ? ORDER BY idx').all(chatId) as { idx: number }[]).map(r => r.idx);

		test('copies borrowed messages in front of the fork\'s own', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(parent, parentId);
			const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('assistant', 'D'), msg('user', 'E')]);

			migrate();

			expect(await texts(forkId)).toEqual(['A', 'B', 'D', 'E']);
			expect(await texts(parentId)).toEqual(['A', 'B', 'C']);
			const fork = await getChat(forkId);
			expect(fork!.parent_id).toBe(parentId);
			expect(fork!.fork_message_id).toBe(parent[1]._dbId!);
			const forkIds = dbIds(await loadChatMessages(forkId));
			expect(forkIds.filter(i => dbIds(parent).includes(i))).toEqual([]);
			expect(storedIdx(forkId)).toEqual([0, 1, 2, 3]);
		});

		test('resolves chains, applying the lowest ceiling met on the way up', async () => {
			const gpId = await createChat('Grandparent');
			const gp = [msg('user', 'g0'), msg('assistant', 'g1'), msg('user', 'g2')];
			await saveChatMessages(gp, gpId);

			// p borrows g0 g1; its own messages follow
			const pId = await legacyFork(gpId, gp[1]._dbId!, [msg('assistant', 'p0'), msg('user', 'p1')]);
			const pOwn = await loadChatMessages(pId);
			// c forks p inside p's own messages, d forks gp directly
			const cId = await legacyFork(pId, pOwn[0]._dbId!, [msg('assistant', 'c0')]);
			const dId = await legacyFork(gpId, gp[0]._dbId!, [msg('assistant', 'd0')]);
			// e forks c: three levels deep
			const cOwn = await loadChatMessages(cId);
			const eId = await legacyFork(cId, cOwn[0]._dbId!, [msg('user', 'e0')]);

			migrate();

			expect(await texts(pId)).toEqual(['g0', 'g1', 'p0', 'p1']);
			// g2 sits past p's ceiling, so it never reaches c even though c's own ceiling is higher
			expect(await texts(cId)).toEqual(['g0', 'g1', 'p0', 'c0']);
			expect(await texts(dId)).toEqual(['g0', 'd0']);
			expect(await texts(eId)).toEqual(['g0', 'g1', 'p0', 'c0', 'e0']);
		});

		test('skips borrowed messages deleted since, boundary included', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(parent, parentId);
			const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('assistant', 'D')]);
			await deleteMessageRow(parent[1]._dbId!);

			migrate();

			expect(await texts(forkId)).toEqual(['A', 'D']);
		});

		test('renumbers own messages that were stored with gaps', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(parent, parentId);
			const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('user', 'C'), msg('assistant', 'D')]);
			rawSqlite.prepare('UPDATE messages SET idx = idx + 3 WHERE chat_id = ?').run(forkId);

			migrate();

			expect(storedIdx(forkId)).toEqual([0, 1, 2, 3]);
			expect(await texts(forkId)).toEqual(['A', 'B', 'C', 'D']);
		});

		test('handles forks with nothing left to borrow or nothing of their own', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(parent, parentId);
			const emptied = await legacyFork(parentId, parent[0]._dbId!, [msg('user', 'own')]);
			const bare = await legacyFork(parentId, parent[1]._dbId!, []);
			await deleteMessageRow(parent[0]._dbId!);

			migrate();

			expect(await texts(emptied)).toEqual(['own']);
			expect(await texts(bare)).toEqual(['B']);
		});

		test('leaves sub-agent chats alone, whatever their parent is', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(parent, parentId);
			const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('user', 'C')]);
			const underParent = await createChat('Agent 1', undefined, undefined, false, parentId);
			const underFork = await createChat('Agent 2', undefined, undefined, false, forkId);
			await saveChatMessages([msg('user', 'task 1')], underParent);
			await saveChatMessages([msg('user', 'task 2'), msg('assistant', 'done')], underFork);

			migrate();

			expect(await texts(underParent)).toEqual(['task 1']);
			expect(await texts(underFork)).toEqual(['task 2', 'done']);
			expect((await getChat(underParent))!.fork_message_id).toBeNull();
			expect((await getChat(underFork))!.fork_message_id).toBeNull();
			expect((await getChat(underFork))!.parent_id).toBe(forkId);
			expect(await texts(forkId)).toEqual(['A', 'B', 'C']);
		});

		test('does nothing without pointer forks, and cleans up after itself', async () => {
			const a = await createChat('A');
			await saveChatMessages([msg('user', 'one'), msg('assistant', 'two')], a);
			const before = rawSqlite.prepare('SELECT * FROM messages ORDER BY id').all();

			migrate();

			expect(rawSqlite.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before);
			expect(rawSqlite.prepare('SELECT name FROM sqlite_temp_master').all()).toEqual([]);
		});

		test('keeps the full-text index in step with the copies', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'needle here'), msg('assistant', 'B')];
			await saveChatMessages(parent, parentId);
			const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('user', 'other needle')]);

			migrate();

			// Same hit count as rows: the index has every copy (search then folds them)
			const indexed = rawSqlite.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'needle'").get() as { n: number };
			expect(indexed.n).toBe(3);
			rawSqlite.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
			const results = await searchMessagesFTS('needle');
			expect(results.map(r => [r.chatId, r.copies])).toEqual([[parentId, 1], [forkId, undefined]]);
		});

		test('marks borrowed rows with the row they were copied from, own rows with nothing', async () => {
			const gpId = await createChat('Grandparent');
			const gp = [msg('user', 'g0'), msg('assistant', 'g1')];
			await saveChatMessages(gp, gpId);
			const pId = await legacyFork(gpId, gp[1]._dbId!, [msg('user', 'p0')]);
			const p0 = (await loadChatMessages(pId))[0]._dbId!;
			const cId = await legacyFork(pId, p0, [msg('user', 'c0')]);

			migrate();

			const origins = (chatId: string) =>
				(rawSqlite.prepare('SELECT origin_id FROM messages WHERE chat_id = ? ORDER BY idx').all(chatId) as { origin_id: number | null }[]).map(r => r.origin_id);
			expect(origins(pId)).toEqual([...dbIds(gp), null]);
			expect(origins(cId)).toEqual([...dbIds(gp), p0, null]);
			expect(origins(gpId)).toEqual([null, null]);
		});

		test('sets the version marker, and a second run changes nothing', async () => {
			const parentId = await createChat('Parent');
			const parent = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(parent, parentId);
			const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('user', 'C')]);
			expect(userVersion()).toBe(0);

			migrate();
			expect(userVersion()).toBe(1);
			const after = rawSqlite.prepare('SELECT * FROM messages ORDER BY id').all();

			migrate();

			expect(rawSqlite.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(after);
			expect(await texts(forkId)).toEqual(['A', 'B', 'C']);
		});

		test('forks made after the conversion are not mistaken for pointer forks', async () => {
			const parentId = await createChat('Parent');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], parentId);
			migrate();
			const forkId = await forkChat(parentId, 1);

			migrate();

			expect(await texts(forkId)).toEqual(['A', 'B']);
		});

		describe('materializeForks', () => {
			test('only records the version when nothing needs converting', async () => {
				await createChat('Plain');
				let snapshots = 0;

				await materializeForks(async () => { snapshots++; });

				expect(snapshots).toBe(0);
				expect(userVersion()).toBe(1);
			});

			test('snapshots before touching anything, then converts once', async () => {
				const parentId = await createChat('Parent');
				const parent = [msg('user', 'A'), msg('assistant', 'B')];
				await saveChatMessages(parent, parentId);
				const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('user', 'C')]);
				const seen: string[][] = [];

				await materializeForks(async () => { seen.push(await texts(forkId)); });
				await materializeForks(async () => { seen.push(['again']); });

				expect(seen).toEqual([['C']]); // saw the unconverted fork, and only ran once
				expect(await texts(forkId)).toEqual(['A', 'B', 'C']);
			});

			test('a failing snapshot does not stop the conversion', async () => {
				const parentId = await createChat('Parent');
				const parent = [msg('user', 'A')];
				await saveChatMessages(parent, parentId);
				const forkId = await legacyFork(parentId, parent[0]._dbId!, [msg('user', 'C')]);

				await materializeForks(async () => { throw new Error('no space'); });

				expect(await texts(forkId)).toEqual(['A', 'C']);
			});

			test('a failure rolls everything back and the next run can succeed', async () => {
				const parentId = await createChat('Parent');
				const parent = [msg('user', 'A'), msg('assistant', 'B')];
				await saveChatMessages(parent, parentId);
				const forkId = await legacyFork(parentId, parent[1]._dbId!, [msg('user', 'C')]);
				// Fails when the script's last write is prepared, after it has already moved the
				// fork's own rows (a prepare-time error, because bun:sqlite's exec swallows
				// runtime errors in all but the last statement of a script)
				rawSqlite.exec('ALTER TABLE messages DROP COLUMN origin_id');

				await expect(materializeForks()).rejects.toThrow('origin_id');

				expect(userVersion()).toBe(0);
				expect(await texts(forkId)).toEqual(['C']);
				expect(storedIdx(forkId)).toEqual([0]);
				expect(rawSqlite.prepare('SELECT name FROM sqlite_temp_master').all()).toEqual([]);

				rawSqlite.exec('ALTER TABLE messages ADD COLUMN origin_id INTEGER');
				await materializeForks();

				expect(await texts(forkId)).toEqual(['A', 'B', 'C']);
			});
		});
	});

	// ── Optimistic concurrency ───────────────────────────────────────

	describe('Optimistic concurrency', () => {
		test('new chat starts at version 0', async () => {
			const id = await createChat('V');
			expect((await getChat(id))!.version).toBe(0);
		});

		test('saveChatMessages bumps version and returns it', async () => {
			const id = await createChat('V');
			const v = await saveChatMessages([msg('user', 'A')], id);
			expect(v).toBe(1);
			expect((await getChat(id))!.version).toBe(1);
		});

		test('saveChatMeta does NOT bump version', async () => {
			const id = await createChat('V');
			const v = await saveChatMeta({ configName: 'X' } as ChatMeta, id);
			expect(v).toBeUndefined();
			expect((await getChat(id))!.version).toBe(0);
		});

		test('saveDirtyChatMessages bumps version and returns it', async () => {
			const id = await createChat('V');
			const v = await saveDirtyChatMessages([0], [msg('user', 'A')], id);
			expect(v).toBe(1);
			expect((await getChat(id))!.version).toBe(1);
		});

		test('saveDirtyChatMessages with no indices is a no-op and returns expected version', async () => {
			const id = await createChat('V');
			const v = await saveDirtyChatMessages([], [], id, 5);
			expect(v).toBe(5);
			expect((await getChat(id))!.version).toBe(0);
		});

		test('saveChatMeta does not interact with message version counter', async () => {
			const id = await createChat('V');
			const v1 = await saveChatMessages([msg('user', 'A')], id, 0);
			expect(v1).toBe(1);
			await saveChatMeta({ configName: 'X' } as ChatMeta, id);
			// Version unchanged — meta saves are invisible to concurrency
			expect((await getChat(id))!.version).toBe(1);
		});

		test('stale expectedVersion throws ConcurrencyError and writes nothing', async () => {
			const id = await createChat('V');
			await saveChatMessages([msg('user', 'A')], id); // version → 1

			// A stale writer still thinks version is 0
			let threw: unknown;
			try {
				await saveChatMessages([msg('user', 'CLOBBER')], id, 0);
			} catch (e) { threw = e; }

			expect(threw).toBeInstanceOf(ConcurrencyError);
			expect((threw as any).code).toBe('CONFLICT');
			// Original content survived, version unchanged
			const loaded = await loadChatMessages(id);
			expect(loaded.map(m => m.content[0])).toEqual(['A']);
			expect((await getChat(id))!.version).toBe(1);
		});

		test('meta saves are last-write-wins (no concurrency rejection)', async () => {
			const id = await createChat('V');
			await saveChatMeta({ configName: 'first' } as ChatMeta, id);
			await saveChatMeta({ configName: 'second' } as ChatMeta, id);
			expect((await loadChatMeta(id))!.configName).toBe('second');
			expect((await getChat(id))!.version).toBe(0); // no version involvement
		});

		test('stale dirty-message write throws without clobbering', async () => {
			const id = await createChat('V');
			await saveChatMessages([msg('user', 'A'), msg('assistant', 'B')], id); // version → 1

			let threw: unknown;
			try {
				await saveDirtyChatMessages([1], [msg('user', 'A'), msg('assistant', 'CLOBBER')], id, 0);
			} catch (e) { threw = e; }

			expect(threw).toBeInstanceOf(ConcurrencyError);
			const loaded = await loadChatMessages(id);
			expect(loaded.map(m => m.content[0])).toEqual(['A', 'B']);
		});

		test('saveChatMeta does NOT touch updated or version', async () => {
			const id = await createChat('V');
			const before = (await getChat(id))!.updated;
			await new Promise(r => setTimeout(r, 2));
			await saveChatMeta({ configName: 'X' } as ChatMeta, id);
			const after = await getChat(id);
			expect(after!.version).toBe(0);
			expect(after!.updated).toBe(before);
		});

		test('saveChatMessages bumps both version and updated', async () => {
			const id = await createChat('V');
			const before = (await getChat(id))!.updated;
			await new Promise(r => setTimeout(r, 2));
			await saveChatMessages([msg('user', 'A')], id);
			expect((await getChat(id))!.updated).toBeGreaterThan(before);
		});

		test('deleteMessageRow bumps owning chat version and updated', async () => {
			const id = await createChat('V');
			const messages = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(messages, id); // version → 1
			const before = (await getChat(id))!.updated;
			await new Promise(r => setTimeout(r, 2));

			// Without chatId it resolves the owning chat from the message row
			const v = await deleteMessageRow(messages[1]._dbId!);
			expect(v).toBe(2);
			const after = await getChat(id);
			expect(after!.version).toBe(2);
			expect(after!.updated).toBeGreaterThan(before);
		});

		test('deleteMessageRow honors expectedVersion and rejects stale deletes', async () => {
			const id = await createChat('V');
			const messages = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(messages, id); // version → 1

			expect(deleteMessageRow(messages[1]._dbId!, id, 0)).rejects.toBeInstanceOf(ConcurrencyError);
			// Message survived the rejected delete
			expect((await loadChatMessages(id)).length).toBe(2);
		});

		test('two sequential views: stale one loses, fresh one wins', async () => {
			const id = await createChat('V');
			// View A and B both load version 0
			let vA = (await getChat(id))!.version;
			let vB = (await getChat(id))!.version;

			// A writes successfully
			vA = await saveChatMessages([msg('user', 'from-A')], id, vA);
			expect(vA).toBe(1);

			// B (still at version 0) is now stale
			expect(saveChatMessages([msg('user', 'from-B')], id, vB)).rejects.toBeInstanceOf(ConcurrencyError);
		});
	});

	describe('Tags', () => {
		const folderMeta = (chatFolder: string): ChatMeta => ({
			macros: {}, configName: 'Default', cut: -1, theme: 'fantasy',
			tools: {}, model: 'test-model', provider: 'or', loreId: 'lore', chatFolder,
		});
		test('setChatTags replaces tags, trimming and folding case duplicates', async () => {
			const id = await createChat('Tagged');
			await setChatTags(id, [' Story ', 'story', 'beta']);
			let chat = (await listChats()).find(c => c.id === id)!;
			expect(chat.tags.sort()).toEqual(['Story', 'beta']);

			await setChatTags(id, ['only']);
			chat = (await listChats()).find(c => c.id === id)!;
			expect(chat.tags).toEqual(['only']);
			expect((await getChat(id))!.tags).toEqual(['only']); // getChat carries them too
		});

		test('deleteChat cascades tags', async () => {
			const id = await createChat('Doomed');
			await setChatTags(id, ['x']);
			await deleteChat(id);
			const rows = rawSqlite.prepare('SELECT count(*) AS c FROM chat_tags WHERE chat_id = ?').get(id) as any;
			expect(rows.c).toBe(0);
		});

		test('duplicateChat and forkChat copy tags', async () => {
			const id = await createChat('Src');
			await saveChatMessages([msg('user', 'hello')], id);
			await setChatTags(id, ['one', 'two']);
			const dup = await duplicateChat(id);
			expect((await listChats()).find(c => c.id === dup)!.tags.sort()).toEqual(['one', 'two']);

			const fork = await forkChat(id, 0);
			expect((await listChats()).find(c => c.id === fork)!.tags.sort()).toEqual(['one', 'two']);
		});

		test('tagFolder tags every chat in the folder, unfoldered with empty string, idempotently', async () => {
			const a1 = await createChat('A1');
			const a2 = await createChat('A2');
			const b1 = await createChat('B1');
			for (const [id, folder] of [[a1, '/a'], [a2, '/a'], [b1, '']] as const)
				await saveChatMeta(folderMeta(folder as string), id);

			expect(await tagFolder('/a', 'Project')).toBe(2);
			expect(await tagFolder('/a', 'project')).toBe(0); // NOCASE dedupe, no dup rows
			expect(await tagFolder('', 'Loose')).toBe(1); // only b1, folder chats untouched

			const byId = new Map((await listChats()).map(c => [c.id, c.tags]));
			expect(byId.get(a1)).toEqual(['Project']);
			expect(byId.get(b1)).toEqual(['Loose']);
		});

		test('renameTag renames everywhere; deleteTag removes everywhere', async () => {
			const c1 = await createChat('C1');
			const c2 = await createChat('C2');
			await setChatTags(c1, ['old', 'keep']);
			await setChatTags(c2, ['OLD']);

			expect(await renameTag('old', 'new name')).toBe(2);
			let byId = new Map((await listChats()).map(c => [c.id, c.tags]));
			expect(byId.get(c1)!.sort()).toEqual(['keep', 'new name']);
			expect(byId.get(c2)).toEqual(['new name']);

			// Renaming onto an existing tag merges, keeping the existing row's casing
			expect(await renameTag('new name', 'KEEP')).toBeGreaterThanOrEqual(0);
			byId = new Map((await listChats()).map(c => [c.id, c.tags]));
			expect(byId.get(c1)!.sort()).toEqual(['keep']); // merge keeps the pre-existing row
			expect(byId.get(c2)).toEqual(['KEEP']); // nothing to collide with — renamed as typed

			await deleteTag('keep');
			for (const chat of await listChats()) expect(chat.tags).toEqual([]);
		});

		test('searchMessagesFTS scopes by required and excluded tags', async () => {
			const c1 = await createChat('One');
			const c2 = await createChat('Two');
			const c3 = await createChat('Three');
			await saveChatMessages([msg('user', 'needle here')], c1);
			await saveChatMessages([msg('user', 'needle here')], c2);
			await saveChatMessages([msg('user', 'needle here')], c3);
			await setChatTags(c1, ['Fantasy']);
			await setChatTags(c2, ['Fantasy', 'wip']);
			await setChatTags(c3, ['scifi']);

			const names = (r: Awaited<ReturnType<typeof searchMessagesFTS>>) =>
				r.map(x => x.chatName).sort();

			expect(names(await searchMessagesFTS('needle'))).toEqual(['One', 'Three', 'Two']);
			expect(names(await searchMessagesFTS('needle', { tags: ['fantasy'] }))).toEqual(['One', 'Two']); // NOCASE
			expect(names(await searchMessagesFTS('needle', { tags: ['Fantasy', 'wip'] }))).toEqual(['Two']); // AND
			expect(names(await searchMessagesFTS('needle', { tags: [] }))).toEqual([]); // empty scope matches nothing
			expect(names(await searchMessagesFTS('needle', { excludeTags: ['wip'] }))).toEqual(['One', 'Three']);
			expect(names(await searchMessagesFTS('needle', { tags: ['fantasy'], excludeTags: ['wip'] }))).toEqual(['One']);
			expect(names(await searchMessagesFTS('needle', { folders: [''], tags: ['scifi'] }))).toEqual(['Three']); // facets compose (Three has no folder)
		});
	});
});
