import { batch, createEffect, createMemo, createRoot, createSignal, on, untrack, type Accessor, type Setter } from 'solid-js';
import { createStore, unwrap, type SetStoreFunction } from 'solid-js/store';
import { throttle, leadingAndTrailing } from '@solid-primitives/scheduled';
import { createChatSession, type ChatSession, type SessionEnv } from './session';
import { runAgentTask, abortAgentsFor } from './agent';
import { getChat, loadChatMessages, loadChatMeta, saveChatMeta } from './db';
import { applyMeta, effectiveTools, emptyDraft, toChatMeta, type ChatState } from './chatState';
import { backendFor, localBackend } from './backend';
import { imageSource, setImageSource } from './imageFolder';
import { isTauri, scanFolderFiles, readFileText } from './platform';
import { msgVars, loadFromStorage } from './Extras';
import { modelMatchesTrigger } from './PromptManager';
import { discoverSkills, formatSkills, skillRoots, PROJECT_SKILL_DIRS, HOME_SKILL_DIRS, type SkillDirs, type SkillEntry } from './skills';
import { formatWidgets, scanWidgets, widgetRegistry, PROJECT_WIDGET_DIRS, HOME_WIDGET_DIRS } from './widgets';
import type { PromptMessage } from './buildRequest';
import type { CompactSettings } from './compact';
import type { LoreEntry } from './lore';
import type { AgentSettings, cacheType, cacheLength, ChatMessage, ChatMeta, Config, Options, PendingPermission, Provider, ProviderConfig, ToolApprove } from './types';

/** App-wide settings and hooks a chat reads, as accessors so edits reach it on its next request. */
export interface LiveChatDeps {
	configs: Config[];
	toolNames: string[];
	providers: () => Record<Provider, ProviderConfig>;
	options: () => Options;
	cache: () => cacheType;
	cacheLength: () => cacheLength;
	compactSettings: () => CompactSettings;
	lore: LoreEntry[];
	setLore: SetStoreFunction<LoreEntry[]>;
	skillDirs: () => SkillDirs;
	agentSettings: () => AgentSettings;
	textDrip: () => boolean;
	setError: Setter<string | null>;
	setInfo: Setter<string | null>;
	notify: (title: string, body: string, sound?: 'done' | 'permission') => void;
	/** A sub-agent created its chat. */
	onChatCreated: () => void;
}

/** What the engine reaches in a mounted view: the session's UI hooks, and jumps to a message. */
export interface ChatViewController {
	onMessagesLoaded(): void;
	onUserAppend(index: number): void;
	afterAppend(): void;
	scrollToMessage(index: number): void;
}

/** One chat's state, engine and approval queue, all bound to its id. Plan: mds/live-chats.md */
export interface LiveChat {
	readonly id: string;
	readonly chat: ChatState;
	readonly setChat: SetStoreFunction<ChatState>;
	readonly session: ChatSession;
	/** The chat's config, its tool overrides applied. */
	config: () => Config | undefined;
	promptMessages: () => PromptMessage[];
	/** The skills the last scans found, as listed by `@@local_skills` and `@@global_skills`. */
	skills: () => { project: SkillEntry[]; global: SkillEntry[] };
	pendingPermissions: Accessor<PendingPermission[]>;
	resolvePermission: (id: string, approved: boolean, mode?: ToolApprove) => void;
	/** Resolves every pending approval with `reason`. */
	denyPermissions: (reason: string) => void;
	getChatMeta: () => ChatMeta;
	/** Applies (partial) meta over the current state and re-scans the derived macros. */
	applyChatMeta: (meta: Partial<ChatMeta>) => void;
	/** Writes meta and dirty messages and waits for the write queue to drain. */
	flush: () => Promise<void>;
	/** Writes meta right away, outside the write queue (window close). */
	saveMetaNow: () => Promise<unknown>;
	/** Reloads messages and meta from the db, dropping unsaved changes but keeping the draft. */
	reload: () => Promise<void>;
	/** The mounted view, while there is one. */
	view: ChatViewController | undefined;
	/** Stops effects and saves, drops unsaved changes and denies pending approvals. Flush first to keep changes. */
	dispose: () => void;
}

type StateDeps = Pick<LiveChatDeps, 'configs' | 'toolNames' | 'setInfo' | 'setError'>;

/** `prev` with `meta` applied. A config that no longer exists leaves `prev`'s in place, with a notice. */
export function stateFromMeta(prev: ChatState, meta: Partial<ChatMeta>, deps: StateDeps): ChatState {
	let configName = prev.configName;
	if (meta.configName) {
		if (deps.configs.some(c => c.name === meta.configName)) configName = meta.configName;
		else deps.setInfo(`Config "${meta.configName}" not found, keeping current config "${prev.configName}".`);
	}
	return applyMeta(prev, meta, {
		configName,
		configTools: deps.configs.find(c => c.name === configName)?.tools,
		toolNames: deps.toolNames,
		defaultSendMode: loadFromStorage<'loop' | 'single'>("send_mode", 'loop', true, deps.setError),
	});
}

