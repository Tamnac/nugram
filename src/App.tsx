import { createSignal, Show, createEffect, onMount, onCleanup, batch } from 'solid-js';
import { createStore, SetStoreFunction } from 'solid-js/store'
import { Sidebar } from './sidebar';
import { ChatView, focusInput } from './ChatView';
import { findSearchMessageIndex } from './helpers/search';

import { loadMessages, messageStorage, saveMessages } from './helpers/storage';
import { collectAttachmentRefs, ORPHAN_PRUNE_AGE, attachmentObjectUrl } from './helpers/attachments';
import { isTauri, setExportScope, hasPendingNativeDialog, confirmDialog } from './helpers/platform';
import { pushNav, removeNav, replaceNav, restoreNav, syncNav } from './helpers/navHistory';
import type { Chat } from './helpers/db';
import * as dbModule from './helpers/db';
import { loadFromStorage, playSound } from './helpers/Extras';
import { loadPools } from './helpers/tools/pools';
import { getLaunchFolder, getLaunchPrompt } from './helpers/platform';
import { broadcastWidgetTheme } from './helpers/widgets';
import { WidgetDock } from './helpers/WidgetDock';
import { DEFAULT_SKILL_DIRS, type SkillDirs } from './helpers/skills';
import { LoreEntry, loadLore } from './helpers/lore';
import { convertSTCard, type STCard } from './helpers/stImport';
import { DEFAULT_COMPACT_SETTINGS, type CompactSettings } from './helpers/compact';
import { runningAgents } from './helpers/agent';
import { updateSpawnAgentTool, tools as toolDefs } from './helpers/tools';
import { emptyDraft, userMacros, type ChatState } from './helpers/chatState';
import { createLiveChat, openedState, stateFromMeta, type LiveChat, type LiveChatDeps } from './helpers/liveChat';
import { registerSshBackends } from './helpers/backend';
import { setImageSource, restoreWebImageFolder } from './helpers/imageFolder';
const _promptFiles = import.meta.glob('../default-prompt.md', { query: '?raw', import: 'default', eager: true });
const defaultPrompt = (_promptFiles['../default-prompt.md'] as string) ?? '';
const ATTACHMENT_PRUNE_INTERVAL = 24 * 3_600_000;
const LAST_ATTACHMENT_PRUNE_KEY = 'last_attachment_prune';


// last $674
import type { cacheType, cacheLength, Prompt, Config, ToolApprove, ChatMeta, ChatMessage, BackgroundSettings, Provider, ProviderConfig, Options, ExtraBodyRule, AgentSettings, AgentPreset, TitlerSettings, SshBackendConfig } from './helpers/types';
import { DEFAULT_PROVIDERS, DEFAULT_AGENT_SETTINGS, DEFAULT_TITLER_SETTINGS, normalizeTheme } from './helpers/types';
import { generateTitle } from './helpers/titler';
import { startBackupService } from './helpers/backup';


// db.ts is statically imported (Tauri always hits the db path on startup, so
// lazy-loading just added a fetch/eval waterfall). getDb kept for call sites.
const getDb = async () => dbModule;


/** Migrate legacy single-string extra_body to the new per-rule array format. */
function migrateExtraBody(options: Options): Options {
	const extra = (options as any).extra_body;
	if (typeof extra !== 'string') return options;
	const rule: ExtraBodyRule = { providerPattern: '', modelPattern: '', body: extra };
	return { ...options, extra_body: [rule] };
}

