import { createSignal, Show, For, createEffect, onMount, onCleanup, batch, untrack } from 'solid-js';
import { createStore, SetStoreFunction } from 'solid-js/store'
import { MInput } from './input'
import { MessageList, Icon } from './Message'
import { Sidebar } from './sidebar';
import { TopBar } from './TopBar';
import { SearchBar } from './SearchBar';

import { throttle, leadingAndTrailing } from '@solid-primitives/scheduled';
import { loadMessages } from './helpers/storage';
import { isTauri } from './helpers/platform';
import { pushNav, replaceNav, restoreNav, syncNav } from './helpers/navHistory';
import type { Chat } from './helpers/db';
import * as dbModule from './helpers/db';
import { TimerDisplay, startTimer, msgVars, loadFromStorage, playSound } from './helpers/Extras';
import { scanFolderFiles, readFileText, getLaunchFolder } from './helpers/platform';
import { LoreEntry, loadLore } from './helpers/lore';
import { modelMatchesTrigger } from './helpers/PromptManager';
import { createChatSession, type SessionEnv } from './helpers/session';
import { runAgentTask, abortAgentsFor, runningAgents } from './helpers/agent';
import { updateSpawnAgentTool } from './helpers/tools';
const _promptFiles = import.meta.glob('../default-prompt.md', { query: '?raw', import: 'default', eager: true });
const defaultPrompt = (_promptFiles['../default-prompt.md'] as string) ?? '';


// last $674
import type { cacheType, cacheLength, Prompt, Config, ToolApprove, ChatMeta, ChatMessage, FileAttachment, Provider, ProviderConfig, Options, ExtraBodyRule, Role, AgentSettings, TitlerSettings } from './helpers/types';
import { DEFAULT_PROVIDERS, DEFAULT_AGENT_SETTINGS, DEFAULT_TITLER_SETTINGS } from './helpers/types';
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

// Short one-line summary of a tool call's args for the sub-agent permission card
function permSummary(toolCall: any): string {
	const args = toolCall.function?.arguments;
	if (!args) return '';
	const obj = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return { _: args }; } })() : args;
	const first = obj.path ?? obj.command ?? obj.url ?? Object.values(obj)[0];
	return String(first ?? '').replace(/\s+/g, ' ').slice(0, 120);
}