/** The state of a chat opened from its saved meta. Cut, tool overrides and draft belong to one chat, so they reset when the meta has none. */
export function openedState(prev: ChatState, meta: ChatMeta | null, deps: StateDeps): ChatState {
	const fresh = { cut: -1, toolOverrides: {}, draft: emptyDraft() };
	return meta ? stateFromMeta(prev, { ...fresh, ...meta }, deps) : { ...prev, ...fresh };
}

function isOutsideFolder(folder: string, toolCall: any): boolean {
	if (!folder) return true; // no folder set → everything is "outside"
	const filePath: string = toolCall.function?.arguments?.path || '';
	const isAbsolute = /^[A-Za-z]:[\\/]|^\//.test(filePath);
	if (!isAbsolute) return false; // relative paths resolve within chat folder
	const normFolder = folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
	const normPath = filePath.replace(/\\/g, '/').toLowerCase();
	return !normPath.startsWith(normFolder + '/');
}

const AGENTS_MISSING = '[System: No agents.md in the top-level folder.]';
const skillsMissing = (scope: string) => `[System: No ${scope} skills exist]`;

/**
 * Builds a chat from its id and starting state. An empty id is a chat without a db row
 * (web, or desktop before the first load), which never saves its meta.
 */
export function createLiveChat(id: string, initial: ChatState, deps: LiveChatDeps): LiveChat {
	// A store of its own: nested objects in `initial` may still belong to another chat's store
	const [chat, setChat] = createStore<ChatState>(structuredClone(unwrap(initial)));
	let disposed = false;

	const baseConfig = () => deps.configs.find(c => c.name === chat.configName) ?? deps.configs[0];
	const config = (): Config | undefined => {
		const base = baseConfig();
		const tools = effectiveTools(base?.tools, chat.toolOverrides, deps.toolNames);
		return base && tools ? { ...base, tools } : base;
	};
	const promptMessages = (): PromptMessage[] => (baseConfig()?.prompts ?? [])
		.filter(p => p.enabled && modelMatchesTrigger(p.modelTrigger, chat.model).matches)
		.sort((a, b) => a.position - b.position)
		.map(p => ({
			role: p.role,
			content: msgVars(p.content, chat.macros, chat.model, chat.chatFolder, id),
			position: p.position,
			name: p.name,
		}));

	//#  Approvals
	const [pendingPermissions, setPendingPermissions] = createSignal<PendingPermission[]>([]);

	function requestPermission(toolCall: any, chatName?: string): Promise<true | string> {
		const outside = isOutsideFolder(chat.chatFolder, toolCall);
		const approve = outside ? chat.toolApproveOutside : chat.toolApprove;
		if (approve === 'always' || approve === 'chat') return Promise.resolve(true);
		// Nothing shows a closed chat's queue (a sub-agent can outlive its parent's view)
		if (disposed) return Promise.resolve('Edit denied: chat closed');
		// Notify since the loop is paused awaiting user action
		deps.notify('Edit pending approval', (chatName ? chatName + ' — ' : '') + toolCall.function?.name + ': ' + (toolCall.function?.arguments?.path || '').slice(0, 100), 'permission');
		return new Promise<true | string>(resolve => {
			setPendingPermissions(prev => [...prev, { id: toolCall.id, toolCall, resolve, outside, chatName }]);
		});
	}

	function resolvePermission(permissionId: string, approved: boolean, mode?: ToolApprove) {
		const pending = pendingPermissions().find(p => p.id === permissionId);
		if (!pending) return;
		if (mode && mode !== 'off') setChat(pending.outside ? 'toolApproveOutside' : 'toolApprove', mode);
		setPendingPermissions(prev => prev.filter(p => p.id !== permissionId));
		pending.resolve(approved ? true : pending.outside ? 'Edit denied by user (path is outside working folder). This is an expression of intent, do not try to bypass.' : 'Edit denied by user. This is an expression of intent, do not try to bypass.');
		// If mode upgraded to chat/always, auto-approve remaining same-category permissions
		if (approved && mode && mode !== 'off') {
			const same = (p: PendingPermission) => !!p.outside === !!pending.outside;
			for (const p of pendingPermissions()) if (same(p)) p.resolve(true);
			setPendingPermissions(prev => prev.filter(p => !same(p)));
		}
	}

	function denyPermissions(reason: string) {
		const pending = pendingPermissions();
		setPendingPermissions([]);
		for (const p of pending) p.resolve(reason);
	}

	//#  Session
	const env: SessionEnv = {
		chatId: () => id,
		model: () => chat.model, provider: () => chat.provider, providers: deps.providers, options: deps.options,
		activeConfig: config,
		promptMessages,
		cache: deps.cache, cacheLength: deps.cacheLength,
		macros: () => chat.macros, chatFolder: () => chat.chatFolder,
		cut: () => chat.cut, setCut: n => setChat('cut', n), sendMode: () => chat.sendMode,
		autoCompact: () => chat.autoCompact, compactSettings: deps.compactSettings,
		lore: deps.lore, setLore: deps.setLore,
		requestPermission,
		dismissPermission: permissionId => resolvePermission(permissionId, false),
		backend: () => backendFor(chat.backend),
		setError: deps.setError, setInfo: deps.setInfo,
		input: {
			value: () => chat.draft.text, images: () => chat.draft.images, files: () => chat.draft.files, role: () => chat.draft.role,
			clear: () => setChat('draft', { text: '', images: [], files: [] }),
			restore: (q) => setChat('draft', d => ({
				text: d.text ? q.content + '\n' + d.text : q.content,
				images: [...q.images, ...d.images],
				files: [...q.files, ...d.files],
			})),
		},
		// Sub-agents (Tauri only — web storage is single-chat). The runner snapshots this env at spawn time.
		spawnAgent: isTauri
			? (args, callId, parentChat) => runAgentTask({
				args,
				toolCallId: callId,
				parentChat,
				parentChatId: id,
				parentEnv: env,
				parentSession: session,
				settings: deps.agentSettings(),
				onChatCreated: deps.onChatCreated,
			})
			: undefined,
		onAbort: () => abortAgentsFor(id),
	};
	const session = createChatSession(env, {
		textDrip: deps.textDrip,
		onMessagesLoaded: () => self.view?.onMessagesLoaded(),
		onUserAppend: index => self.view?.onUserAppend(index),
		afterAppend: () => self.view?.afterAppend(),
		onStreamDone: content => deps.notify('Message received', content.slice(0, 200)),
	});

	//#  Meta
	function getChatMeta(): ChatMeta {
		const source = imageSource();
		return toChatMeta(chat, source?.kind === 'path' ? source.path : undefined);
	}

	const saveMeta = isTauri && id
		? leadingAndTrailing(throttle, () => session.enqueueWrite(v => saveChatMeta(getChatMeta(), id, v)), 2000)
		: undefined;

	function applyChatMeta(meta: Partial<ChatMeta>) {
		batch(() => {
			setChat(stateFromMeta(chat, meta, deps));
			if (isTauri) setImageSource(meta.imageFolder ? { kind: 'path', path: meta.imageFolder } : null);
		});
		// applyMeta dropped the derived macros, and the scan effects only re-fire when the folder changes
		const folder = chat.chatFolder;
		void loadAgentsMacro(folder);
		void loadLocalSkills(folder);
		void loadGlobalSkills();
		void loadWidgets(folder);
	}

	//#  Derived macros
	// Scans are async and the folder can change under them; only the newest one may write.
	const scanGen: Record<string, number> = {};

	/** Set a macro scanned from the environment, or drop it when there's nothing to inject. */
	function setDerivedMacro(key: string, value: string) {
		if (disposed) return;
		const prev = untrack(() => chat.macros);
		if (!value) {
			if (!(key in prev)) return;
			const { [key]: _dropped, ...rest } = prev;
			setChat({ macros: rest });
		} else if (prev[key] !== value) setChat({ macros: { ...prev, [key]: value } });
	}

	async function loadAgentsMacro(folder: string) {
		const gen = scanGen.agents = (scanGen.agents ?? 0) + 1;
		const set = (value: string) => gen === scanGen.agents && setDerivedMacro('agents', value);
		if (folder) {
			const backend = backendFor(chat.backend);
			try {
				const agentsFiles = await scanFolderFiles(folder, 'agents.md', backend);
				if (agentsFiles.length > 0) {
					const content = await readFileText(agentsFiles[0].path, backend);
					if (content.trim()) {
						set(`<agents_md>\n${content.trim()}\n</agents_md>`);
						return;
					}
				}
			} catch (e) {
				console.warn('Failed to read agents.md:', e);
			}
		}
		// No agents.md found or empty — let the model know rather than leaving @@agents literal
		set(AGENTS_MISSING);
	}

	const [projectSkills, setProjectSkills] = createSignal<SkillEntry[]>([]);
	const [globalSkills, setGlobalSkills] = createSignal<SkillEntry[]>([]);

	async function loadLocalSkills(folder: string) {
		const gen = scanGen.local_skills = (scanGen.local_skills ?? 0) + 1;
		const backend = backendFor(chat.backend);
		const skills = await discoverSkills(skillRoots(folder, PROJECT_SKILL_DIRS, deps.skillDirs().local), backend);
		if (disposed || gen !== scanGen.local_skills) return;
		setProjectSkills(skills.map(s => ({ ...s, backend })));
		setDerivedMacro('local_skills', formatSkills(skills, 'project') || skillsMissing('project'));
	}

	async function loadGlobalSkills() {
		const gen = scanGen.global_skills = (scanGen.global_skills ?? 0) + 1;
		const extra = deps.skillDirs().global;
		// Both homes on a remote chat: the local one plus the remote backend's. Local wins name collisions.
		const remote = backendFor(chat.backend);
		const homes = remote === localBackend ? [localBackend] : [localBackend, remote];
		const found = (await Promise.all(homes.map(async b =>
			(await discoverSkills(skillRoots(await b.homeDir(), HOME_SKILL_DIRS, extra), b)).map(s => ({ ...s, backend: b }))
		))).flat();
		const seen = new Set<string>();
		const skills = found.filter(s => {
			const key = s.name.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}).sort((a, b) => a.name.localeCompare(b.name));
		if (disposed || gen !== scanGen.global_skills) return;
		setGlobalSkills(skills);
		setDerivedMacro('global_skills', formatSkills(skills, 'user') || skillsMissing('global'));
	}

	async function loadWidgets(folder: string) {
		if (!isTauri) return;
		const gen = scanGen.widgets = (scanGen.widgets ?? 0) + 1;
		const backend = backendFor(chat.backend);
		const home = await backend.homeDir().catch(() => '');
		if (disposed || gen !== scanGen.widgets) return;
		const roots = [...skillRoots(folder, PROJECT_WIDGET_DIRS), ...skillRoots(home, HOME_WIDGET_DIRS)];
		// applyChatMeta just wiped the macro, and an unchanged list won't fire the registry effect
		if (await scanWidgets(roots, backend)) setWidgetsMacro();
	}

	function setWidgetsMacro() {
		setDerivedMacro('widgets', formatWidgets(widgetRegistry().widgets) || '[System: No widgets exist]');
	}

	const disposeRoot = createRoot(dispose => {
		createEffect(on(() => [chat.chatFolder, chat.backend] as const, ([folder]) => {
			void loadAgentsMacro(folder);
			void loadWidgets(folder);
		}));
		createEffect(on(() => [chat.chatFolder, deps.skillDirs().local, chat.backend] as const, ([folder]) => void loadLocalSkills(folder)));
		createEffect(on(() => [deps.skillDirs().global, chat.backend] as const, () => void loadGlobalSkills()));
		// Rescans triggered by show_widget or an inline tag
		createEffect(() => { if (widgetRegistry().scanned) setWidgetsMacro(); });
		if (saveMeta) {
			// Compared serialized, so re-scanned derived macros and no-op updates don't save
			const meta = createMemo(() => JSON.stringify(getChatMeta()));
			createEffect(on(meta, () => saveMeta(), { defer: true }));
		}
		return dispose;
	});

	const self: LiveChat = {
		id, chat, setChat, session,
		config, promptMessages,
		pendingPermissions, resolvePermission, denyPermissions,
		getChatMeta, applyChatMeta,
		async flush() {
			if (!saveMeta) return;
			saveMeta.clear();
			await session.enqueueWrite(v => saveChatMeta(getChatMeta(), id, v));
			await session.flush();
		},
		saveMetaNow() {
			if (!saveMeta) return Promise.resolve();
			saveMeta.clear();
			return saveChatMeta(getChatMeta(), id, session.version());
		},
		async reload() {
			if (!id) return;
			session.discardPending();
			saveMeta?.clear();
			const [messages, meta, row] = await Promise.all([loadChatMessages(id), loadChatMeta(id), getChat(id)]);
			if (disposed) return;
			if (meta) {
				const { draft: _draft, ...rest } = meta;
				applyChatMeta({ toolOverrides: {}, ...rest, cut: rest.cut ?? -1 });
			} else setChat({ cut: -1, toolOverrides: {} });
			session.load(messages, row?.version ?? 0);
		},
		skills: () => ({ project: projectSkills(), global: globalSkills() }),
		view: undefined,
		dispose() {
			if (disposed) return;
			disposed = true;
			saveMeta?.clear();
			disposeRoot();
			session.discardPending();
			denyPermissions('Edit denied: chat closed');
		},
	};
	return self;
}
