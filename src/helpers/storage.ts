import { ChatMessage } from './types';
import { unwrap, SetStoreFunction } from 'solid-js/store';
import { createSignal, batch } from 'solid-js';
import type { Setter } from 'solid-js';
import { setupAutosaveFile, writeAutosave, readAutosave } from './platform';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Ensures all required fields have defaults - apply to any message entering the system */
export function normalizeMessage(msg: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage {
	return {
		currentVersionIndex: 0,
		...msg,
	} as ChatMessage;
}

/** Migrate standalone tool messages into the preceding assistant message's tool_results array */
export function migrateToolResults(messages: ChatMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === 'tool' && msg.tool_call_id?.[0]) {
			const toolCallId = msg.tool_call_id[0];
			let migrated = false;

			// Find the nearest preceding assistant message with matching tool_calls
			for (let j = result.length - 1; j >= 0; j--) {
				if (result[j].role !== 'assistant' || !result[j].tool_calls) continue;

				for (let v = 0; v < result[j].tool_calls!.length; v++) {
					if (result[j].tool_calls![v]?.some(tc => tc.id === toolCallId)) {
						if (!result[j].tool_results) result[j].tool_results = [];
						while (result[j].tool_results!.length <= v) result[j].tool_results!.push([]);
						result[j].tool_results![v].push({
							tool_call_id: toolCallId,
							name: (msg as ChatMessage & { name?: string }).name || '',
							content: msg.content[0] || ''
						});
						migrated = true;
						break;
					}
				}
				break;
			}

			if (migrated) continue;
		}

		result.push(msg);
	}

	return result;
}

const DB_NAME = 'SreamChatDB';
const DB_VERSION = 3;
const INDIVIDUAL_MESSAGES_STORE = 'individual_messages';
const ATTACHMENTS_STORE = 'attachments';
const LOCAL_STORAGE_KEY = 'solid_chat_messages';

interface StoredMessage extends ChatMessage {
	id: string;
	timestamp: number;
	messageIndex: number;
}



class MessageStorage {
	private db: IDBDatabase | null = null;
	private initPromise: Promise<void> | null = null;
	private messageCount: number = 0;

	async init(): Promise<void> {
		if (this.initPromise) return this.initPromise;


		this.initPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onerror = () => {
				console.error('Failed to open IndexedDB:', request.error);
				reject(request.error);
			};

			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// Create individual messages store for efficient updates
				if (!db.objectStoreNames.contains(INDIVIDUAL_MESSAGES_STORE)) {
					const store = db.createObjectStore(INDIVIDUAL_MESSAGES_STORE, { keyPath: 'id' });
					store.createIndex('timestamp', 'timestamp', { unique: false });
					store.createIndex('messageIndex', 'messageIndex', { unique: true });
				}

				// Image attachments, keyed by the ids messages carry in `images`
				if (!db.objectStoreNames.contains(ATTACHMENTS_STORE))
					db.createObjectStore(ATTACHMENTS_STORE, { keyPath: 'id' });
			};
		});

		return this.initPromise;
	}

	async saveDirtyMessages(indices: number[], messages: ChatMessage[]): Promise<void> {
		if (indices.length === 0) return;

		await this.init();
		if (!this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([INDIVIDUAL_MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(INDIVIDUAL_MESSAGES_STORE);

			transaction.oncomplete = () => resolve();
			transaction.onerror = () => {
				console.error('Failed to save dirty messages:', transaction.error);
				reject(transaction.error);
			};

			for (const index of indices) {
				const msgAtIndex = messages[index];
				if (msgAtIndex !== undefined) {
					const msg = unwrap(msgAtIndex);
					store.put({
						...msg,
						id: `msg_${index}`,
						timestamp: Date.now(),
						messageIndex: index
					} as StoredMessage);
				} else {
					store.delete(`msg_${index}`);
				}
			}
		});
	}

	async saveMessages(messages: ChatMessage[]): Promise<void> {
		await this.init();

		if (!this.db) throw new Error('Database not initialized');

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([INDIVIDUAL_MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(INDIVIDUAL_MESSAGES_STORE);

			transaction.oncomplete = () => {
				this.messageCount = messages.length;
				resolve();
			};
			transaction.onerror = () => {
				console.error('Failed to save messages to IndexedDB:', transaction.error);
				reject(transaction.error);
			};

			const countRequest = store.count();
			countRequest.onsuccess = () => {
				if (countRequest.result > 100 && messages.length === 15) {
					resolve();
					return;
				}

				const clearRequest = store.clear();
				clearRequest.onsuccess = () => {
					for (let index = 0; index < messages.length; index++) {
						const unwrappedMessage = unwrap(messages[index]);
						store.put({
							...unwrappedMessage,
							id: `msg_${index}`,
							timestamp: Date.now(),
							messageIndex: index
						} as StoredMessage);
					}
				};
				clearRequest.onerror = () => {
					console.error('Failed to clear messages in IndexedDB:', clearRequest.error);
					reject(clearRequest.error);
				};
			};
		});
	}

	async loadMessages(): Promise<ChatMessage[]> {
		await this.init();

		if (!this.db) {
			throw new Error('Database not initialized');
		}

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([INDIVIDUAL_MESSAGES_STORE], 'readonly');
			const store = transaction.objectStore(INDIVIDUAL_MESSAGES_STORE);
			const index = store.index('messageIndex');
			const request = index.getAll();

			request.onsuccess = () => {
				const storedMessages = request.result as StoredMessage[];

				storedMessages.sort((a, b) => a.messageIndex - b.messageIndex);

				const messages = storedMessages.map(stored => {
					const { id, timestamp, messageIndex, ...message } = stored;

					return normalizeMessage(message);
				});

				this.messageCount = messages.length;
				resolve(messages);
			};

			request.onerror = () => {
				console.error('Failed to load messages from IndexedDB:', request.error);
				reject(request.error);
			};
		});
	}

	async saveAttachment(id: string, img: { mime: string; data: string }): Promise<void> {
		await this.init();
		if (!this.db) throw new Error('Database not initialized');

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([ATTACHMENTS_STORE], 'readwrite');
			transaction.objectStore(ATTACHMENTS_STORE).put({ id, ...img });
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	}

	async loadAttachment(id: string): Promise<{ mime: string; data: string } | null> {
		await this.init();
		if (!this.db) throw new Error('Database not initialized');

		return new Promise((resolve, reject) => {
			const request = this.db!.transaction([ATTACHMENTS_STORE], 'readonly')
				.objectStore(ATTACHMENTS_STORE).get(id);
			request.onsuccess = () => resolve(request.result ?? null);
			request.onerror = () => reject(request.error);
		});
	}

}