function App() {
	const [error, _setError] = createSignal<string | null>(null);
	const [info, _setInfo] = createSignal<string | null>(null);

	const setError: typeof _setError = (v) => {
		const val = typeof v === 'function' ? (v as any)(error()) : v;
		if (val && !error() && (document.hidden || !document.hasFocus())) playSound('error');
		return _setError(v);
	};
	let infoTimer: ReturnType<typeof setTimeout> | undefined;
	const setInfo: typeof _setInfo = (v) => {
		const val = typeof v === 'function' ? (v as any)(info()) : v;
		if (val && !info() && (document.hidden || !document.hasFocus())) playSound('info');
		clearTimeout(infoTimer);
		if (val) infoTimer = setTimeout(() => _setInfo(null), 20_000);
		return _setInfo(v);
	};
	const [compactSettings, setCompactSettings] = createSignal<CompactSettings>({ ...DEFAULT_COMPACT_SETTINGS, ...loadFromStorage<Partial<CompactSettings>>("compact_settings", {}, true, setError) });
	const [textDrip, setTextDrip] = createSignal<boolean>(loadFromStorage<boolean>("text_drip", true, true, setError));
	const [sidebarOpen, setSidebarOpen] = createSignal<boolean>(loadFromStorage<boolean>("sidebar_open", true, true, setError));
	const [notifyMode, setNotifyMode] = createSignal<'off' | 'sound' | 'notification'>(loadFromStorage<'off' | 'sound' | 'notification'>("notify_mode", 'notification', true, setError));
	const [notifyUnfocused, setNotifyUnfocused] = createSignal<boolean>(loadFromStorage<boolean>("notify_unfocused", false, true, setError));
	
	// ── Config system ─────────────────────────────────────────────────────
	const defaultPrompts: Prompt[] = [
		{ name: "System", content: loadFromStorage<string>("prompt", defaultPrompt, true, setError), role: 'system', position: 0, enabled: true }
	];

	const { presets: legacyAgentPresets, ...initialAgentSettings } = loadFromStorage<AgentSettings & { presets?: AgentPreset[] }>(
		"agent_settings", DEFAULT_AGENT_SETTINGS, true, setError
	);
	const storedConfigs = loadFromStorage<Config[] | null>("configs", null, true, setError);
	const initialActiveConfigName = loadFromStorage<string>("activeConfig", storedConfigs?.[0]?.name ?? "Default", true, setError);

	// Migration: wrap existing prompts into a Default config if no configs key exists
	const ng = (n: number) => n < 0 ? 10000 + n : n;
	const initialConfigs: Config[] = (() => {
		if (storedConfigs && storedConfigs.length > 0) {
			// Sort each config's prompts by position on load
			for (const c of storedConfigs) c.prompts.sort((a, b) => ng(a.position) - ng(b.position));
			if (legacyAgentPresets?.length)
				for (const config of storedConfigs)
					if (config.agentPresets === undefined) config.agentPresets = structuredClone(legacyAgentPresets);
			return storedConfigs;
		}

		// Migrate from old "prompts" key
		const oldPrompts = loadFromStorage<Prompt[] | null>("prompts", null, true, setError);
		const prompts = (oldPrompts ?? defaultPrompts).sort((a, b) => ng(a.position) - ng(b.position));
		return [{ name: "Default", prompts, ...(legacyAgentPresets?.length ? { agentPresets: legacyAgentPresets } : {}) }];
	})();

	const loadedOptions = migrateExtraBody(
	loadFromStorage<Options>("options", {stream: true, usage: { include: true }}, true, setError)
);

	const [configs, setConfigs] = createStore<Config[]>(initialConfigs);

	const activeConfigIndex = () => {
		const idx = configs.findIndex(c => c.name === live().chat.configName);
		return idx >= 0 ? idx : 0;
	};

	// Proxy: downstream code keeps using prompts/setPrompts unchanged.
	// Methods are bound to the real store array so `this` works correctly.
	const prompts = new Proxy([] as Prompt[], {
		get(_target, prop) {
			const arr = configs[activeConfigIndex()]?.prompts;
			const val = (arr as any)?.[prop];
			if (typeof val === 'function') return val.bind(arr);
			return val;
		}
	}) as unknown as Prompt[];

	const setPrompts: SetStoreFunction<Prompt[]> = (...args: any[]) => {
		(setConfigs as any)(activeConfigIndex(), 'prompts', ...args);
	};
	const [cache, setCache] = createSignal<cacheType>(loadFromStorage<cacheType>("cache", 'smart', true, setError));
	const [cacheLength, setCacheLength] = createSignal<cacheLength>(loadFromStorage<cacheLength>("cache_length", '5m', true, setError));
	const [options, setOptions] = createStore<Options>(loadedOptions);
	const [lore, setLore] = createStore<LoreEntry[]>(loadLore(setError));

	const [skillDirs, setSkillDirs] = createSignal<SkillDirs>(
		loadFromStorage<SkillDirs>("skill_dirs", DEFAULT_SKILL_DIRS, true, setError)
	);

	// Named SSH tool hosts (global); ChatMeta.backend picks one per chat
	const [sshBackends, setSshBackends] = createStore<SshBackendConfig[]>(
		loadFromStorage<SshBackendConfig[]>("ssh_backends", [], true, setError)
	);

	// The last used chat settings, for the first chat on screen (web: the only one). See helpers/chatState.ts
	const initialChatState: ChatState = {
		configName: initialActiveConfigName,
		model: loadFromStorage<string>("model", "", true, setError),
		provider: loadFromStorage<Provider>("provider", "or", true, setError),
		macros: loadFromStorage<Record<string, string>>("macros", {}, true, setError),
		cut: loadFromStorage<number>("cut_index", -1, true, setError),
		theme: normalizeTheme(loadFromStorage<string>("theme", "modern", true, setError)),
		background: loadFromStorage<BackgroundSettings | undefined>("background", undefined, true, setError),
		sendMode: loadFromStorage<'loop' | 'single'>("send_mode", 'loop', true, setError),
		autoCompact: loadFromStorage<boolean>("auto_compact", false, true, setError),
		loreId: loadFromStorage<string>("lore_id", crypto.randomUUID().slice(0, 8), true, setError),
		chatFolder: loadFromStorage<string>("chat_folder", '', true, setError),
		backend: 'local',
		toolApprove: loadFromStorage<ToolApprove>("tool_approve", 'off', true, setError),
		toolApproveOutside: loadFromStorage<ToolApprove>("tool_approve_outside", 'off', true, setError),
		toolOverrides: loadFromStorage<Record<string, boolean>>("tool_overrides", {}, true, setError),
		draft: { ...emptyDraft(), text: loadFromStorage<string>("input_value", '', true, setError) },
	};

	const [agentSettings, setAgentSettings] = createSignal<AgentSettings>(initialAgentSettings);
	const [titlerSettings, setTitlerSettings] = createSignal<TitlerSettings>(
		loadFromStorage<TitlerSettings>("titler_settings", DEFAULT_TITLER_SETTINGS, true, setError)
	);
	const [providers, setProviders] = createSignal<Record<Provider, ProviderConfig>>((() => {
		const stored = loadFromStorage<Record<Provider, ProviderConfig> | null>("providers", null, true, setError);
		if (stored) return { ...DEFAULT_PROVIDERS, ...stored };

		// Migrate from old separate keys
		const oldKeys = loadFromStorage<Record<Provider, string> | null>("api_keys", null, true, setError);
		if (oldKeys) {
			const migrated = { ...DEFAULT_PROVIDERS };
			for (const p of Object.keys(oldKeys) as Provider[]) {
				if (migrated[p]) migrated[p] = { ...migrated[p], apiKey: oldKeys[p] };
			}
			return migrated;
		}
		return DEFAULT_PROVIDERS;
	})());

	const liveDeps: LiveChatDeps = {
		configs, toolNames: toolDefs.map(t => t.function.name),
		providers, options: () => options, cache, cacheLength, compactSettings,
		lore, setLore, skillDirs, agentSettings, textDrip,
		setError, setInfo, notify,
		onChatCreated: () => void refreshChatList(),
	};
	// The selected chat. Opening another replaces it (`replaceLive`), and ChatView is keyed on it
	const [live, setLive] = createSignal<LiveChat>(createLiveChat('', initialChatState, liveDeps));
	const currentChatId = () => live().id;

	// ── Chat management (Tauri only) ──────────────────────────────────
	const [chatList, setChatList] = createSignal<Chat[]>([]);

	function chatHistoryUrl(id: string) {
		const url = new URL(location.href);
		url.searchParams.set('chat', id);
		return `${url.pathname}${url.search}${url.hash}`;
	}

	function replaceChatHistory(id: string) {
		if (!isTauri || typeof history === 'undefined') return;
		replaceNav(id, chatHistoryUrl(id));
	}

	function pushChatHistory(id: string) {
		if (!isTauri || typeof history === 'undefined') return;
		pushNav(id, chatHistoryUrl(id));
	}


	if (isTauri) {
		onCleanup(startBackupService());

		// Tauri: pick this view's chat (?chat=<id> wins over the last-opened chat, enabling independent chats per window), then load it.
		(async () => {
			const db = await getDb();
			await db.initDatabase();

			// Reclaim old orphans at most daily across normal app launches.
			const pruneStarted = Date.now();
			const lastPrune = Number(localStorage.getItem(LAST_ATTACHMENT_PRUNE_KEY)) || 0;
			if (pruneStarted - lastPrune >= ATTACHMENT_PRUNE_INTERVAL) {
				localStorage.setItem(LAST_ATTACHMENT_PRUNE_KEY, String(pruneStarted));
				db.pruneAttachments(ORPHAN_PRUNE_AGE).catch(err => {
					if (localStorage.getItem(LAST_ATTACHMENT_PRUNE_KEY) === String(pruneStarted))
						localStorage.removeItem(LAST_ATTACHMENT_PRUNE_KEY);
					console.warn('Attachment prune failed', err);
				});
			}

			// First-launch migration from IndexedDB takes precedence.
			const migrated = await db.migrateFromIndexedDB();
			let chatId: string;
			let msgs: ChatMessage[];
			let pinned = false;

			const launchFolder = await getLaunchFolder();
			const launchPrompt = await getLaunchPrompt();
			if (launchFolder || launchPrompt) { // started via cli
				setChatList(await db.listChats());
				const created = await handleCreateChat(launchFolder ?? undefined);
				if (launchPrompt && created) {
					created.setChat('draft', 'text', launchPrompt);
					created.session.sendMessage(-1);
				}

			} else {
				if (migrated.length > 0) {
					chatId = await db.getCurrentChatId();
					msgs = migrated;
				} else {
					const requested = new URLSearchParams(location.search).get('chat');
					if (requested && await db.getChat(requested)) {
						chatId = requested;
						pinned = true;
						db.setCurrentChatId(chatId, false); // don't save chatId when passed in url
					} else {
						chatId = await db.getCurrentChatId();
					}
					msgs = await db.loadChatMessages(chatId);
				}

				const [meta, row, chats] = await Promise.all([
					db.loadChatMeta(chatId),
					db.getChat(chatId),
					db.listChats(),
				]);
				// Rebuilds the saved back/forward stack, minus any chats deleted since.
				if (typeof history !== 'undefined')
					restoreNav(chatId, id => chats.some(c => c.id === id), chatHistoryUrl, pinned);

				// One pass: effects (e.g. auto-title) must never observe messages
				// paired with an empty chat list.
				batch(() => {
					setChatList(chats);
					openLive(chatId, meta, msgs, row?.version ?? 0);
				});
			}
		})()
			.catch(err => {
				const msg = 'Failed to load chat: ' + (err instanceof Error ? err.message : String(err));
				console.error(msg, err);
				setError(msg);
			});
	} else {
		loadMessages(setError)
			.then(loaded => {
				live().session.load(loaded, 0);
				void restoreWebImageFolder();
				// Reclaim attachments orphaned by deleted messages/versions.
				collectAttachmentRefs(loaded)
					.then(keep => {
						const bg = live().chat.background?.image;
						if (bg) keep.add(bg);
						return messageStorage.pruneAttachments(keep, ORPHAN_PRUNE_AGE);
					})
					.catch(err => console.warn('Attachment prune failed', err));
			})
			.catch(error => {
				const msg = 'Failed to load messages: ' + (error instanceof Error ? error.message : String(error));
				console.error(msg, error);
				setError(msg);
			});
	}

	// Auto-close sidebar on narrow screens on initial load
	if (typeof window !== 'undefined' && window.innerWidth <= 900)
		setSidebarOpen(false);

	// Add global handlder for unhandled promise rejections
	onMount(() => {
		void loadPools(); // background: @@topic/@@word macro data, off the critical path
		const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
			if (event.reason instanceof DOMException && event.reason.name === 'AbortError') {
				event.preventDefault(); // Prevent the error from appearing in console
				return;
			}
		};

			const handlePopState = (e: PopStateEvent) => {
			if (!isTauri) return;
			syncNav(e.state);
			const requested = new URLSearchParams(location.search).get('chat');
			if (!requested || requested === currentChatId()) return;
			switchChat(requested, false);
		};

		// WebView2 delivers mouse side buttons and Alt+arrows as BrowserBack/Forward keys
		const handleNavKeys = (e: KeyboardEvent) => {
			if (!isTauri || live().session.isLoading()) return;
			if (e.key === 'BrowserBack' || (e.altKey && e.key === 'ArrowLeft')) {
				e.preventDefault();
				history.back();
			} else if (e.key === 'BrowserForward' || (e.altKey && e.key === 'ArrowRight')) {
				e.preventDefault();
				history.forward();
			}
		};

		window.addEventListener('unhandledrejection', handleUnhandledRejection);
		window.addEventListener('popstate', handlePopState);
		window.addEventListener('keydown', handleNavKeys);

		onCleanup(() => {
			window.removeEventListener('unhandledrejection', handleUnhandledRejection);
			window.removeEventListener('popstate', handlePopState);
			window.removeEventListener('keydown', handleNavKeys);
		});
	});

	const save = (key: string, value: any) => {
		if (value === null || value === undefined) {
			localStorage.removeItem(key);
			return;
		}
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch (err) {
			const msg = `Failed to save ${key} to localStorage: ` + (err instanceof Error ? err.message : String(err));
			console.error(msg, err);
			setError(msg);
		}
	};

	/** Meta inherited from the last chat in `folder`, excluding Cut. Returns undefined if no other chat exists in folder. */
	function inheritMeta(sourceChat: Chat): Partial<ChatMeta> | undefined {
		if (!sourceChat) return undefined;

		const meta: Partial<ChatMeta> = {};
		if (sourceChat.config_name) meta.configName = sourceChat.config_name;
		if (sourceChat.meta) {
			try { Object.assign(meta, JSON.parse(sourceChat.meta)); }
			catch (e) { console.warn('Failed to parse source chat meta:', e); }
		}
		// backend lives in its own column, not the meta blob (see saveChatMeta)
		if (sourceChat.backend) meta.backend = sourceChat.backend;

		// cut points and drafts are per-conversation, not folder-level
		delete meta.cut;
		delete meta.draft;
		meta.chatFolder = sourceChat.chat_folder || '';
		return meta;
	}

	/** Change the current chat's folder, inheriting meta from the most recent chat in
	 *  that folder (mirroring the "new chat in folder" flow). With no prior chat there,
	 *  only the folder is changed. */
	function handleSetChatFolder(folder: string) {
		const l = live();
		const source = chatList()
			.filter(c => c.id !== l.id && (c.chat_folder || '') === folder && (c.backend || 'local') === l.chat.backend)
			.sort((a, b) => b.updated - a.updated)[0];
		const inherited = source ? inheritMeta(source) : undefined;
		if (inherited) l.applyChatMeta(inherited);
		else l.setChat('chatFolder', folder);
		if (isTauri) void l.flush().then(refreshChatList);
	}

	/**
	 * Make `id` the selected chat. The previous one is disposed, so flush it first to keep its
	 * changes. `imageFolder` undefined keeps the current image folder.
	 */
	function replaceLive(id: string, state: ChatState, messages: ChatMessage[], version: number, imageFolder?: string | null): LiveChat {
		live().dispose();
		if (isTauri && imageFolder !== undefined) setImageSource(imageFolder ? { kind: 'path', path: imageFolder } : null);
		const next = createLiveChat(id, state, liveDeps);
		next.session.load(messages, version);
		setLive(next);
		return next;
	}

	/** Select a chat loaded from the db. */
	function openLive(id: string, meta: ChatMeta | null, messages: ChatMessage[], version: number) {
		return replaceLive(id, openedState(live().chat, meta, liveDeps), messages, version, meta ? meta.imageFolder ?? null : undefined);
	}

	// ── Chat switching (Tauri only) ──────────────────────────────────

	async function refreshChatList() {
		if (!isTauri) return;
		try {
			const db = await getDb();
			setChatList(await db.listChats());
		} catch (err) {
			console.error('Failed to refresh chat list:', err);
		}
	}

	/** Re-load the current chat from the db, discarding local unsaved edits. */
	async function reloadCurrentChat() {
		if (!isTauri) return;
		try {
			await live().reload();
			await refreshChatList();
		} catch (err) {
			setError('Failed to reload chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function switchChat(newId: string, addHistory = true, scrollToDbId?: number) {
		const jumpToSearchMessage = () => {
			const l = live();
			if (scrollToDbId !== undefined)
				l.view?.scrollToMessage(findSearchMessageIndex(l.session.messages, scrollToDbId));
		};
		if (newId === currentChatId()) {
			// Already here — a search result still wants the jump
			jumpToSearchMessage();
			return;
		}
		if (live().session.isLoading()) return setInfo('Stop generation before switching chats');
		try {
			const db = await getDb();
			setInfo('');
			setError('');
			if (!await db.getChat(newId)) {
				removeNav(newId);
				return setError('Chat not found');
			}

			await live().flush();

			db.setCurrentChatId(newId);
			if (addHistory) pushChatHistory(newId);

			const [msgs, meta, row] = await Promise.all([
				db.loadChatMessages(newId),
				db.loadChatMeta(newId),
				db.getChat(newId),
			]);
			openLive(newId, meta, msgs, row?.version ?? 0);

			await refreshChatList();
			// Let the new list render before looking for the target element
			if (scrollToDbId !== undefined)
				requestAnimationFrame(() => {
					if (currentChatId() === newId) jumpToSearchMessage();
				});
		} catch (err) {
			setError('Failed to switch chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	/** Global content search for the sidebar (Tauri only — FTS lives in SQLite). */
	async function handleSearchMessages(query: string, folders?: string[], tags?: string[], excludeTags?: string[]) {
		try {
			// Unsaved edits in the open chat aren't in the index yet
			await live().flush();
			return await (await getDb()).searchMessagesFTS(query, { folders, tags, excludeTags });
		} catch (err) {
			setError('Search failed: ' + (err instanceof Error ? err.message : String(err)));
			return [];
		}
	}

	/** New chat, set up like the selected one or, given a folder, like the last chat there. */
	async function handleCreateChat(folder?: string, resetConfig = false): Promise<LiveChat | undefined> {
		const prev = live();
		if (prev.session.isLoading()) return;
		try {
			const db = await getDb();
			await prev.flush();

			let state: ChatState = { ...prev.chat, cut: -1, draft: emptyDraft() };
			let imageFolder: string | null | undefined;
			let inheritedTags: string[] | undefined;
			if (!resetConfig && folder !== undefined) {
				const source = chatList()
					.filter(c => (c.chat_folder || '') === folder && (c.backend || 'local') === prev.chat.backend)
					.sort((a, b) => b.updated - a.updated)[0];
				const inherited = inheritMeta(source) ?? { chatFolder: folder };
				state = stateFromMeta(state, inherited, liveDeps);
				imageFolder = inherited.imageFolder ?? null;
				inheritedTags = source?.tags;
			}
			if (resetConfig) state = {
				...state,
				configName: configs.find(config => /default/i.test(config.name))?.name ?? configs[0]?.name ?? state.configName,
				chatFolder: '',
				toolOverrides: {},
			};

			const newId = await db.createChat('New Chat');
			const next = replaceLive(newId, state, [], 0, imageFolder);
			if (inheritedTags && inheritedTags.length > 0) await db.setChatTags(newId, inheritedTags);

			// Persist inherited meta so chat list grouping is correct immediately
			await next.flush();
			await refreshChatList();
			pushChatHistory(newId);
			focusInput();
			return next;
		} catch (err) {
			setError('Failed to create chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	/** Loads imported messages, into a new chat when the open one has messages (desktop). Returns whether it imported. */
	async function handleImport(messages: ChatMessage[], meta?: Partial<ChatMeta>): Promise<boolean> {
		let l = live();
		if (l.session.isLoading()) {
			setInfo('Stop generation before importing');
			return false;
		}
		if (isTauri && l.session.messages.length > 0) {
			const created = await handleCreateChat();
			if (!created) return false;
			l = created;
		}
		l.session.setMessages(messages);
		l.view?.onMessagesLoaded();
		// applyChatMeta resets whatever `meta` lacks, so keep this chat's own settings under it
		if (meta) l.applyChatMeta({ ...l.getChatMeta(), ...meta });
		// An unversioned write would leave the session's chat version stale and trip its conflict check
		if (isTauri) await l.flush();
		else void saveMessages(messages);
		return true;
	}

	/** A character card: a new config for the character, its lore entries added, and its greeting as the chat. */
	async function handleImportCard(card: STCard) {
		if (live().session.isLoading()) {
			setInfo('Stop generation before importing');
			return;
		}
		if (!isTauri && live().session.messages.length > 0 && !await confirmDialog('Importing a character replaces the current chat with its greeting. Continue?')) return;

		const { config, chat, lore: cardLore } = convertSTCard(card, live().chat.macros.user);
		let name = config.name;
		for (let i = 1; configs.some(c => c.name === name); i++) name = `${config.name} (${i})`;
		setConfigs(configs.length, { ...config, name });

		const loreNames = new Set(lore.map(e => e.name));
		const newLore = cardLore.filter(e => !loreNames.has(e.name));
		if (newLore.length) setLore(prev => [...prev, ...newLore]);

		if (!await handleImport(chat.messages, { configName: name, macros: { ...live().chat.macros, ...chat.macros } })) return;
		setInfo(`Imported "${card.name}" as config "${name}" with ${config.prompts.length} prompts${newLore.length ? ` and ${newLore.length} lore entries` : ''}. It has only the character: add roleplay rules as another prompt.`);
	}

	async function handleDeleteChat(id: string) {
		const l = live();
		if (l.session.isLoading()) return;
		try {
			const db = await getDb();
			await db.deleteChat(id);

			if (id === l.id) {
				// No save, the chat is gone: stop its pending writes now
				l.dispose();

				const newId = await db.getCurrentChatId();
				db.setCurrentChatId(newId);
				replaceChatHistory(newId);

				const [msgs, meta, row] = await Promise.all([
					db.loadChatMessages(newId),
					db.loadChatMeta(newId),
					db.getChat(newId),
				]);
				openLive(newId, meta, msgs, row?.version ?? 0);
			}

			await refreshChatList();
		} catch (err) {
			setError('Failed to delete chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function handleRenameChat(id: string, name: string) {
		try {
			const db = await getDb();
			await db.renameChat(id, name);
			await refreshChatList();
		} catch (err) {
			setError('Failed to rename chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	// ── Tags (Tauri only) ────────────────────────────────────────────

	async function handleSetChatTags(id: string, tags: string[]) {
		try {
			await (await getDb()).setChatTags(id, tags);
			await refreshChatList();
		} catch (err) {
			setError('Failed to set tags: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function handleTagFolder(folder: string, tag: string) {
		try {
			await (await getDb()).tagFolder(folder, tag);
			await refreshChatList();
		} catch (err) {
			setError('Failed to tag chats: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function handleRenameTag(from: string, to: string) {
		try {
			await (await getDb()).renameTag(from, to);
			await refreshChatList();
		} catch (err) {
			setError('Failed to rename tag: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function handleDeleteTag(tag: string) {
		try {
			await (await getDb()).deleteTag(tag);
			await refreshChatList();
		} catch (err) {
			setError('Failed to remove tag: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	// Tracks chats we've already auto-titled this session so we don't retry while
	// the chat list name is still stale mid-generation.
	const autoTitled = new Set<string>();

	async function handleGenerateTitle(id: string, auto = false): Promise<boolean> {
		const settings = titlerSettings();
		if (!settings.model.trim() && !auto) { 
			setInfo('Configure a titler model in settings first');
			 return false; 
		}
		try {
			const db = await getDb();
			const l = live();
			if (id === l.id) await l.flush();
			const msgs = id === l.id ? l.session.messages : await db.loadChatMessages(id);
			if (!msgs.length) { if (!auto) setInfo('Nothing to title yet'); return false; }
			const title = await generateTitle({ messages: msgs, settings, providers: providers() });
			if (!title) { setInfo('Titler returned an empty title'); return false; }
			await db.renameChat(id, title);
			await refreshChatList();
			return true;
		} catch (err) {
			setError('Failed to generate title: ' + (err instanceof Error ? err.message : String(err)));
			return false;
		}
	}

	// Auto-title once a chat crosses the configured message count, while it still
	// has the default name. Runs after streaming settles.
	if (isTauri) createEffect(() => {
		const n = titlerSettings().autoAfter;
		const { id, session } = live();
		if (n <= 0 || session.messages.length < n || session.isLoading()) return;
		if (autoTitled.has(id)) return;
		// No list entry yet means the chat list hasn't loaded — never title on a
		// guess; the effect re-runs once chatList lands.
		const entry = chatList().find(c => c.id === id);
		if (!entry || entry.name !== 'New Chat') return;
		autoTitled.add(id); // reserve before the async call to prevent re-entry
		handleGenerateTitle(id, true).then(ok => { if (!ok) autoTitled.delete(id); }); // allow retry on failure
	});

	async function handleDuplicateChat(id: string) {
		if (live().session.isLoading()) return setInfo('Stop generation before duplicating');
		try {
			const db = await getDb();
			// Persist current chat state so the copy reflects unsaved edits
			if (id === currentChatId()) await live().flush();
			const newId = await db.duplicateChat(id);
			await refreshChatList();
			await switchChat(newId);
		} catch (err) {
			setError('Failed to duplicate chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function handleForkChat(index: number) {
		if (!isTauri) return;
		if (live().session.isLoading()) return setInfo('Stop generation before forking');
		try {
			const db = await getDb();
			// Persist current chat so the fork boundary references saved messages
			await live().flush();
			const newId = await db.forkChat(currentChatId(), index);
			await refreshChatList();
			await switchChat(newId);
		} catch (err) {
			setError('Failed to fork chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}


	createEffect(() => save("configs", configs));
	createEffect(() => setExportScope(currentChatId()));
	createEffect(() => save("activeConfig", live().chat.configName));
	createEffect(() => save("options", options));
	createEffect(() => save("model", live().chat.model));
	createEffect(() => save("cut_index", live().chat.cut));
	createEffect(() => save("lore_entries", lore));
	createEffect(() => save("cache", cache()));
	createEffect(() => save("cache_length", cacheLength()));
	createEffect(() => save("provider", live().chat.provider));
	createEffect(() => save("theme", live().chat.theme));
	createEffect(() => save("background", live().chat.background && { ...live().chat.background }));
	createEffect(() => save("text_drip", textDrip()));
	createEffect(() => save("sidebar_open", sidebarOpen()));
	createEffect(() => save("notify_mode", notifyMode()));
	createEffect(() => save("notify_unfocused", notifyUnfocused()));
	createEffect(() => save("providers", providers()));
	// Derived macros are re-scanned on load, so only hand-written ones are stored
	createEffect(() => save("macros", userMacros(live().chat.macros)));
	createEffect(() => save("skill_dirs", skillDirs()));
	createEffect(() => save("lore_id", live().chat.loreId));
	createEffect(() => save("chat_folder", live().chat.chatFolder));
	createEffect(() => {
		// Snapshot out of the store proxy; the spreads keep this tracking fields
		const list = sshBackends.map(b => ({ ...b }));
		registerSshBackends(list);
		save("ssh_backends", list);
	});
	createEffect(() => save("tool_approve", live().chat.toolApprove));
	createEffect(() => save("tool_approve_outside", live().chat.toolApproveOutside));
	// Desktop keeps drafts in each chat's meta
	createEffect(() => { if (!isTauri) save("input_value", live().chat.draft.text); });
	createEffect(() => { if (!isTauri) save("tool_overrides", { ...live().chat.toolOverrides }); });
	createEffect(() => { if (!isTauri) save("send_mode", live().chat.sendMode); });
	createEffect(() => { if (!isTauri) save("auto_compact", live().chat.autoCompact); });
	createEffect(() => save("compact_settings", compactSettings()));
	createEffect(() => {
		save("agent_settings", agentSettings());
		updateSpawnAgentTool(agentSettings()); // keep the spawn_agent model tiers in sync
	});
	createEffect(() => save("titler_settings", titlerSettings()));

	createEffect(() => {
		const name = chatList().find(c => c.id === currentChatId())?.name || 'Nugram';
		document.title = name;
		// Tauri doesn't sync the native window title to document.title changes.
		if (isTauri) import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(name)).catch(err => console.error('setTitle failed:', err));
	});

	if (isTauri) {
		// Safety net: flush on page unload
		const handleUnload = () => {
			const l = live();
			// Deny any pending permission so applyToolCalls can finish and write a result
			l.denyPermissions('Edit denied: application closed');
			navigator.sendBeacon?.('about:blank', ''); // keep event loop alive briefly
			l.saveMetaNow().catch(() => {});
			// Drop this instance's presence mark so a restore elsewhere isn't blocked
			// by a window that's already gone (the TTL is only a fallback).
			getDb().then(db => db.endSession()).catch(() => {});
		};
		window.addEventListener('beforeunload', handleUnload);
		onCleanup(() => window.removeEventListener('beforeunload', handleUnload));

		// On regaining focus, refresh the chat list and pull in external changes
		// (another view edited this same chat) when we have nothing pending.
		const handleFocus = () => {
			const { id, session } = live();
			if (session.chatConflict() || hasPendingNativeDialog()) return;
			refreshChatList();
			if (!session.isLoading() && !session.hasPendingWrites()) {
				getDb().then(async db => {
					const row = await db.getChat(id);
					if (row && row.version !== session.version() && currentChatId() === id) await reloadCurrentChat();
				}).catch(() => {});
			}
		};
		window.addEventListener('focus', handleFocus);
		onCleanup(() => window.removeEventListener('focus', handleFocus));
	}

	// Ctrl+N: new chat, Ctrl+Shift+N: new chat on the default config
	onMount(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!e.ctrlKey || e.key.toLowerCase() !== 'n') return;
			e.preventDefault();
			if (e.shiftKey) handleCreateChat(undefined, true);
			else handleCreateChat();
		};

		document.addEventListener('keydown', handleKeyDown);

		onCleanup(() => document.removeEventListener('keydown', handleKeyDown));
	});

	// Apply theme to body element, and hand it to the widgets already on screen
	createEffect(() => {
		document.body.setAttribute('data-theme', live().chat.theme);
		broadcastWidgetTheme();
	});

	// Apply the per-chat background as CSS vars (consumed by .top::before in index.css)
	createEffect(() => {
		const bg = live().chat.background;
		const style = document.body.style;
		style.setProperty('--chat-bg-dim', String(bg?.dim ?? 0));
		style.setProperty('--chat-bg-blur', `${bg?.blur ?? 0}px`);
		style.removeProperty('--chat-bg'); // clear eagerly so a stale image isn't shown with new dim/blur
		if (!bg) return;

		let stale = false;
		onCleanup(() => { stale = true; });
		void attachmentObjectUrl(bg.image).then(url => {
			if (!stale && url) style.setProperty('--chat-bg', `url("${url}")`);
		});
	});


	function notify(title: string, body: string, sound: 'done' | 'permission' = 'done') {
		if (!(document.hidden || (notifyUnfocused() && !document.hasFocus()))) return;
		const mode = notifyMode();
		if (mode === 'sound') {
			playSound(sound);
		} else if (mode === 'notification') {
				playSound(sound);
				if (!isTauri) {
					if (Notification.permission === 'granted') {
						new Notification(title, { body, icon: '/favicon.ico' });
					} else if (Notification.permission !== 'denied') {
						Notification.requestPermission().then(permission => {
							if (permission === 'granted') {
								new Notification(title, { body, icon: '/favicon.ico' });
							}
						});
					}
				}
			}
	}

	return (
		<div class='top' classList={{ 'sidebar-collapsed': !sidebarOpen() }}>
			<Sidebar prompts={prompts} setPrompts={setPrompts}
				configs={configs} setConfigs={setConfigs}
				chat={live().chat} setChat={live().setChat}
				cache={cache()} setCache={setCache} cacheLength={cacheLength()} setCacheLength={setCacheLength}
				options={options} setOptions={setOptions}
				lore={lore} setLore={setLore}
				providers={providers()} setProviders={setProviders}
				setError={setError} setInfo={setInfo}
				skillDirs={skillDirs()} setSkillDirs={setSkillDirs} skills={live().skills()}
				sshBackends={sshBackends} setSshBackends={setSshBackends}
				textDrip={textDrip()} setTextDrip={setTextDrip}
				sidebarOpen={sidebarOpen()} setSidebarOpen={setSidebarOpen}
				notifyMode={notifyMode()} setNotifyMode={setNotifyMode} notifyUnfocused={notifyUnfocused()} setNotifyUnfocused={setNotifyUnfocused}
				chatList={chatList()} currentChatId={currentChatId()} runningChatIds={new Set(runningAgents().keys())} onSwitchChat={switchChat} onSearchMessages={isTauri ? handleSearchMessages : undefined} onCreateChat={handleCreateChat} onCreateChatInFolder={handleCreateChat} onDeleteChat={handleDeleteChat} onRenameChat={handleRenameChat} onDuplicateChat={handleDuplicateChat} onSetTags={handleSetChatTags} onTagFolder={handleTagFolder} onRenameTag={handleRenameTag} onDeleteTag={handleDeleteTag} setChatFolder={handleSetChatFolder}
				compactSettings={compactSettings()} setCompactSettings={setCompactSettings}
				agentSettings={agentSettings()} setAgentSettings={setAgentSettings} titlerSettings={titlerSettings()} setTitlerSettings={setTitlerSettings} onGenerateTitle={handleGenerateTitle} />
			<Show when={live()} keyed>{l => (
				<ChatView live={l} prompts={prompts} lore={lore} providers={providers()}
					sidebarOpen={sidebarOpen()} setSidebarOpen={setSidebarOpen}
					error={error()} setError={setError} info={info()} setInfo={setInfo}
					onReload={reloadCurrentChat} importChat={handleImport} importCard={handleImportCard} forkChat={isTauri ? handleForkChat : undefined} />
			)}</Show>
			<WidgetDock />
		</div>
	);
}

export default App;
