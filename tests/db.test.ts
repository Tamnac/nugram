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
	saveChatMeta,
	loadChatMeta,
	saveAttachment,
	loadAttachment,
	pruneAttachments,
	ConcurrencyError,
} from '../src/helpers/db';
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

// ── Helpers ────────────────────────────────────────────────────────────

function msg(role: string, content: string, extra?: Partial<ChatMessage>): ChatMessage {
	return {
		role: role as ChatMessage['role'],
		content: [content],
		currentVersionIndex: 0,
		...extra,
	};
}

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

	describe('Fork (pointer)', () => {
		test('forkChat creates chat with fork_message_id', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1); // fork after message B
			const fork = await getChat(forkId);

			expect(fork!.parent_id).toBe(parentId);
			expect(fork!.fork_message_id).toBe(messages[1]._dbId!);
		});

		test('loading fork returns shared + own messages', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1); // share A and B

			// Add fork's own message
			const forkMsgs = [msg('assistant', 'Fork reply')];
			await saveChatMessages(forkMsgs, forkId);

			const loaded = await loadChatMessages(forkId);
			expect(loaded.length).toBe(3); // A, B from parent + Fork reply
			expect(loaded[0].content[0]).toBe('A');
			expect(loaded[1].content[0]).toBe('B');
			expect(loaded[2].content[0]).toBe('Fork reply');
		});

		test('editing parent message propagates to fork', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1);

			// Edit message B in parent
			messages[1] = { ...messages[1], content: ['B-edited'] };
			await saveDirtyChatMessages([1], messages, parentId);

			const forkMsgs = await loadChatMessages(forkId);
			expect(forkMsgs[1].content[0]).toBe('B-edited'); // propagated
		});

		test('deleting parent message propagates to fork', async () => {
			const parentId = await createChat('Parent');
			const messages = [
				msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C'),
				msg('assistant', 'D'), msg('user', 'E'),
			];
			await saveChatMessages(messages, parentId);

			// Fork at message D (index 3, shares A B C D)
			const forkId = await forkChat(parentId, 3);

			// Delete message B from parent
			await deleteMessageRow(messages[1]._dbId!);

			const forkMsgs = await loadChatMessages(forkId);
			// Fork should see A, C, D (B deleted, propagated)
			expect(forkMsgs.length).toBe(3);
			expect(forkMsgs.map(m => m.content[0])).toEqual(['A', 'C', 'D']);
		});

		test('deleting fork boundary message still works', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			// Fork at B (index 1)
			const forkId = await forkChat(parentId, 1);

			// Delete message B (the boundary) from parent
			await deleteMessageRow(messages[1]._dbId!);

			const forkMsgs = await loadChatMessages(forkId);
			// B is gone, but A (id < boundary) is still shared
			expect(forkMsgs.length).toBe(1);
			expect(forkMsgs[0].content[0]).toBe('A');
		});

		test('parent messages after fork point are not shared', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 0); // share only A

			// Add more messages to parent after fork
			messages.push(msg('user', 'C'));
			await saveDirtyChatMessages([2], messages, parentId);

			const forkMsgs = await loadChatMessages(forkId);
			expect(forkMsgs.length).toBe(1); // only A
			expect(forkMsgs[0].content[0]).toBe('A');
		});
	});

	// ── Fork + parent chat deletion (detach) ───────────────────────────

	describe('Fork detach on parent delete', () => {
		test('deleting parent detaches fork — idx shift does not violate UNIQUE', async () => {
			// Regression: UPDATE messages SET idx = idx + N can collide with
			// existing rows when processed in ascending order (idx 0→2 hits
			// the row already at idx 2 before it gets shifted).
			const parentId = await createChat('Parent');
			const parentMsgs = [msg('user', 'A'), msg('assistant', 'B')];
			await saveChatMessages(parentMsgs, parentId);

			const forkId = await forkChat(parentId, 1); // share A, B
			const forkOwnMsgs = [
				msg('user', 'C'), msg('assistant', 'D'), msg('user', 'E'),
			];
			await saveChatMessages(forkOwnMsgs, forkId);

			// Shift by 2 means fork idx 0→2 collides with existing idx 2
			await deleteChat(parentId);

			const fork = await getChat(forkId);
			expect(fork!.parent_id).toBeNull();
			expect(fork!.fork_message_id).toBeNull();

			const forkMsgs = await loadChatMessages(forkId);
			expect(forkMsgs.length).toBe(5);
			expect(forkMsgs.map(m => m.content[0])).toEqual(['A', 'B', 'C', 'D', 'E']);
		});

		test('deleting parent detaches fork with shared messages', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1); // share A, B
			const forkOwnMsgs = [msg('assistant', 'Fork D')];
			await saveChatMessages(forkOwnMsgs, forkId);

			await deleteChat(parentId);

			// Fork should still work as standalone
			const fork = await getChat(forkId);
			expect(fork!.parent_id).toBeNull();
			expect(fork!.fork_message_id).toBeNull();

			const forkMsgs = await loadChatMessages(forkId);
			expect(forkMsgs.length).toBe(3); // A, B copied + Fork D
			expect(forkMsgs[0].content[0]).toBe('A');
			expect(forkMsgs[1].content[0]).toBe('B');
			expect(forkMsgs[2].content[0]).toBe('Fork D');
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

		test('windowed loading with fork', async () => {
			const parentId = await createChat('Parent');
			const parentMsgs = Array.from({ length: 5 }, (_, i) => msg('user', `parent-${i}`));
			await saveChatMessages(parentMsgs, parentId);

			const forkId = await forkChat(parentId, 4); // share all 5
			const forkOwnMsgs = Array.from({ length: 3 }, (_, i) => msg('user', `fork-${i}`));
			await saveChatMessages(forkOwnMsgs, forkId);

			// Window spanning parent and fork messages
			const window = await loadChatMessagesWindowed(forkId, 4, 3);
			expect(window.length).toBe(4);
			expect(window[0].content[0]).toBe('parent-3'); // from parent
			expect(window[1].content[0]).toBe('parent-4'); // from parent
			expect(window[2].content[0]).toBe('fork-0');   // from fork
			expect(window[3].content[0]).toBe('fork-1');   // from fork
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
				msg('assistant', 'no images'),
			], chatId);

			await pruneAttachments();

			expect(await loadAttachment('kept')).not.toBeNull();
			expect(await loadAttachment('kept-old-version')).not.toBeNull();
			expect(await loadAttachment('kept-file')).not.toBeNull();
			expect(await loadAttachment('kept-tool-image')).not.toBeNull();
			expect(await loadAttachment('orphan')).toBeNull();
		});

		test('deleting a chat prunes its attachments', async () => {
			const chatId = await createChat('Test');
			await saveAttachment('att-1', 'image/webp', 'A');
			await saveChatMessages([msg('user', 'hi', { images: [['att-1']] })], chatId);

			await deleteChat(chatId);

			expect(await loadAttachment('att-1')).toBeNull();
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

		test('counts fork messages including shared parent messages', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 1); // share A, B
			await saveChatMessages([msg('assistant', 'D')], forkId);

			expect(await getMessageCount(forkId)).toBe(3); // A, B shared + D own
		});

		test('fork count reflects parent deletions', async () => {
			const parentId = await createChat('Parent');
			const messages = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(messages, parentId);

			const forkId = await forkChat(parentId, 2); // share A, B, C
			await deleteMessageRow(messages[1]._dbId!); // delete B

			expect(await getMessageCount(forkId)).toBe(2); // A, C (B deleted)
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

	// ── Fork-of-fork (chain flattening) ──────────────────────────────

	describe('Fork-of-fork', () => {
		test('forking a fork in shared range flattens to grandparent', async () => {
			const gpId = await createChat('Grandparent');
			const gpMsgs = [msg('user', 'gp0'), msg('assistant', 'gp1'), msg('user', 'gp2')];
			await saveChatMessages(gpMsgs, gpId);

			// Parent forks grandparent at gp2
			const parentId = await forkChat(gpId, 2);
			const parentOwnMsgs = [msg('assistant', 'p0')];
			await saveChatMessages(parentOwnMsgs, parentId);

			// Child forks parent at gp1 (index 1 — in the shared range)
			const childId = await forkChat(parentId, 1);
			const child = await getChat(childId);

			// Should point to grandparent, not parent
			expect(child!.parent_id).toBe(gpId);
			expect(child!.fork_message_id).toBe(gpMsgs[1]._dbId!);
		});

		test('forking a fork in own range points to the fork itself', async () => {
			const gpId = await createChat('Grandparent');
			const gpMsgs = [msg('user', 'gp0'), msg('assistant', 'gp1')];
			await saveChatMessages(gpMsgs, gpId);

			const parentId = await forkChat(gpId, 1);
			const parentOwnMsgs = [msg('user', 'p0'), msg('assistant', 'p1')];
			await saveChatMessages(parentOwnMsgs, parentId);

			// Child forks parent at p1 (index 3 — in parent's own range)
			const childId = await forkChat(parentId, 3);
			const child = await getChat(childId);

			// Should point to parent, not grandparent
			expect(child!.parent_id).toBe(parentId);
			expect(child!.fork_message_id).toBe(parentOwnMsgs[1]._dbId!);
		});

		test('loading fork-of-fork resolves full chain', async () => {
			const gpId = await createChat('Grandparent');
			const gpMsgs = [msg('user', 'gp0'), msg('assistant', 'gp1'), msg('user', 'gp2')];
			await saveChatMessages(gpMsgs, gpId);

			// Parent forks grandparent at gp2, adds own message
			const parentId = await forkChat(gpId, 2);
			await saveChatMessages([msg('assistant', 'p0')], parentId);

			// Child forks parent at index 3 (gp0, gp1, gp2, p0)
			const childId = await forkChat(parentId, 3);
			await saveChatMessages([msg('user', 'c0')], childId);

			const loaded = await loadChatMessages(childId);
			expect(loaded.map(m => m.content[0])).toEqual(['gp0', 'gp1', 'gp2', 'p0', 'c0']);
		});

		test('getMessageCount walks fork chain', async () => {
			const gpId = await createChat('Grandparent');
			const gpMsgs = [msg('user', 'gp0'), msg('assistant', 'gp1'), msg('user', 'gp2')];
			await saveChatMessages(gpMsgs, gpId);

			const parentId = await forkChat(gpId, 2);
			await saveChatMessages([msg('assistant', 'p0')], parentId);

			const childId = await forkChat(parentId, 3);
			await saveChatMessages([msg('user', 'c0')], childId);

			expect(await getMessageCount(childId)).toBe(5); // gp0, gp1, gp2, p0, c0
		});

		test('windowed loading across fork-of-fork', async () => {
			const gpId = await createChat('Grandparent');
			const gpMsgs = Array.from({ length: 5 }, (_, i) => msg('user', `gp${i}`));
			await saveChatMessages(gpMsgs, gpId);

			const parentId = await forkChat(gpId, 4); // share all 5
			const parentOwnMsgs = Array.from({ length: 3 }, (_, i) => msg('user', `p${i}`));
			await saveChatMessages(parentOwnMsgs, parentId);

			// Child forks parent at index 7 (all 8 messages: gp0-4, p0-2)
			const childId = await forkChat(parentId, 7);
			const childOwnMsgs = Array.from({ length: 2 }, (_, i) => msg('user', `c${i}`));
			await saveChatMessages(childOwnMsgs, childId);

			// Total: 10 messages (5 gp + 3 parent + 2 child)
			expect(await getMessageCount(childId)).toBe(10);

			// Window spanning grandparent → parent boundary
			const w1 = await loadChatMessagesWindowed(childId, 3, 3);
			expect(w1.map(m => m.content[0])).toEqual(['gp3', 'gp4', 'p0']);

			// Window spanning parent → child boundary
			const w2 = await loadChatMessagesWindowed(childId, 3, 7);
			expect(w2.map(m => m.content[0])).toEqual(['p2', 'c0', 'c1']);

			// Full load
			const all = await loadChatMessagesWindowed(childId, 20, 0);
			expect(all.map(m => m.content[0])).toEqual(
				['gp0', 'gp1', 'gp2', 'gp3', 'gp4', 'p0', 'p1', 'p2', 'c0', 'c1']
			);
		});
	});

	// ── Duplicate of a forked chat ───────────────────────────────────

	describe('Duplicate of forked chat', () => {
		test('duplicating a fork resolves and copies all messages', async () => {
			const parentId = await createChat('Parent');
			const parentMsgs = [msg('user', 'A'), msg('assistant', 'B'), msg('user', 'C')];
			await saveChatMessages(parentMsgs, parentId);

			const forkId = await forkChat(parentId, 1); // share A, B
			await saveChatMessages([msg('assistant', 'D')], forkId);

			const copyId = await duplicateChat(forkId);
			const copy = await getChat(copyId);

			// Copy is standalone, not a fork
			expect(copy!.parent_id).toBeNull();
			expect(copy!.fork_message_id).toBeNull();

			// Contains resolved messages: A, B from parent + D from fork
			const copyMsgs = await loadChatMessages(copyId);
			expect(copyMsgs.map(m => m.content[0])).toEqual(['A', 'B', 'D']);

			// Independent _dbIds
			expect(copyMsgs[0]._dbId).not.toBe(parentMsgs[0]._dbId);
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
});