export const messageStorage = new MessageStorage();

export async function saveMessages(messages: ChatMessage[], onError?: Setter<string | null>): Promise<void> {
	if (isTauri) {
		try {
			const { initDatabase, saveChatMessages } = await import('./db');
			await initDatabase();
			await saveChatMessages(messages);
		} catch (error) {
			const msg = 'SQLite save failed: ' + (error instanceof Error ? error.message : String(error));
			console.error(msg, error);
			onError?.(msg);
		}
		return;
	}

	try {
		await messageStorage.saveMessages(messages);
	} catch (error) {
		const msg = 'IndexedDB save failed, falling back to localStorage: ' + (error instanceof Error ? error.message : String(error));
		console.warn(msg, error);
		onError?.(msg);
		try {
			// Try to save a subset of messages to localStorage
			const recentMessages = messages.slice(-1500); // Keep only last 1500 messages
			localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(recentMessages));
		} catch (localStorageError) {
			const fallbackMsg = 'Both IndexedDB and localStorage save failed: ' + (localStorageError instanceof Error ? localStorageError.message : String(localStorageError));
			console.error(fallbackMsg, localStorageError);
			onError?.(fallbackMsg);
		}
	}
}

export async function loadMessages(onError?: Setter<string | null>): Promise<ChatMessage[]> {
	if (isTauri) {
		try {
			const { initDatabase, migrateFromIndexedDB, loadChatMessages } = await import('./db');
			await initDatabase();

			// On first launch, migrate IndexedDB data to SQLite
			const migrated = await migrateFromIndexedDB();
			if (migrated.length > 0) return migrated;

			return await loadChatMessages();
		} catch (error) {
			const msg = 'SQLite load failed: ' + (error instanceof Error ? error.message : String(error));
			console.error(msg, error);
			onError?.(msg);
			return [];
		}
	}

	try {
		return await messageStorage.loadMessages();
	} catch (error) {
		const msg = 'IndexedDB load failed, falling back to localStorage: ' + (error instanceof Error ? error.message : String(error));
		console.warn(msg, error);
		onError?.(msg);

		try {
			const storedMessages = localStorage.getItem(LOCAL_STORAGE_KEY);
			if (!storedMessages) return [];

			const parsed = JSON.parse(storedMessages);
			return migrateToolResults(parsed);
		} catch (localStorageError) {
			const fallbackMsg = 'Both IndexedDB and localStorage load failed: ' + (localStorageError instanceof Error ? localStorageError.message : String(localStorageError));
			console.error(fallbackMsg, localStorageError);
			onError?.(fallbackMsg);
			return [];
		}
	}
}