function App() {
	const [error, _setError] = createSignal<string | null>(null);
	const [info, _setInfo] = createSignal<string | null>(null);

	const setError: typeof _setError = (v) => {
		const val = typeof v === 'function' ? (v as any)(error()) : v;
		if (val && !error() && (document.hidden || !document.hasFocus())) playSound('error');
		return _setError(v);
	};
	const setInfo: typeof _setInfo = (v) => {
		const val = typeof v === 'function' ? (v as any)(info()) : v;
		if (val && !info() && (document.hidden || !document.hasFocus())) playSound('info');
		return _setInfo(v);
	};
	const [copiedBox, setCopiedBox] = createSignal<string | null>(null);
	const [sendMode, setSendMode] = createSignal<'loop' | 'single'>(loadFromStorage<'loop' | 'single'>("send_mode", 'loop', true, setError));
	const [streamPad, setStreamPad] = createSignal(false);
	const [inputValue, setInputValue] = createSignal(loadFromStorage<string>("input_value", '', true, setError));
	/** Attachments staged for the next message (see helpers/attachments.ts). */
	const [pendingImages, setPendingImages] = createSignal<string[]>([]);
	const [pendingFiles, setPendingFiles] = createSignal<FileAttachment[]>([]);
	const [provider, setProvider] = createSignal<Provider>(loadFromStorage<Provider>("provider", "or", true, setError));
	const [model, setModel] = createSignal<string>(loadFromStorage<string>("model", "", true, setError));
	const [theme, setTheme] = createSignal<string>(loadFromStorage<string>("theme", "modern", true, setError));
	const [contentVisibility, setContentVisibility] = createSignal<boolean>(loadFromStorage<boolean>("content_visibility", false, true, setError));
	const [textDrip, setTextDrip] = createSignal<boolean>(loadFromStorage<boolean>("text_drip", true, true, setError));
	const [sidebarOpen, setSidebarOpen] = createSignal<boolean>(loadFromStorage<boolean>("sidebar_open", true, true, setError));
	const [notifyMode, setNotifyMode] = createSignal<'off' | 'sound' | 'notification'>(loadFromStorage<'off' | 'sound' | 'notification'>("notify_mode", 'notification', true, setError));
	const [notifyUnfocused, setNotifyUnfocused] = createSignal<boolean>(loadFromStorage<boolean>("notify_unfocused", false, true, setError));
	
	// ── Config system ─────────────────────────────────────────────────────
	const defaultPrompts: Prompt[] = [
		{ name: "System", content: loadFromStorage<string>("prompt", defaultPrompt, true, setError), role: 'system', position: 0, enabled: true }
	];

	// Migration: wrap existing prompts into a Default config if no configs key exists
	const ng = (n: number) => n < 0 ? 10000 + n : n;
	const initialConfigs: Config[] = (() => {
		const stored = loadFromStorage<Config[] | null>("configs", null, true, setError);
		if (stored && stored.length > 0) {
			// Sort each config's prompts by position on load
			for (const c of stored) c.prompts.sort((a, b) => ng(a.position) - ng(b.position));
			return stored;
		}

		// Migrate from old "prompts" key
		const oldPrompts = loadFromStorage<Prompt[] | null>("prompts", null, true, setError);
		const prompts = (oldPrompts ?? defaultPrompts).sort((a, b) => ng(a.position) - ng(b.position));
		return [{ name: "Default", prompts }];
	})();

	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	function copyText(text: string, box: string) {
		navigator.clipboard.writeText(text).then(() => {
			setCopiedBox(box);
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => setCopiedBox(null), 1200);
		});
	}

	const initialActiveConfigName = loadFromStorage<string>("activeConfig", initialConfigs[0]?.name ?? "Default", true, setError);

	const loadedOptions = migrateExtraBody(
	loadFromStorage<Options>("options", {stream: true, usage: { include: true }}, true, setError)
);

	const [configs, setConfigs] = createStore<Config[]>(initialConfigs);
	const [activeConfigName, setActiveConfigName] = createSignal<string>(initialActiveConfigName);

	const activeConfigIndex = () => {
		const idx = configs.findIndex(c => c.name === activeConfigName());
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
	const [role, setRole] = createSignal<Role>('user');
	const [cut, setCut] = createSignal<number>(loadFromStorage<number>("cut_index", -1, true, setError));
	const [lore, setLore] = createStore<LoreEntry[]>(loadLore(setError));


	const [macros, setMacros] = createSignal<Record<string, string>>(
		loadFromStorage<Record<string, string>>("macros", {}, true, setError)
	);

	const [loreId, setLoreId] = createSignal<string>(
		loadFromStorage<string>("lore_id", crypto.randomUUID().slice(0, 8), true, setError)
	);

	const [chatFolder, setChatFolder] = createSignal<string>(
		loadFromStorage<string>("chat_folder", '', true, setError)
	);

	const [toolApprove, setToolApprove] = createSignal<ToolApprove>(
		loadFromStorage<ToolApprove>("tool_approve", 'off', true, setError)
	);
	const [toolApproveOutside, setToolApproveOutside] = createSignal<ToolApprove>(
		loadFromStorage<ToolApprove>("tool_approve_outside", 'off', true, setError)
	);
	const [agentSettings, setAgentSettings] = createSignal<AgentSettings>(
		loadFromStorage<AgentSettings>("agent_settings", DEFAULT_AGENT_SETTINGS, true, setError)
	);
	const [titlerSettings, setTitlerSettings] = createSignal<TitlerSettings>(
		loadFromStorage<TitlerSettings>("titler_settings", DEFAULT_TITLER_SETTINGS, true, setError)
	);
	const [pendingPermissions, setPendingPermissions] = createSignal<
		Array<{ id: string; toolCall: any; resolve: (result: true | string) => void; outside?: boolean; chatName?: string | undefined }>
	>([]);

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

	const [imageFolderHandle, setImageFolderHandle] = createSignal<FileSystemDirectoryHandle | null>(null);
	const [imageFolderFiles, setImageFolderFiles] = createSignal<Map<string, FileSystemFileHandle>>(new Map());

	// ── Chat management (Tauri only) ──────────────────────────────────
	const [chatList, setChatList] = createSignal<Chat[]>([]);
	const [currentChatId, setCurrentChatId] = createSignal('');

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

	async function scanImageFolder(dirHandle: FileSystemDirectoryHandle) {
		const fileMap = new Map<string, FileSystemFileHandle>();
		const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

		async function scanDir(handle: FileSystemDirectoryHandle, path = ''): Promise<void> {
			try {
				for await (const entry of handle.values()) {
					const entryPath = path ? `${path}/${entry.name}` : entry.name;

					if (entry.kind === 'file') {
						const ext = entry.name.toLowerCase().substring(entry.name.lastIndexOf('.'));
						if (imageExtensions.has(ext)) {
							fileMap.set(entryPath, entry as FileSystemFileHandle);
						}
					} else if (entry.kind === 'directory') {
						await scanDir(entry as FileSystemDirectoryHandle, entryPath);
					}
				}
			} catch (error) {
				console.error('Error scanning directory:', path, error);
			}
		}

		await scanDir(dirHandle);
		setImageFolderFiles(fileMap);
	}

	// Timer state
	const [timerActive, setTimerActive] = createSignal(false);
	const [timerRemaining, setTimerRemaining] = createSignal(0);
	const [timerReady, setTimerReady] = createSignal(false);
	const [timerDuration, setTimerDuration] = createSignal(0);

	// Scroll-follow state — declared before the session so its UI hooks can close over it
	let msgs!: HTMLDivElement;
	let followingStream = false;
	let lastScrollTop = 0;
	let followCheck: ReturnType<typeof setTimeout> | undefined;

	const promptMessages = () => {
		const currentModel = model();
		return prompts
			.filter(p => p.enabled)
			.filter(p => modelMatchesTrigger(p.modelTrigger, currentModel).matches)
			.sort((a, b) => a.position - b.position)
			.map(p => ({
				role: p.role,
				content: msgVars(p.content, macros(), currentModel, chatFolder(), currentChatId()),
				position: p.position
			}));
	};

	//#  Chat session
	// The visible chat's engine: message store, persistence, streaming, tool loop.
	// App signals are passed as live accessors; UI hooks wire scroll/notifications.
	const sessionEnv: SessionEnv = {
		chatId: currentChatId,
		model, provider, providers, options: () => options,
		activeConfig: () => configs[activeConfigIndex()],
		promptMessages,
		cache, cacheLength,
		macros, chatFolder, cut, sendMode,
		lore, setLore,
		requestPermission: (tc, chatName) => requestPermission(tc, chatName),
		shellSession: 'main',
		setError, setInfo,
		input: { value: inputValue, images: pendingImages, files: pendingFiles, clear: () => { setInputValue(''); setPendingImages([]); setPendingFiles([]); }, role },
		// Sub-agents (Tauri only — web storage is single-chat). The runner snapshots
		// this env at spawn time; `session` is safely referenced lazily from closures.
		spawnAgent: isTauri
			? (args, callId) => runAgentTask({
				args,
				toolCallId: callId,
				parentChatId: currentChatId(),
				parentEnv: sessionEnv,
				parentSession: session,
				settings: agentSettings(),
				onChatCreated: () => refreshChatList(),
			})
			: undefined,
		onAbort: () => abortAgentsFor(currentChatId()),
	};
	const session = createChatSession(sessionEnv,
	{
		textDrip,
		// Jump to bottom when content outgrows the padding space. Trailing-throttled:
		// tool output arrives line-by-line and every check forces a layout.
		afterAppend: () => {
			if (!followingStream || followCheck) return;
			followCheck = setTimeout(() => {
				followCheck = undefined;
				if (!followingStream) return;
				const offscreen = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
				if (offscreen > msgs.clientHeight * 0.4)
					msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
			}, 80);
		},
		onStreamDone: (content) => notify('Message received', content.slice(0, 200)),
		timers: { setActive: setTimerActive, setRemaining: setTimerRemaining, setReady: setTimerReady, setDuration: setTimerDuration },
	});
	const { messages, setMessages, sendMessage, sendAsideMessage, sendRewriteMessage, deleteMessage, abortAllStreams, isLoading, activeStreams, chatConflict } = session;
	onCleanup(() => clearTimeout(followCheck));


	//#  Search
	const [searchOpen, setSearchOpen] = createSignal(false);
	const [searchQuery, setSearchQuery] = createSignal('');
	const [searchActive, setSearchActive] = createSignal(-1);
	const [searchAllVersions, setSearchAllVersions] = createSignal(false);
	const [highlightIdx, setHighlightIdx] = createSignal(-1);
	let highlightTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Scroll a message into view by array index, with a brief highlight.
	 * Single entry point for every jump (search, cut-point, cross-chat), so
	 * windowed loading would only have to teach this one function to page in.
	 */
	function scrollToMessage(idx: number, highlight = true) {
		const target = msgs?.querySelector(`[data-message-index="${idx}"]`);
		if (!target) return;
		target.scrollIntoView({ behavior: 'smooth', block: 'center' });
		if (!highlight) return;
		clearTimeout(highlightTimer);
		setHighlightIdx(idx);
		// Must outlast the CSS fade (search-flash) or the class drops mid-animation
		highlightTimer = setTimeout(() => setHighlightIdx(-1), 1900);
	}
	onCleanup(() => clearTimeout(highlightTimer));

	/** Animate the search icon between its button and the search bar, where supported. */
	function withIconMorph(update: () => void) {
		const start = (document as any).startViewTransition?.bind(document);
		if (start) start(update);
		else update();
	}

	function openSearch() {
		withIconMorph(() => setSearchOpen(true));
	}

	function closeSearch() {
		withIconMorph(() => batch(() => {
			setSearchOpen(false);
			setSearchActive(-1);
			setSearchAllVersions(false); // scope is per-session, never remembered
			setHighlightIdx(-1);
		}));
	}

	// Gates the Tauri meta auto-save effect so it never fires with pre-load
	// default signal values (which would clobber the current chat's saved meta).
	let metaReady = false;

	if (isTauri) {
		onCleanup(startBackupService());

		// Tauri: pick this view's chat (?chat=<id> wins over the last-opened chat, enabling independent chats per window), then load it.
		(async () => {
			const db = await getDb();
			await db.initDatabase();

			// First-launch migration from IndexedDB takes precedence.
			const migrated = await db.migrateFromIndexedDB();
			let chatId: string;
			let msgs: ChatMessage[];
			let pinned = false;
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
			setCurrentChatId(chatId);

			const [meta, chat, chats] = await Promise.all([
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
				setStreamPad(false);
				setChatList(chats);
				if (meta) applyChatMeta(meta);
				session.load(msgs, chat?.version ?? 0);
			});

			// CLI launch with a folder arg: open a fresh chat scoped to that folder.
			// handleCreateChat inherits config/meta from the latest chat in the
			// folder and auto-loads its agents.md.
			const launchFolder = await getLaunchFolder();
			if (launchFolder) await handleCreateChat(launchFolder);
		})()
			.catch(err => {
				const msg = 'Failed to load chat: ' + (err instanceof Error ? err.message : String(err));
				console.error(msg, err);
				setError(msg);
			})
			.finally(() => { metaReady = true; });
	} else {
		loadMessages(setError)
			.then(loaded => {
				setStreamPad(false);
				session.load(loaded, 0);
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

		const handleMessageScroll = (e: KeyboardEvent) => {
			if (!msgs) return;
			const isUp = e.key === 'ArrowUp' && e.altKey;
			const isDown = e.key === 'ArrowDown' && e.altKey;

			if (!isUp && !isDown) return;
			e.preventDefault();

			const messageElements = Array.from(msgs.querySelectorAll('.messageBubble'));
			if (messageElements.length < 3) return;

			const containerRect = msgs.getBoundingClientRect();
			const topY = containerRect.top;

			let closestIndex = 0;
			let closestDistance = Infinity;

			messageElements.forEach((el, idx) => {
				const rect = el.getBoundingClientRect();
				const elementTopY = rect.top;
				const distance = Math.abs(elementTopY - topY);
				if (distance < closestDistance) {
					closestDistance = distance;
					closestIndex = idx;
				}
			});

			const targetIndex = isUp ? closestIndex - 1 : closestIndex + 1;
			if (targetIndex >= 0 && targetIndex < messageElements.length) {
				(messageElements[targetIndex] as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		};

		window.addEventListener('popstate', handlePopState);
		window.addEventListener('keydown', handleMessageScroll);

		onCleanup(() => {
			window.removeEventListener('unhandledrejection', handleUnhandledRejection);
			window.removeEventListener('popstate', handlePopState);
			window.removeEventListener('keydown', handleMessageScroll);
		});
	});

	const save = (key: string, value: any) => {
		if (value === null || value === undefined) return;
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch (err) {
			const msg = `Failed to save ${key} to localStorage: ` + (err instanceof Error ? err.message : String(err));
			console.error(msg, err);
			setError(msg);
		}
	};

	function getChatMeta(): ChatMeta {
		const meta: ChatMeta = {
			macros: Object.fromEntries(Object.entries(macros()).filter(([k]) => k !== 'agents')),
			configName: activeConfigName(),
			cut: cut(),
			theme: theme(),
			tools: configs[activeConfigIndex()]?.tools ?? {},
			model: model(),
			provider: provider(),
			sendMode: sendMode(),
			loreId: loreId(),
		};
		if (chatFolder()) meta.chatFolder = chatFolder();
		if (toolApprove() !== 'off') meta.toolApprove = toolApprove();
		if (toolApproveOutside() !== 'off') meta.toolApproveOutside = toolApproveOutside();
		return meta;
	}

	async function loadAgentsMacro(folder: string) {
		if (!folder) {
			setMacros(prev => { const { agents, ...rest } = prev; return rest; });
			return;
		}
		try {
			const agentsFiles = await scanFolderFiles(folder, 'agents.md');
			if (agentsFiles.length > 0) {
				const content = await readFileText(agentsFiles[0].path);
				if (content.trim()) {
					const formatted = `<agents_md>\n${content.trim()}\n</agents_md>`;
					setMacros(prev => ({ ...prev, agents: formatted}) );
					return;
				}
			}
		} catch (e) {
			console.warn('Failed to read agents.md:', e);
		}
		// No agents.md found or empty — clear macro
		setMacros(prev => { const { agents, ...rest } = prev; return rest; });
	}

	function applyChatMeta(meta: Partial<ChatMeta>) {
		batch(() => {
			if (meta.configName) {
				const configExists = configs.some(c => c.name === meta.configName);
				if (configExists) {
					setActiveConfigName(meta.configName!);
				} else {
					setInfo(`Config "${meta.configName}" not found, keeping current config "${activeConfigName()}".`);
				}
			}
			if (meta.macros !== undefined) setMacros(meta.macros);
			// Clear agents macro — will be re-loaded async below if folder has agents.md
			setMacros(prev => { const { agents, ...rest } = prev; return rest; });
			if (meta.cut !== undefined) setCut(meta.cut);
			if (meta.theme !== undefined) setTheme(meta.theme);
			if (meta.tools !== undefined) setConfigs(activeConfigIndex(), 'tools', meta.tools);
			if (meta.model !== undefined) setModel(meta.model);
			if (meta.provider !== undefined) setProvider(meta.provider);
			if (meta.sendMode !== undefined) setSendMode(meta.sendMode);
			else setSendMode(loadFromStorage<'loop' | 'single'>("send_mode", 'loop', true, setError));
			setLoreId(meta.loreId || crypto.randomUUID().slice(0, 8));
			setChatFolder(meta.chatFolder || '');
			setToolApprove(meta.toolApprove || 'off');
			setToolApproveOutside(meta.toolApproveOutside || 'off');
		});
		// Load agents.md macro (async, outside batch) — also clears if no folder
		loadAgentsMacro(meta.chatFolder || '');
	}

	/** Meta inherited from the most recent chat in `folder` (config, tools, model,
	 *  lore, theme, etc.), excluding the current chat. Cuts are per-conversation and
	 *  never inherited. Returns undefined if no other chat lives in that folder yet. */
	function inheritedMetaForFolder(folder: string, excludeChatId?: string): Partial<ChatMeta> | undefined {
		if (!folder) return undefined;
		const sourceChat = chatList()
			.filter(c => c.id !== excludeChatId && (c.chat_folder || '') === folder)
			.sort((a, b) => b.updated - a.updated)[0];
		if (!sourceChat) return undefined;
		const meta: Partial<ChatMeta> = {};
		if (sourceChat.config_name) meta.configName = sourceChat.config_name;
		if (sourceChat.meta) {
			try { Object.assign(meta, JSON.parse(sourceChat.meta)); }
			catch (e) { console.warn('Failed to parse source chat meta:', e); }
		}
		delete meta.cut; // cut points are per-conversation, not folder-level
		meta.chatFolder = folder;
		return meta;
	}

	/** Change the current chat's folder, inheriting meta from the most recent chat in
	 *  that folder (mirroring the "new chat in folder" flow). With no prior chat there,
	 *  only the folder + agents.md macro are changed. */
	function handleSetChatFolder(folder: string) {
		const inherited = inheritedMetaForFolder(folder, currentChatId());
		if (inherited) {
			applyChatMeta(inherited); // sets chatFolder + (re)loads the agents.md macro
		} else {
			setChatFolder(folder);
			void loadAgentsMacro(folder);
		}
		if (isTauri) void flushCurrentChat().then(refreshChatList);
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

	/** Flush pending meta + message writes for the current chat and drain the queue. */
	async function flushCurrentChat() {
		if (!isTauri) return;
		flushMetaToDb?.clear();
		const db = await getDb();
		await session.enqueueWrite(version => db.saveChatMeta(getChatMeta(), currentChatId(), version));
		await session.flush();
	}

	/** Re-load the current chat from the db, discarding local unsaved edits. */
	async function reloadCurrentChat() {
		if (!isTauri) return;
		try {
			const db = await getDb();
			const id = currentChatId();
			session.discardPending(); // drop any queued/in-flight writes + unsaved dirt
			flushMetaToDb?.clear();
			const [msgs, meta, chat] = await Promise.all([
				db.loadChatMessages(id),
				db.loadChatMeta(id),
				db.getChat(id),
			]);
			setStreamPad(false);
			// Reset cut to default first: applyChatMeta only sets it when the saved
			// meta carries a cut, so without this a chat with no saved cut would
			// inherit the previous one. (Mirrors switchChat.)
			setCut(-1);
			if (meta) applyChatMeta(meta);
			session.load(msgs, chat?.version ?? 0);
			await refreshChatList();
		} catch (err) {
			setError('Failed to reload chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function switchChat(newId: string, addHistory = true, scrollToIdx?: number) {
		if (newId === currentChatId()) {
			// Already here — a search result still wants the jump
			if (scrollToIdx !== undefined) scrollToMessage(scrollToIdx);
			return;
		}
		if (isLoading()) return setInfo('Stop generation before switching chats');
		try {
			const db = await getDb();
			setInfo('');
			setError('');
			if (!await db.getChat(newId)) return setError('Chat not found');

			// Save current chat state, then invalidate any straggler writes so none
			// lands on the new chat with the old chat's tracked version.
			await flushCurrentChat();
			session.invalidateWrites();

			// Switch to new chat
			db.setCurrentChatId(newId);
			if (addHistory) pushChatHistory(newId);

			// Load messages, meta and version in parallel
			const [msgs, meta, chat] = await Promise.all([
				db.loadChatMessages(newId),
				db.loadChatMeta(newId),
				db.getChat(newId),
			]);
			// Apply the id and messages atomically so effects (e.g. auto-title)
			// never observe the new chat id paired with the previous messages.
			batch(() => {
				setCurrentChatId(newId);
				setStreamPad(false);
				setCut(-1);
				if (meta) applyChatMeta(meta);
				session.load(msgs, chat?.version ?? 0);
			});

			await refreshChatList();
			// Let the new list render before looking for the target element
			if (scrollToIdx !== undefined)
				requestAnimationFrame(() => scrollToMessage(scrollToIdx));
		} catch (err) {
			setError('Failed to switch chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	/** Global content search for the sidebar (Tauri only — FTS lives in SQLite). */
	async function handleSearchMessages(query: string, folders?: string[]) {
		try {
			// Unsaved edits in the open chat aren't in the index yet
			await flushCurrentChat();
			return await (await getDb()).searchMessagesFTS(query, { folders });
		} catch (err) {
			setError('Search failed: ' + (err instanceof Error ? err.message : String(err)));
			return [];
		}
	}

	async function handleCreateChat(folder?: string, resetConfig = false) {
		if (isLoading()) return;
		try {
			const db = await getDb();

			// Save current chat, then invalidate any straggler writes
			await flushCurrentChat();
			session.invalidateWrites();

			// Inherit meta (config/model/tools/lore/etc.) from the most recent chat in
			// the target folder. Cuts are per-conversation and never inherited.
			let inheritedMeta: Partial<ChatMeta> | undefined;
			if (!resetConfig && folder !== undefined)
				inheritedMeta = inheritedMetaForFolder(folder) ?? { chatFolder: folder };

			// Create new chat (starts at version 0) and clear messages
			const newId = await db.createChat('New Chat');
			setCurrentChatId(newId);
			session.load([], 0);
			setCut(-1);

			// Apply inherited meta to the new chat (not the old one)
			if (inheritedMeta) applyChatMeta(inheritedMeta);
			if (resetConfig) {
				batch(() => {
					setActiveConfigName(configs.find(config => /default/i.test(config.name))?.name ?? configs[0]?.name);
					setChatFolder('');
					setCut(-1);
				});
			}

			// Persist inherited meta so chat list grouping is correct immediately
			await session.enqueueWrite(v => db.saveChatMeta(getChatMeta(), newId, v));
			await session.flush();
			await refreshChatList();
			pushChatHistory(newId);
		} catch (err) {
			setError('Failed to create chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function handleDeleteChat(id: string) {
		if (isLoading()) return;
		try {
			const db = await getDb();
			await db.deleteChat(id);

			if (id === currentChatId()) {
				// No save — the chat is already deleted. Discard pending writes and
				// invalidate any straggler writes still queued for the deleted chat.
				session.discardPending();
				flushMetaToDb?.clear();

				const newId = await db.getCurrentChatId();
				db.setCurrentChatId(newId);
				setCurrentChatId(newId);
				replaceChatHistory(newId);

				const [msgs, meta, chat] = await Promise.all([
					db.loadChatMessages(newId),
					db.loadChatMeta(newId),
					db.getChat(newId),
				]);
				setStreamPad(false);
				setCut(-1);
				if (meta) applyChatMeta(meta);
				session.load(msgs, chat?.version ?? 0);
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
			if (id === currentChatId()) await flushCurrentChat();
			const msgs = id === currentChatId() ? messages : await db.loadChatMessages(id);
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
		const count = messages.length;
		if (n <= 0 || count < n || isLoading()) return;
		const id = currentChatId();
		if (autoTitled.has(id)) return;
		// No list entry yet means the chat list hasn't loaded — never title on a
		// guess; the effect re-runs once chatList lands.
		const chat = chatList().find(c => c.id === id);
		if (!chat || chat.name !== 'New Chat') return;
		autoTitled.add(id); // reserve before the async call to prevent re-entry
		handleGenerateTitle(id, true).then(ok => { if (!ok) autoTitled.delete(id); }); // allow retry on failure
	});

	async function handleDuplicateChat(id: string) {
		if (isLoading()) return setInfo('Stop generation before duplicating');
		try {
			const db = await getDb();
			// Persist current chat state so the copy reflects unsaved edits
			if (id === currentChatId()) await flushCurrentChat();
			const newId = await db.duplicateChat(id);
			await refreshChatList();
			await switchChat(newId);
		} catch (err) {
			setError('Failed to duplicate chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function handleForkChat(index: number) {
		if (!isTauri) return;
		if (isLoading()) return setInfo('Stop generation before forking');
		try {
			const db = await getDb();
			// Persist current chat so the fork boundary references saved messages
			await flushCurrentChat();
			const newId = await db.forkChat(currentChatId(), index);
			await refreshChatList();
			await switchChat(newId);
		} catch (err) {
			setError('Failed to fork chat: ' + (err instanceof Error ? err.message : String(err)));
		}
	}


	createEffect(() => save("configs", configs));
	createEffect(() => save("activeConfig", activeConfigName()));
	createEffect(() => save("options", options));
	createEffect(() => save("model", model()));
	createEffect(() => save("cut_index", cut()));
	createEffect(() => save("lore_entries", lore));
	createEffect(() => save("cache", cache()));
	createEffect(() => save("cache_length", cacheLength()));
	createEffect(() => save("provider", provider()));
	createEffect(() => save("theme", theme()));
	createEffect(() => save("content_visibility", contentVisibility()));
	createEffect(() => save("text_drip", textDrip()));
	createEffect(() => save("sidebar_open", sidebarOpen()));
	createEffect(() => save("notify_mode", notifyMode()));
	createEffect(() => save("notify_unfocused", notifyUnfocused()));
	createEffect(() => save("providers", providers()));
	createEffect(() => save("macros", macros()));
	createEffect(() => save("lore_id", loreId()));
	createEffect(() => save("chat_folder", chatFolder()));
	createEffect(() => save("tool_approve", toolApprove()));
	createEffect(() => save("tool_approve_outside", toolApproveOutside()));
	createEffect(() => save("input_value", inputValue()));
	createEffect(() => { if (!isTauri) save("send_mode", sendMode()); });
	createEffect(() => {
		save("agent_settings", agentSettings());
		updateSpawnAgentTool(agentSettings()); // keep the spawn_agent tool schema in sync
	});
	createEffect(() => save("titler_settings", titlerSettings()));

	// ── Reactive chat meta persistence (Tauri only) ─────────────────────
	const flushMetaToDb = isTauri
		? leadingAndTrailing(throttle, () =>
			session.enqueueWrite(async v => {
				const db = await getDb();
				return db.saveChatMeta(getChatMeta(), currentChatId(), v);
			}), 2000)
		: null;

	if (isTauri) {
		createEffect(() => {
			// Read all meta signals to subscribe to them
			const cfg = configs[activeConfigIndex()];
			macros(); activeConfigName(); cut(); theme(); sendMode();
			cfg?.tools;
			cfg?.reasoning?.effort;
			cfg?.preserveReasoning;
			cfg?.reasoningPrefill?.enabled;
			cfg?.reasoningPrefill?.content;
			model(); loreId(); chatFolder();
			if (!metaReady) return; // skip pre-load default-value writes
			flushMetaToDb!();
		});

		// Safety net: flush on page unload
		const handleUnload = () => {
			// Deny any pending permission so applyToolCalls can finish and write a result
			for (const p of pendingPermissions()) p.resolve('Edit denied: application closed');
			setPendingPermissions([]);
			flushMetaToDb!.clear();
			navigator.sendBeacon?.('about:blank', ''); // keep event loop alive briefly
			getDb().then(db => db.saveChatMeta(getChatMeta(), currentChatId(), session.version())).catch(() => {});
			// Drop this instance's presence mark so a restore elsewhere isn't blocked
			// by a window that's already gone (the TTL is only a fallback).
			getDb().then(db => db.endSession()).catch(() => {});
		};
		window.addEventListener('beforeunload', handleUnload);
		onCleanup(() => window.removeEventListener('beforeunload', handleUnload));

		// On regaining focus, refresh the chat list and pull in external changes
		// (another view edited this same chat) when we have nothing pending.
		const handleFocus = () => {
			if (chatConflict()) return;
			refreshChatList();
			if (!isLoading() && !session.hasPendingWrites()) {
				getDb().then(async db => {
					const chat = await db.getChat(currentChatId());
					if (chat && chat.version !== session.version()) await reloadCurrentChat();
				}).catch(() => {});
			}
		};
		window.addEventListener('focus', handleFocus);
		onCleanup(() => window.removeEventListener('focus', handleFocus));
	}

	createEffect(() => {
		const err = error();
		if (err) {
			setTimeout(() => {
				msgs.scrollTop = msgs.scrollHeight;
				msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
			}, 100);
		}
	});

	// Arm streaming padding + auto-follow when a stream starts on the last message.
	// Keyed off stream starts rather than isLoading edges: isLoading dips for a microtask
	// between a stream ending and its tool calls starting, so an edge-triggered re-arm
	// lands with no active stream and would kill follow for the rest of a tool loop.
	createEffect(() => {
		const streams = activeStreams();
		untrack(() => {
			if (!streams.size) return;
			const last = messages[messages.length - 1];
			// Mid-list redo: never chase the bottom, and the padding has nothing to serve
			if (!last || !streams.has(last)) { followingStream = false; setStreamPad(false); return; }
			// Already armed — keep the user's follow choice across the whole tool loop
			if (streamPad()) return;
			setStreamPad(true);
			const offscreen = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
			followingStream = offscreen < 100;
			lastScrollTop = msgs.scrollTop;
			if (followingStream) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
		});
	});

	// Auto-follow tracks scroll position at all times (streaming or not), so a run that
	// starts while the padding is still up inherits a correct choice.
	// After streaming: silently remove padding once user scrolls it offscreen
	onMount(() => {
		let ignoreScroll = false;
		msgs.addEventListener('scroll', () => {
			if (ignoreScroll) return;
			const offscreen = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
			if (followingStream && msgs.scrollTop < lastScrollTop - 10)
				followingStream = false;
			else if (!followingStream && offscreen < 100)
				followingStream = true;
			lastScrollTop = msgs.scrollTop;

			if (isLoading() || !streamPad()) return;
			const paddingPx = msgs.clientHeight * 0.4; // 40vh
			if (msgs.scrollTop + msgs.clientHeight < msgs.scrollHeight - paddingPx) {
				ignoreScroll = true;
				setStreamPad(false);
				requestAnimationFrame(() => { ignoreScroll = false; });
			}
		});
	});


	// global keyboard shortcut handler
	onMount(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Auto-focus input on plain typing when nothing else is focused
			if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
				const ae = document.activeElement as HTMLElement | null;
				const tag = ae?.tagName;
				if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !ae?.isContentEditable) {
					const input = document.querySelector('.inputField') as HTMLTextAreaElement | null;
					if (input) input.focus();
					// don't preventDefault so the char isn't swallowed
					return;
				}
			}

			if (!e.ctrlKey) return;

			if (e.key.toLowerCase() === 'n') {
				e.preventDefault();
				if (e.shiftKey) handleCreateChat(undefined, true);
				else handleCreateChat();
			} else if (e.key.toLowerCase() === 'f' && e.shiftKey) {
				e.preventDefault();
				if (searchOpen()) {
					// Already open — Ctrl+F again just reselects the query
					const input = document.querySelector('.searchInput') as HTMLInputElement | null;
					input?.select();
					input?.focus();
				} else openSearch();
			} else if (e.key === 'g' && cut() >= 0 && cut() < messages.length) {
				e.preventDefault();
				scrollToMessage(cut(), false);
			}
		};

		document.addEventListener('keydown', handleKeyDown);

		onCleanup(() => document.removeEventListener('keydown', handleKeyDown));
	});

	// Apply theme to body element
	createEffect(() => {
		const currentTheme = theme();
		if (currentTheme === 'default')
			document.body.removeAttribute('data-theme');
		else
			document.body.setAttribute('data-theme', currentTheme);
	});


	function isOutsideChatFolder(toolCall: any): boolean {
		const folder = chatFolder();
		if (!folder) return true; // no folder set → everything is "outside"
		const filePath: string = toolCall.function?.arguments?.path || '';
		const isAbsolute = /^[A-Za-z]:[\\/]|^\//.test(filePath);
		if (!isAbsolute) return false; // relative paths resolve within chat folder
		const normFolder = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
		const normPath = filePath.replace(/\\/g, '/').toLowerCase();
		return !normPath.startsWith(normFolder + '/');
	}

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

	function requestPermission(toolCall: any, chatName?: string): Promise<true | string> {
		const outside = isOutsideChatFolder(toolCall);
		const approve = outside ? toolApproveOutside() : toolApprove();
		if (approve === 'always' || approve === 'chat') return Promise.resolve(true);
		// Notify since the loop is paused awaiting user action
		notify('Edit pending approval', (chatName ? chatName + ' — ' : '') + toolCall.function?.name + ': ' + (toolCall.function?.arguments?.path || '').slice(0, 100), 'permission');
		return new Promise<true | string>(resolve => {
			setPendingPermissions(prev => [...prev, { id: toolCall.id, toolCall, resolve, outside, chatName }]);
		});
	}

	function resolvePermission(id: string, approved: boolean, mode?: ToolApprove) {
		const pending = pendingPermissions().find(p => p.id === id);
		if (!pending) return;
		if (mode && mode !== 'off') {
			if (pending.outside) setToolApproveOutside(mode);
			else setToolApprove(mode);
		}
		setPendingPermissions(prev => prev.filter(p => p.id !== id));
		pending.resolve(approved ? true : pending.outside ? 'Edit denied by user (path is outside working folder). This is an expression of intent, do not try to bypass.' : 'Edit denied by user. This is an expression of intent, do not try to bypass.');
		// If mode upgraded to chat/always, auto-approve remaining same-category permissions
		if (approved && mode && mode !== 'off') {
			const remaining = pendingPermissions();
			for (const p of remaining) {
				if (pending.outside ? p.outside : !p.outside) p.resolve(true);
			}
			setPendingPermissions(prev => prev.filter(p => pending.outside ? !p.outside : p.outside));
		}
	}

	return (
		<div class='top' classList={{ 'sidebar-collapsed': !sidebarOpen() }}>
			<Sidebar prompts={prompts} setPrompts={setPrompts} 
				configs={configs} setConfigs={setConfigs} activeConfigName={activeConfigName()} setActiveConfigName={setActiveConfigName} 
				cache={cache()} setCache={setCache} cacheLength={cacheLength()} setCacheLength={setCacheLength} 
				options={options} setOptions={setOptions} 
				lore={lore} setLore={setLore} loreId={loreId()}
				provider={provider()} setProvider={setProvider} providers={providers()} setProviders={setProviders} 
				theme={theme()} setTheme={setTheme} 
				imageFolderHandle={imageFolderHandle()} setImageFolderHandle={setImageFolderHandle} scanImageFolder={scanImageFolder} 
				contentVisibility={contentVisibility()} setContentVisibility={setContentVisibility} 
				model={model()} setError={setError} setInfo={setInfo} 
				macros={macros()} setMacros={setMacros} 
				textDrip={textDrip()} setTextDrip={setTextDrip} 
				sidebarOpen={sidebarOpen()} setSidebarOpen={setSidebarOpen} 
				notifyMode={notifyMode()} setNotifyMode={setNotifyMode} notifyUnfocused={notifyUnfocused()} setNotifyUnfocused={setNotifyUnfocused} 
				chatList={chatList()} currentChatId={currentChatId()} runningChatIds={new Set(runningAgents().keys())} onSwitchChat={switchChat} onSearchMessages={isTauri ? handleSearchMessages : undefined} onCreateChat={handleCreateChat} onCreateChatInFolder={handleCreateChat} onDeleteChat={handleDeleteChat} onRenameChat={handleRenameChat} onDuplicateChat={handleDuplicateChat} chatFolder={chatFolder()} setChatFolder={handleSetChatFolder} 
				toolApprove={toolApprove()} setToolApprove={setToolApprove} toolApproveOutside={toolApproveOutside()} setToolApproveOutside={setToolApproveOutside} 
				agentSettings={agentSettings()} setAgentSettings={setAgentSettings} titlerSettings={titlerSettings()} setTitlerSettings={setTitlerSettings} onGenerateTitle={handleGenerateTitle} />
			<div class='chatContainer'>
				<TopBar model={model()} setModel={setModel} setMessages={setMessages} messages={messages} provider={provider()} setProvider={setProvider} setError={setError} cut={cut()} providers={providers()} sidebarOpen={sidebarOpen()} setSidebarOpen={setSidebarOpen} getChatMeta={getChatMeta} applyChatMeta={applyChatMeta} createChat={isTauri ? handleCreateChat : undefined} onOpenSearch={openSearch} searchOpen={searchOpen()}>
					<Show when={searchOpen()}>
						<SearchBar
							messages={messages}
							query={searchQuery()} setQuery={setSearchQuery}
							active={searchActive()} setActive={setSearchActive}
							allVersions={searchAllVersions()} setAllVersions={setSearchAllVersions}
							onJump={scrollToMessage}
							onClose={closeSearch}
						/>
					</Show>
				</TopBar>

				<div class={`messageList ${contentVisibility() ? 'contentVisibilityAuto' : ''} ${streamPad() ? 'streaming' : ''}`} ref={msgs}>
					<MessageList messages={messages} sendMessage={sendMessage} setMessages={setMessages} deleteMessage={deleteMessage} cut={cut()} setCut={setCut} containerRef={msgs} imageFolderFiles={imageFolderFiles()} activeStreams={activeStreams()} providers={providers()} pendingPermissions={pendingPermissions()} resolvePermission={resolvePermission} chatFolder={chatFolder()} forkChat={isTauri ? handleForkChat : undefined} highlight={highlightIdx()} />
					<Show when={messages.length <= 1}>
						<p class='emptyState'>Start chatting by typing below...</p>
					</Show>
					<Show when={chatConflict()}>
						<div class='messageBubble errorMessage'>
							<p class='messageContent'>This chat changed in another window. Reload to load the latest version — unsaved changes here will be lost.</p>
							<button onClick={reloadCurrentChat}>Reload chat</button>
						</div>
					</Show>
					<Show when={error()}>
						<div class='messageBubble errorMessage'>
							<p class='messageContent'>{error()}</p>
							<span class='infoBoxActions'>
								<button class='mbutton' title='Copy' onClick={() => copyText(error()!, 'error')}>
									<Show when={copiedBox() === 'error'} fallback={<Icon name="clipboard" size={16} />}>
										<Icon name="check" size={16} />
									</Show>
								</button>
								<button class='mbutton' title='Dismiss' onClick={() => setError(null)}><Icon name="x" size={16} /></button>
							</span>
						</div>
					</Show>
					<Show when={info()}>
						<div class='messageBubble infoMessage'>
							<p class='messageContent'>{info()}</p>
							<span class='infoBoxActions'>
								<button class='mbutton' title='Copy' onClick={() => copyText(info()!, 'info')}>
									<Show when={copiedBox() === 'info'} fallback={<Icon name="clipboard" size={16} />}>
										<Icon name="check" size={16} />
									</Show>
								</button>
								<button class='mbutton' title='Dismiss' onClick={() => setInfo(null)}><Icon name="x" size={16} /></button>
							</span>
						</div>
					</Show>
				</div>
				<Show when={pendingPermissions().some(p => !p.chatName)}>
					<button class='pendingPermissionBadge' onClick={() => {
						const el = msgs.querySelector(`.permissionActions`);
						el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
					}}>
						{pendingPermissions().filter(p => !p.chatName).length} edit{pendingPermissions().filter(p => !p.chatName).length > 1 ? 's' : ''} pending approval
					</button>
				</Show>

				{/* Sub-agent permission requests: rendered as standalone cards since the
				     agent's tool call isn't in the visible message list */}
				<Show when={pendingPermissions().some(p => p.chatName)}>
					<div class='agentPermissionStack'>
						<For each={pendingPermissions().filter(p => p.chatName)}>
						{p => (
							<div class='agentPermissionCard'>
								<div class='agentPermissionHead'>
									<span class='agentPermissionChat'>{p.chatName}</span>
									<Show when={p.outside}><span class='permissionOutsideLabel'>outside folder</span></Show>
								</div>
								<div class='agentPermissionTool'>
									<span class='agentPermissionToolName'>{p.toolCall.function?.name}</span>
									<span class='agentPermissionToolArgs'>{permSummary(p.toolCall)}</span>
								</div>
								<div class='permissionActions'>
									<button class='permissionBtn permissionAllow' onClick={() => resolvePermission(p.id, true)}>Allow</button>
									<button class='permissionBtn permissionDeny' onClick={() => resolvePermission(p.id, false)}>Deny</button>
									<button class='permissionBtn permissionChat' onClick={() => resolvePermission(p.id, true, 'chat')}>Allow (chat)</button>
								</div>
							</div>
						)}
						</For>
					</div>
				</Show>

				<MInput
					inputValue={inputValue()} setInputValue={setInputValue} images={pendingImages()} setImages={setPendingImages}
					files={pendingFiles()} setFiles={setPendingFiles}
					isLoading={isLoading()} sendMessage={sendMessage} sendAsideMessage={sendAsideMessage} sendRewriteMessage={sendRewriteMessage}
					abortAllStreams={abortAllStreams}
					role={role()} setRole={setRole}
					setMessages={setMessages} messages={messages}
					cut={cut()} prompts={prompts}
					lore={lore}
					chatFolder={chatFolder()}
					chatId={currentChatId()}
					setSendMode={setSendMode}
					sendMode={sendMode()}
					macros={macros()}
					model={model()}
					tools={configs[activeConfigIndex()]?.tools}
					preserveReasoning={configs[activeConfigIndex()]?.preserveReasoning}
					setError={setError}
				/>
			</div>

			<Show when={timerActive()}>
				<TimerDisplay
					remaining={timerRemaining()}
					isReady={timerReady()}
					duration={timerDuration()}
					onStart={() => {
						if (timerReady()) {
							startTimer(timerDuration(), setTimerActive, setTimerRemaining, setTimerReady);
						}
					}}
				/>
			</Show>
		</div>
	);
}

export default App;