/**
 * Persist dirty messages. On Tauri, `expectedVersion` enables optimistic
 * concurrency: returns the chat's new version, or re-throws a ConcurrencyError
 * (code 'CONFLICT') if another view wrote first. Web build ignores versioning.
 */
export async function saveDirtyMessages(indices: number[], messages: ChatMessage[], onError?: Setter<string | null>, expectedVersion?: number, chatId?: string): Promise<number | undefined> {
	if (indices.length === 0) return expectedVersion;

	if (isTauri) {
		try {
			const { initDatabase, saveDirtyChatMessages } = await import('./db');
			await initDatabase();
			return await saveDirtyChatMessages(indices, messages, chatId, expectedVersion);
		} catch (error) {
			if ((error as any)?.code === 'CONFLICT') throw error; // let the caller reconcile
			const msg = 'SQLite incremental update failed: ' + (error instanceof Error ? error.message : String(error));
			console.warn(msg, error);
			onError?.(msg);
			return expectedVersion;
		}
	}

	try {
		await messageStorage.saveDirtyMessages(indices, messages);
	} catch (error) {
		const msg = 'IndexedDB incremental update failed: ' + (error instanceof Error ? error.message : String(error));
		console.warn(msg, error);
		onError?.(msg);
	}
	return undefined;
}

/**
 * Delete a single message by its stable SQLite row id. No-op on web.
 * Like saveDirtyMessages, threads `expectedVersion` for optimistic concurrency:
 * returns the chat's new version, or re-throws a ConcurrencyError on a race.
 */
export async function deleteMessageById(dbId: number, onError?: Setter<string | null>, chatId?: string, expectedVersion?: number): Promise<number | undefined> {
	if (!isTauri) return expectedVersion;
	try {
		const { initDatabase, deleteMessageRow } = await import('./db');
		await initDatabase();
		return await deleteMessageRow(dbId, chatId, expectedVersion);
	} catch (error) {
		if ((error as any)?.code === 'CONFLICT') throw error; // let the caller reconcile
		const msg = 'SQLite delete failed: ' + (error instanceof Error ? error.message : String(error));
		console.warn(msg, error);
		onError?.(msg);
		return expectedVersion;
	}
}

/** Two-stage load: show last 15 messages immediately, defer full list until after paint */
export function stagedSetMessages(messages: ChatMessage[], setMessages: SetStoreFunction<ChatMessage[]>, onComplete?: () => void) {
	if (messages.length > 100) {
		const msgList = document.querySelector('.messageList');
		setMessages(messages.slice(-15));
		if (msgList) msgList.scrollTop = msgList.scrollHeight;

		requestAnimationFrame(() => requestAnimationFrame(() => {
			batch(() => setMessages(messages));
			onComplete?.();
		}));
	} else {
		setMessages(messages);
		const msgList = document.querySelector('.messageList');
		if (msgList) msgList.scrollTop = msgList.scrollHeight;
		onComplete?.();
	}
}

export function createAutosave<T>(
	getData: () => T,
	suggestedName: string = 'autosave.json',
	description: string = 'JSON files',
	mimeType: string = 'application/json',
	extension: string = '.json',
	interval: number = 25000,
	serializer: (data: T) => string | Promise<string> = (data) => JSON.stringify(data, null, 2),
	deserializer: (content: string) => T = JSON.parse,
	onError?: (error: any) => void
) {
	const [fileHandle, setFileHandle] = createSignal<any | null>(null);
	const [isActive, setIsActive] = createSignal(false);
	let autoSaveInterval: number | null = null;

	async function setup() {
		try {
			const handle = await setupAutosaveFile(suggestedName);

			if (!handle) return; // user cancelled

			setFileHandle(handle);

			if (autoSaveInterval) {
				clearInterval(autoSaveInterval);
			}

			autoSaveInterval = setInterval(save, interval) as unknown as number;
			setIsActive(true);

			await save();
		} catch (error) {
			onError?.(error);
			throw error;
		}
	}

	async function save() {
		const handle = fileHandle();
		if (!handle) return;

		try {
			const data = getData();
			const cleanData = unwrap(data);
			const content = await serializer(cleanData);

			await writeAutosave(handle, content);
		} catch (error) {
			onError?.(error);
		}
	}

	async function load(): Promise<T | null> {
		const handle = fileHandle();
		if (!handle) return null;

		try {
			const content = await readAutosave(handle);
			return deserializer(content);
		} catch (error) {
			onError?.(error);
			return null;
		}
	}

	function stop() {
		if (autoSaveInterval) {
			clearInterval(autoSaveInterval);
			autoSaveInterval = null;
		}
		setFileHandle(null);
		setIsActive(false);
	}

	return {
		isActive,
		setup,
		stop,
		save,
		load
	};
}