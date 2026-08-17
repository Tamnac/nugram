import { For, Show, Setter, createSignal, createMemo, onCleanup, createEffect, Index, createContext, useContext } from 'solid-js';
import Fuse from 'fuse.js';
import { SetStoreFunction } from 'solid-js/store'
import type { Options, ExtraBodyRule, cacheType, cacheLength, Provider, Prompt, Config, ProviderConfig, ToolApprove, AgentSettings, AgentPreset, TitlerSettings } from './helpers/types'
import { providerNames, DEFAULT_PROVIDERS, type BuiltinProvider } from './helpers/types';
import { tools, updateFetchUrlTool, updateWebSearchTool } from './helpers/tools';
import { ModelPicker } from './helpers/ModelPicker';
import { PromptManager, ConfigSelector, SamplingParameters } from './helpers/PromptManager';
import { TSeg } from './helpers/Comps'
import { LoreEntry } from './helpers/lore'

import { LoreManager } from './helpers/LoreManager';
import { TbOutlineTrashX, TbOutlinePlus, TbOutlineSettings2, TbOutlineMessages, TbOutlineAdjustmentsAlt, TbOutlinePencil, TbOutlineFolder, TbOutlineCopy, TbOutlineSearch, TbOutlineFolderSearch, TbOutlineChevronRight, TbOutlineChevronDown, TbOutlineDotsVertical, TbOutlineSparkles } from 'solid-icons/tb';
import { Portal } from 'solid-js/web';
import { isTauri, selectFolder, scanFolderFiles, readFileText } from './helpers/platform';
import { PROFILES, listBackups, createBackup, restoreBackup, applySettings, otherInstances, openBackupsFolder, loadBackupSettings, saveBackupSettings, lastBackupTime, type BackupFile, type BackupSettings, type ProfileName } from './helpers/backup';
import { confirmDialog } from './helpers/platform';
import type { Chat, MessageSearchResult } from './helpers/db';

type SidebarTab = 'settings' | 'chats' | 'current';

export function Sidebar(props: {
	prompts: Prompt[],
	setPrompts: SetStoreFunction<Prompt[]>,
	configs: Config[],
	setConfigs: SetStoreFunction<Config[]>,
	activeConfigName: string,
	setActiveConfigName: Setter<string>,
	cache: cacheType,
	setCache: Setter<cacheType>,
	cacheLength: cacheLength,
	setCacheLength: Setter<cacheLength>,
	options: Options,
	setOptions: SetStoreFunction<Options>,
	lore: LoreEntry[],
	setLore: SetStoreFunction<LoreEntry[]>,
	provider: Provider,
	setProvider: Setter<Provider>,
	theme: string,
	setTheme: Setter<string>,
	imageFolderHandle: FileSystemDirectoryHandle | null,
	setImageFolderHandle: Setter<FileSystemDirectoryHandle | null>,
	scanImageFolder: (dirHandle: FileSystemDirectoryHandle) => Promise<void>,
	contentVisibility: boolean,
	setContentVisibility: Setter<boolean>,
	providers: Record<Provider, ProviderConfig>,
	setProviders: Setter<Record<Provider, ProviderConfig>>,
	model: string,
	setError?: Setter<string | null> | undefined,
	setInfo?: Setter<string | null> | undefined,
	macros: Record<string, string>,
	setMacros: Setter<Record<string, string>>,
	loreId: string,
	textDrip: boolean,
	setTextDrip: Setter<boolean>,
	sidebarOpen: boolean,
	setSidebarOpen: Setter<boolean>,
	notifyMode: 'off' | 'sound' | 'notification',
	setNotifyMode: Setter<'off' | 'sound' | 'notification'>,
	notifyUnfocused: boolean,
	setNotifyUnfocused: Setter<boolean>,
	// Chat switcher (Tauri only)
	chatList?: Chat[],
	currentChatId?: string,
	runningChatIds?: Set<string>,
	onSwitchChat?: (id: string, addHistory?: boolean, scrollToIdx?: number) => void,
	onSearchMessages?: ((query: string, folders?: string[]) => Promise<MessageSearchResult[]>) | undefined,
	onCreateChat?: () => void,
	onCreateChatInFolder: ((folder: string) => void),
	onDeleteChat?: (id: string) => void,
	onRenameChat?: (id: string, name: string) => void,
	onDuplicateChat?: (id: string) => void,
	chatFolder?: string,
	setChatFolder?: (folder: string) => void,
	toolApprove?: ToolApprove,
	setToolApprove?: Setter<ToolApprove>,
	toolApproveOutside?: ToolApprove,
	setToolApproveOutside?: Setter<ToolApprove>,
	agentSettings?: AgentSettings,
	setAgentSettings?: Setter<AgentSettings>,
	titlerSettings?: TitlerSettings,
	setTitlerSettings?: Setter<TitlerSettings>,
	onGenerateTitle?: ((id: string) => Promise<boolean>) | undefined,
}) {

	const [activeTab, setActiveTab] = createSignal<SidebarTab>(
		(localStorage.getItem('sidebarTab') as SidebarTab) || 'current'
	);

	const activeConfigIndex = createMemo(() => {
		const i = props.configs.findIndex(c => c.name === props.activeConfigName);
		return i >= 0 ? i : 0;
	});
	const activeConfig = createMemo(() => props.configs[activeConfigIndex()]);
	
	const extraBodyRules = () => props.options.extra_body ?? [];
	function validateExtraBodyRule(rule: ExtraBodyRule): { providerError?: string; modelError?: string; bodyError?: string } {
		const providerPat = rule.providerPattern?.trim() ?? '';
		if (providerPat) {
			try { new RegExp(providerPat, 'i'); } catch (e: any) { return { providerError: `Provider regex: ${e.message}` }; }
		}
		const modelPat = rule.modelPattern?.trim() ?? '';
		if (modelPat) {
			try { new RegExp(modelPat, 'i'); } catch (e: any) { return { modelError: `Model regex: ${e.message}` }; }
		}
		const raw = rule.body?.trim() ?? '';
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
				return { bodyError: 'Body must be a JSON object' };
			return {};
		} catch (e: any) {
			return { bodyError: e.message as string };
		}
	}
	const anyExtraBodyError = createMemo(() =>
		extraBodyRules().some(r => Object.keys(validateExtraBodyRule(r)).length > 0)
	);
	const switchTab = (tab: SidebarTab) => { localStorage.setItem('sidebarTab', tab); setActiveTab(tab); };

	return (
		<Show when={props.sidebarOpen}>
			<div class="sidebar-overlay" onClick={() => props.setSidebarOpen(false)} />
			<div class="sidebar">
			{/* # Tab bar ────────────────────────────────────────── */}
			<div class="sidebar-tabs">
				<button
					classList={{ 'sidebar-tab': true, 'sidebar-tab-active': activeTab() === 'settings' }}
					onClick={() => switchTab('settings')}
					title="Settings"
				>
					<TbOutlineSettings2 size={20} />
				</button>
				<Show when={isTauri}>
					<button
						classList={{ 'sidebar-tab': true, 'sidebar-tab-active': activeTab() === 'chats' }}
						onClick={() => switchTab('chats')}
						title="Chats"
					>
						<TbOutlineMessages size={20} />
					</button>
				</Show>
				<button
					classList={{ 'sidebar-tab': true, 'sidebar-tab-active': activeTab() === 'current' }}
					onClick={() => switchTab('current')}
					title="Current Chat"
				>
					<TbOutlineAdjustmentsAlt size={20} />
				</button>
			</div>

			{/* # Settings tab ───────────────────────────────────── */}
			<Show when={activeTab() === 'settings'}>
				<label style="margin-bottom: 8px;" title='Select theme'>
					Theme
					<select
						value={props.theme}
						onInput={e => props.setTheme(e.target.value)}>
						<option value="fantasy">Fantasy</option>
						<option value="scifi">Sci-Fi</option>
						<option value="literature">Literature</option>
						<option value="modern">Modern</option>
					</select>
				</label>

				<h3 class='settings-header'>Display</h3>

				<label title="Skip rendering offscreen messages for performance (faster load but slower editing messages)">
					<input
						type="checkbox"
						checked={props.contentVisibility}
						onInput={e => props.setContentVisibility(e.target.checked)}
					/>
					<span>Skip offscreen (faster load but slower editing messages)</span>
				</label>

				<label title="Buffer and drip incoming text for smoother streaming">
					<input
						type="checkbox"
						checked={props.textDrip}
						onInput={e => props.setTextDrip(e.target.checked)}
					/>
					<span>Smooth streaming</span>
				</label>

				<label title="How to notify when a message finishes while the window is hidden">
					<span>Notify on finish</span>
					<select
						value={props.notifyMode}
						onChange={e => props.setNotifyMode(e.target.value as 'off' | 'sound' | 'notification')}
					>
						<option value="off">Off</option>
						<option value="sound">Sound only</option>
						<option value="notification">Notification</option>
					</select>
				</label>

				<label title="Also notify when the window is unfocused, not just hidden">
					<input type="checkbox"
						checked={props.notifyUnfocused}
						onInput={e => props.setNotifyUnfocused(e.target.checked)}
					/>
					<span>Notify when unfocused (not just hidden)</span>
				</label>

				<ImageFolderSelector
					imageFolderHandle={props.imageFolderHandle}
					setImageFolderHandle={props.setImageFolderHandle}
					scanImageFolder={props.scanImageFolder}
				/>

				<ProviderManager providers={props.providers} setProviders={props.setProviders} provider={props.provider} />

				<details class='sidebar-section'>
					<summary>
						<span class='sidebar-section-title'>Extra body args</span>
						<Show when={extraBodyRules().length > 0}>
							<span class={`sampler-match-badge ${anyExtraBodyError() ? 'invalid' : 'match'}`} style='margin-left: 8px'>
								{anyExtraBodyError() ? '✕' : '✓'}
							</span>
						</Show>
					</summary>
					<div class='extra-body-rules'>
						<For each={extraBodyRules()}>
							{(rule, i) => {
								const errors = createMemo(() => validateExtraBodyRule(rule));
								const updateRule = <K extends keyof ExtraBodyRule>(key: K, value: ExtraBodyRule[K]) =>
									props.setOptions('extra_body', i(), key, value);
								const removeRule = () =>
									props.setOptions('extra_body', rules => (rules ?? []).filter((_, j) => j !== i()));
								return (
									<div class='extra-body-rule'>
										<div class='extra-body-patterns'>
											<input
												class='extra-body-pattern-input'
												type='text'
												placeholder='provider regex'
												value={rule.providerPattern}
												onInput={e => updateRule('providerPattern', e.target.value)}
												spellcheck={false}
											/>
											<span class='extra-body-pattern-sep'>/</span>
											<input
												class='extra-body-pattern-input'
												type='text'
												placeholder='model regex'
												value={rule.modelPattern}
												onInput={e => updateRule('modelPattern', e.target.value)}
												spellcheck={false}
											/>
											<button class='slim-but red' onClick={removeRule} title='Remove rule'>×</button>
										</div>
										<textarea
											class={`prompt extra-body-input ${Object.keys(errors()).length > 0 ? 'invalid' : ''}`}
											placeholder={'JSON merged into the request body when patterns match, e.g.\n{ "provider": { "order": ["openai"] } }'}
											value={rule.body}
											onInput={e => updateRule('body', e.target.value)}
											rows={4}
											spellcheck={false}
										/>
										<Show when={errors().providerError || errors().modelError || errors().bodyError}>
											<div class='extra-body-error'>
												{errors().providerError || errors().modelError || errors().bodyError}
											</div>
										</Show>
									</div>
								);
							}}
						</For>
						<button class='slim-but' onClick={() => props.setOptions('extra_body', rules =>
							[...(rules ?? []), { providerPattern: '', modelPattern: '', body: '' }]
						)}>Add rule</button>
					</div>
				</details>

				<Show when={isTauri && props.titlerSettings && props.setTitlerSettings}>
					<TitlerManager settings={props.titlerSettings!} setSettings={props.setTitlerSettings!} providers={props.providers} />
				</Show>

				<Show when={isTauri && props.agentSettings && props.setAgentSettings}>
					<AgentManager settings={props.agentSettings!} setSettings={props.setAgentSettings!} providers={props.providers} />
				</Show>

				<Show when={isTauri}>
					<BackupManager setError={props.setError} setInfo={props.setInfo} />
				</Show>
			</Show>

			{/*#  Chats tab (Tauri only) */}
			<Show when={activeTab() === 'chats'}>
				<ChatSwitcher
					chatList={props.chatList || []}
					currentChatId={props.currentChatId || ''}
					runningChatIds={props.runningChatIds}
					currentChatFolder={props.chatFolder}
					onSwitchChat={props.onSwitchChat || (() => {})}
					onSearchMessages={props.onSearchMessages}
					onCreateChat={props.onCreateChat || (() => {})}
					onCreateChatInFolder={props.onCreateChatInFolder}
					onDeleteChat={props.onDeleteChat || (() => {})}
					onRenameChat={props.onRenameChat || (() => {})}
					onDuplicateChat={props.onDuplicateChat || (() => {})}
					onGenerateTitle={props.onGenerateTitle}
				/>
			</Show>

			{/*#  Current Chat tab */}
			<Show when={activeTab() === 'current'}>
				<ConfigSelector
					configs={props.configs}
					setConfigs={props.setConfigs}
					activeConfigName={props.activeConfigName}
					setActiveConfigName={props.setActiveConfigName}
					setError={props.setError}
					setInfo={props.setInfo}
					model={props.model}
				/>

				<details class='sidebar-section'>
					<summary>
						<span class='sidebar-section-title'>Prompts</span>
						<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
							{props.prompts.filter(p => p.enabled).length} active
						</span>
					</summary>
					<PromptManager prompts={props.prompts} setPrompts={props.setPrompts} model={props.model} />
				</details>

				<SamplingParameters
					options={props.options}
					setOptions={props.setOptions}
					provider={props.provider}
					configs={props.configs}
					setConfigs={props.setConfigs}
					activeConfigName={props.activeConfigName}
					model={props.model}
				/>

				<details class='sidebar-section tools-section'>
					<summary><span class='sidebar-section-title'>Tools</span></summary>
					<For each={tools}>
					{tool => (
						<label>
							<input type="checkbox"
								checked={activeConfig()?.tools?.[tool.function.name] === true}
								onInput={e => props.setConfigs(activeConfigIndex(), 'tools', prev => ({ ...(prev ?? {}), [tool.function.name]: e.target.checked }))}
							/>
							<span>{tool.function.name}</span>
						</label>
					)}
					</For>
				</details>

				<Show when={isTauri && props.setChatFolder}>
					<FolderPicker
						chatList={props.chatList || []}
						chatFolder={props.chatFolder}
						setChatFolder={props.setChatFolder!}
					/>
				</Show>

				<Show when={props.currentChatId}>
					<div class='chat-id-row'>
						<span class='chat-id-label'>ID</span>
						<button class='chat-id-value' onClick={() => navigator.clipboard.writeText(props.currentChatId!)} title='Copy chat ID'>
							{props.currentChatId}
							<TbOutlineCopy size={12} />
						</button>
					</div>
				</Show>


				<h3 class='sidebar-section-title'>Chat Options</h3>
				<label title="Send a random seed with each request to avoid repeated outputs">
					<span>Random seed</span>
					<input
						type="checkbox"
						checked={props.options.random_seed}
						onInput={e => props.setOptions('random_seed', e.target.checked)}
					/>
				</label>

				<Show when={props.provider === 'or' || props.provider === 'anth_local' || props.provider == 'nano'}><label><span>Claude Cache</span>
					<TSeg options={{ anth: 'Anth', none: 'None' }} selected={props.cache} setSelected={props.setCache} tooltips={{anth: 'Add cache_control blocks for anthropic'}}></TSeg>

					<Show when={props.cache !== 'none'}>
						<TSeg options={{ '5m': '5m', '1h': '1h' }} selected={props.cacheLength} setSelected={props.setCacheLength} tooltips={{'5m': 'Cache for 5 minutes (1.25x cost)', '1h': 'Cache for 1 hours (2x cost)'}}></TSeg>
					</Show>
				</label></Show>

				<h3 class='sidebar-section-title'>Reasoning</h3>
				<label title="Reasoning effort level">
					<span>Effort</span>
					<TSeg
						options={{ none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }}
						selected={activeConfig()?.reasoning?.effort || 'none'}
						setSelected={v => props.setConfigs(activeConfigIndex(), 'reasoning', { effort: v as 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' })}
					/>
				</label>

				<label title="Pass reasoning back for continuity. Interleaved: provider decides retention. Full: request full history (ZAI/Fireworks/Neuralwatt)">
					<span>Preserve</span>
					<TSeg options={{ off: 'Off', interleaved: 'Interleaved', full: 'Full' }}
						selected={activeConfig()?.preserveReasoning || 'off'}
						setSelected={v => props.setConfigs(activeConfigIndex(), 'preserveReasoning', v as 'off' | 'interleaved' | 'full')} 
						tooltips={{off: "Don't send any reasoning", interleaved: "Model default, usually around tool calls or since last user message", full: "All reasoning, when provider supported"}}/>
				</label>

				<label>
					<span>Prefill</span>
					<input
						type="checkbox"
						checked={activeConfig()?.reasoningPrefill?.enabled ?? false}
						onInput={e => props.setConfigs(activeConfigIndex(), 'reasoningPrefill', prev => ({ ...(prev ?? { enabled: false, content: '' }), enabled: e.target.checked }))}
					/>
				</label>
				<Show when={activeConfig()?.reasoningPrefill?.enabled}>
					<textarea
						class='prompt'
						placeholder="Enter reasoning template here..."
						value={activeConfig()?.reasoningPrefill?.content ?? ''}
						onInput={e => props.setConfigs(activeConfigIndex(), 'reasoningPrefill', prev => ({ ...(prev ?? { enabled: false, content: '' }), content: e.target.value }))}
						rows={4}
					/>
				</Show>

				<Show when={isTauri && props.setToolApprove}>
					<h3 class='sidebar-section-title'>Permissions</h3>
						<label> <span>Approve edits</span>
							<TSeg options={{ off: 'Off', chat: 'Chat', always: 'Always' }} selected={props.toolApprove || 'off'} setSelected={props.setToolApprove as Setter<string>} 
								tooltips={{off: 'Require permission every edit', chat: 'Allow all edits in this chat', always: 'Allow all edits in all chats'}}/>
						</label>
						<label><span>Outside folder</span>
							<TSeg options={{ off: 'Off', chat: 'Chat', always: 'Always' }} selected={props.toolApproveOutside || 'off'} setSelected={props.setToolApproveOutside as Setter<string>} 
								tooltips={{off: 'Require permission every outside edit', chat: 'Allow all outside edits in this chat', always: 'Allow all outside edits in all chats'}}/>
						</label>
				</Show>

				<MacroManager macros={props.macros} setMacros={props.setMacros} />
				<Show when={!isTauri}>
					<details class='sidebar-section'>
						<summary><span style='font-family: var(--font-ui); font-weight: bold'>Lore</span></summary>
						<LoreManager lore={props.lore} setLore={props.setLore} loreId={props.loreId} setError={props.setError} />
					</details>
				</Show>
			</Show>
		</div>
		</Show>
	)
}

// ── Chat Switcher (Tauri only) ──────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(timestamp).toLocaleDateString();
}

const FUSE_OPTIONS = {
	keys: ['path'],
	includeMatches: false,
	ignoreLocation: true,
	useExtendedSearch: true,
	threshold: 0.4,
};

const NOFOLDER = 'special::nofolder';

function folderLabel(folder: string): string {
	if (!folder || folder === NOFOLDER) return 'No folder';
	const parts = folder.split(/[/\\]/);
	return parts[parts.length - 1] || folder;
}

const HOME_RE = /^(?:[a-zA-Z]:\/Users\/|\/(?:home|Users)\/)[^/]+/;

/** Display form: home dir as ~, deep paths collapsed to `~/…/parent/leaf` */
function shortenPath(folder: string): string {
	if (!folder) return folder;
	const path = folder.replace(/\\/g, '/').replace(/\/+$/, '').replace(HOME_RE, '~');
	const parts = path.split('/');
	if (parts.length <= 3) return path;
	return [parts[0], '…', ...parts.slice(-2)].join('/');
}

function folderParent(folder: string): string {
	if (!folder) return '';
	const parts = folder.split(/[/\\]/);
	parts.pop();
	return parts.join('/') || parts.join('\\') || '';
}

interface FolderOption { path: string; name: string; parent: string }

function FolderPicker(props: {
	chatList: Chat[];
	chatFolder: string | undefined;
	setChatFolder: (folder: string) => void;
}) {
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal('');
	const [highlighted, setHighlighted] = createSignal(0);
	const [fuse, setFuse] = createSignal<Fuse<FolderOption> | null>(null);

	const knownFolders = createMemo(() => {
		const byFolder = new Map<string, number>();
		for (const chat of props.chatList) {
			const f = chat.chat_folder;
			if (!f) continue;
			const t = Math.max(byFolder.get(f) || 0, chat.updated);
			byFolder.set(f, t);
		}
		const arr = Array.from(byFolder.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([path]) => ({ path, name: folderLabel(path), parent: folderParent(path) }));
		return arr;
	});

	createEffect(() => {
		setFuse(new Fuse(knownFolders(), FUSE_OPTIONS));
	});

	const filtered = createMemo(() => {
		const q = query().trim();
		if (!q) return knownFolders();
		return fuse()?.search(q).map(r => r.item) ?? knownFolders();
	});

	// Reset highlight when results change
	createEffect(() => { filtered(); setHighlighted(0); });

	function moveHighlight(delta: number) {
		const len = filtered().length;
		if (len === 0) return;
		setHighlighted(i => (i + delta + len) % len);
	}

	// Scroll highlighted item into view on navigation
	createEffect(() => {
		const h = highlighted();
		if (!open() || !containerRef) return;
		const el = containerRef.querySelector('.folder-picker-item-active');
		el?.scrollIntoView({ block: 'nearest' });
	});

	async function browse() {
		const folder = await selectFolder();
		if (!folder) return;
		props.setChatFolder(folder);
		setOpen(false);
		setQuery('');
	}

	function select(folder: string) {
		props.setChatFolder(folder);
		setOpen(false);
		setQuery('');
	}

	function clear() {
		props.setChatFolder('');
	}

	// Close on click outside
	let containerRef: HTMLDivElement | undefined;
	function onDocClick(e: MouseEvent) {
		if (!containerRef?.contains(e.target as Node)) setOpen(false);
	}
	createEffect(() => {
		if (open()) document.addEventListener('mousedown', onDocClick);
		else document.removeEventListener('mousedown', onDocClick);
	});
	onCleanup(() => document.removeEventListener('mousedown', onDocClick));

	return (
		<div class='folder-picker' ref={containerRef}>
			<div class='chat-id-row'>
				<span class='chat-id-label'>Folder</span>
				<button class='chat-id-value folder-picker-trigger' title={props.chatFolder || undefined} onClick={() => setOpen(o => !o)}>
					{props.chatFolder ? shortenPath(props.chatFolder) : 'Select folder...'}
				</button>
				<Show when={props.chatFolder}>
					<button class='slim-but' onClick={clear} title='Clear folder'>×</button>
				</Show>
			</div>
			<Show when={open()}>
				<div class='folder-picker-dropdown'>
					<div class='folder-picker-search'>
						<TbOutlineSearch size={14} />
						<input
							type='text'
							placeholder='Search folders...'
							value={query()}
							onInput={e => setQuery(e.currentTarget.value)}
							onKeyDown={e => {
								if (e.key === 'Escape') {
									setOpen(false);
									setQuery('');
								}
								if (e.key === 'Enter') {
									e.preventDefault();
									const item = filtered()[highlighted()];
									if (item) select(item.path);
								}
								if (e.key === 'ArrowDown') {
									e.preventDefault();
									moveHighlight(1);
								}
								if (e.key === 'ArrowUp') {
									e.preventDefault();
									moveHighlight(-1);
								}
							}}
							ref={el => setTimeout(() => el.focus(), 0)}
						/>
					</div>
					<div class='folder-picker-list'>
						<For each={filtered()}>
							{(opt, selectedIndex) => (
								<button
									classList={{ 'folder-picker-item': true, 'folder-picker-item-active': selectedIndex() === highlighted() }}
									title={opt.path}
									onClick={() => select(opt.path)}
								>
									<span class='folder-picker-name'>{opt.name}</span>
									<Show when={opt.parent}>
										<span class='folder-picker-parent'>{shortenPath(opt.parent)}</span>
									</Show>
								</button>
							)}
						</For>
						<Show when={filtered().length === 0}>
							<div class='folder-picker-empty'>No folders found</div>
						</Show>
					</div>
					<button class='folder-picker-browse' onClick={browse}>
						<TbOutlineFolder size={14} />
						<span>Browse system...</span>
					</button>
				</div>
			</Show>
		</div>
	);
}

type ChatNode = { chat: Chat, children: Chat[] };

type ChatListCtx = {
	currentChatId: string,
	runningChatIds: Set<string>,
	onSwitch: (id: string) => void,
	onDelete: (id: string) => void,
	onRename: (id: string, name: string) => void,
	onDuplicate: (id: string) => void,
	onGenerateTitle?: ((id: string) => Promise<boolean>) | undefined,
};
const ChatListContext = createContext<ChatListCtx>();

function ChatItem(props: {
	chat: Chat,
	children?: Chat[] | undefined,
	isChild?: boolean,
}) {
	const ctx = useContext(ChatListContext)!;
	const [editing, setEditing] = createSignal(false);
	const [menuOpen, setMenuOpen] = createSignal(false);
	const [menuPos, setMenuPos] = createSignal<Record<string, string>>({});
	let menuBtn!: HTMLButtonElement;
	let menuEl: HTMLDivElement | undefined;

	createEffect(() => {
		if (!menuOpen()) return;
		const rect = menuBtn.getBoundingClientRect();
		setMenuPos({ top: `${rect.bottom + 4}px`, left: `${Math.max(8, rect.right - 150)}px` });
		function onDocClick(e: MouseEvent) {
			const t = e.target as Node;
			if (!menuBtn.contains(t) && !menuEl?.contains(t)) setMenuOpen(false);
		}
		document.addEventListener('mousedown', onDocClick);
		onCleanup(() => document.removeEventListener('mousedown', onDocClick));
	});
	const [editName, setEditName] = createSignal('');
	const running = () => ctx.runningChatIds.has(props.chat.id);
	const hasChildren = () => !!props.children?.length;
	const [childrenExpanded, setChildrenExpanded] = createSignal<boolean | undefined>(undefined);
	const showChildren = () => hasChildren() && (childrenExpanded() ?? (props.chat.id === ctx.currentChatId || props.children!.some(c => c.id === ctx.currentChatId)));

	function startRename() {
		setEditName(props.chat.name);
		setEditing(true);
	}

	function commitRename() {
		const name = editName().trim();
		if (name) ctx.onRename(props.chat.id, name);
		setEditing(false);
	}

	async function handleDelete(e: Event) {
		e.stopPropagation();
		if (await confirmDialog('Delete this chat? This cannot be undone.'))
			ctx.onDelete(props.chat.id);
	}

	return (
		<>
		<div
			classList={{ 'chat-item': true, 'chat-item-active': props.chat.id === ctx.currentChatId, 'chat-item-child': !!props.isChild }}
			onClick={() => ctx.onSwitch(props.chat.id)}
		>
			<Show when={editing()} fallback={
				<>
					<Show when={running()}><span class="chat-item-spinner" title="running" /></Show>
					<div class="chat-item-info">
						<span class="chat-item-name">{props.chat.name}</span>
						<span class="chat-item-date">{formatRelativeTime(props.chat.updated)}</span>
					</div>
					<Show when={hasChildren()}>
						<button
							class="chat-item-expand slim-but"
							classList={{ 'chat-item-expanded': showChildren() }}
							onClick={e => { e.stopPropagation(); setChildrenExpanded(!showChildren()); }}
							title={showChildren() ? 'Collapse forks' : `Show ${props.children!.length} fork${props.children!.length > 1 ? 's' : ''}`}
						>
							<Show when={showChildren()} fallback={<TbOutlineChevronRight size={14} />}>
								<TbOutlineChevronDown size={14} />
							</Show>
						</button>
					</Show>
					<div class="chat-item-actions">
						<button ref={menuBtn} class="slim-but" onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }} title="Actions">
							<TbOutlineDotsVertical size={14} />
						</button>
					</div>
					<Show when={menuOpen()}>
						<Portal mount={document.body}>
							<div ref={menuEl} class="chat-item-menu" style={menuPos()} onClick={e => e.stopPropagation()}>
								<button onClick={() => { setMenuOpen(false); startRename(); }}><TbOutlinePencil size={14} /> Rename</button>
								<button onClick={() => { setMenuOpen(false); ctx.onDuplicate(props.chat.id); }}><TbOutlineCopy size={14} /> Duplicate</button>
								<Show when={ctx.onGenerateTitle}>
									<button onClick={() => { setMenuOpen(false); void ctx.onGenerateTitle!(props.chat.id); }}><TbOutlineSparkles size={14} /> Generate title</button>
								</Show>
								<button class="chat-item-menu-danger" onClick={e => { setMenuOpen(false); handleDelete(e); }}><TbOutlineTrashX size={14} /> Delete</button>
							</div>
						</Portal>
					</Show>
				</>
			}>
				<input
					class="chat-rename-input"
					value={editName()}
					onInput={e => setEditName(e.currentTarget.value)}
					onBlur={() => commitRename()}
					onKeyDown={e => {
						if (e.key === 'Enter') commitRename();
						if (e.key === 'Escape') setEditing(false);
					}}
					onClick={e => e.stopPropagation()}
					ref={el => setTimeout(() => el.focus(), 0)}
				/>
			</Show>
		</div>
		<Show when={showChildren()}>
			<div class="chat-item-children">
				<For each={props.children}>
				{child => (
					<ChatItem chat={child} isChild />
				)}
				</For>
			</div>
		</Show>
		</>
	);
}

const COLLAPSED_LIMIT = 3;

function ChatGroup(props: {
	folder: string,
	nodes: ChatNode[],
	isCurrent: boolean,
	onCreateInFolder?: ((folder: string) => void) | undefined,
	expanded: () => boolean,
	onToggleExpand: () => void,
}) {
	const ctx = useContext(ChatListContext)!;
	const expanded = () => props.expanded();
	const hasCurrent = (n: ChatNode) => n.chat.id === ctx.currentChatId || n.children.some(c => c.id === ctx.currentChatId);
	const collapsible = () => props.nodes.length > COLLAPSED_LIMIT;
	const visibleNodes = () => {
		if (!collapsible() || expanded()) return props.nodes;
		const hiddenIdx = props.nodes.slice(COLLAPSED_LIMIT).findIndex(hasCurrent);
		if (hiddenIdx === -1) return props.nodes.slice(0, COLLAPSED_LIMIT);
		// Swap the active node into the visible slice, displacing the last visible one
		const reordered = props.nodes.slice(0, COLLAPSED_LIMIT);
		reordered[COLLAPSED_LIMIT - 1] = props.nodes[COLLAPSED_LIMIT + hiddenIdx];
		return reordered;
	};
	const hiddenCount = () => {
		const extra = props.nodes.length - COLLAPSED_LIMIT;
		if (!collapsible() || expanded()) return 0;
		const hasActiveHidden = props.nodes.slice(COLLAPSED_LIMIT).some(hasCurrent);
		return hasActiveHidden ? extra - 1 : extra;
	};

	return (
		<>
			<div data-folder={props.folder} classList={{'chat-folder-header': true, 'chat-folder-header-current': props.isCurrent}}
				title={props.folder || undefined}
				style="justify-content: space-between;"
			>
				<div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
					<TbOutlineFolder size={14} />
					<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{folderLabel(props.folder)}</span>
				</div>
				<Show when={props.onCreateInFolder}>
					<button class="slim-but" onClick={e => { 
							e.stopPropagation(); 
							props.onCreateInFolder!(props.folder === NOFOLDER ? '' : props.folder); 
						}} 
						title="New chat in folder"
						>
						<TbOutlinePlus size={14} />
					</button>
				</Show>
			</div>
			<For each={visibleNodes()}>
			{node => (
				<ChatItem chat={node.chat} children={node.children} />
			)}
			</For>
			<Show when={collapsible()}>
				<button
					class="chat-folder-toggle"
					onClick={() => props.onToggleExpand()}
				>
					{expanded() ? 'show less' : `${hiddenCount()} more…`}
				</button>
			</Show>
		</>
	);
}

function ChatSwitcher(props: {
	chatList: Chat[],
	currentChatId: string,
	currentChatFolder?: string | undefined,
	runningChatIds?: Set<string> | undefined,
	onSwitchChat: (id: string, addHistory?: boolean, scrollToIdx?: number) => void,
	onSearchMessages?: ((query: string, folders?: string[]) => Promise<MessageSearchResult[]>) | undefined,
	onCreateChat: () => void,
	onCreateChatInFolder: ((folder: string) => void),
	onDeleteChat: (id: string) => void,
	onRenameChat: (id: string, name: string) => void,
	onDuplicateChat: (id: string) => void,
	onGenerateTitle?: ((id: string) => Promise<boolean>) | undefined,
}) {
	// Capture once on mount — keeps sort order stable when switching between chats
	const pinnedFolder = props.currentChatFolder || NOFOLDER;
	// Two-phase search: titles filter live (in-memory, free), message contents are
	// an explicit second step (hits SQLite FTS) so typing never queries the db.
	const [query, setQuery] = createSignal('');
	const [contentResults, setContentResults] = createSignal<MessageSearchResult[] | null>(null);
	const [searching, setSearching] = createSignal(false);

	// `folder:name rest` scopes the search to a folder; `folder:name` on its own
	// lists folders. Quote the term for names with spaces (the UI always does).
	const parsed = createMemo(() => {
		const m = /^\s*folder:(?:"([^"]*)"|(\S*))\s*([\s\S]*)$/i.exec(query());
		if (!m) return { folderTerm: null, text: query().trim() };
		return { folderTerm: m[1] ?? m[2] ?? '', text: m[3].trim() };
	});

	/** Folder paths the current `folder:` term resolves to (all folders if blank). */
	const folderScope = createMemo(() => {
		const term = parsed().folderTerm;
		if (term === null) return null;
		return folderMatches(term).map(f => f.path);
	});

	/** Chats within the folder scope — the whole list when unscoped. */
	const scopedChats = createMemo(() => {
		const scope = folderScope();
		if (!scope) return props.chatList;
		const set = new Set(scope);
		return props.chatList.filter(c => set.has(c.chat_folder || NOFOLDER));
	});

	// Deliberately not FUSE_OPTIONS: its useExtendedSearch makes leading !, ^, $
	// and | operators, which is wrong for free-text titles.
	const titleFuse = createMemo(() => new Fuse(scopedChats(), {
		keys: ['name'], ignoreLocation: true, threshold: 0.4,
	}));

	const chatSearch = createMemo(() => {
		const q = parsed().text;
		if (!q) return [];
		const lq = q.toLowerCase();
		const byTitle = titleFuse().search(q, { limit: 20 })
			.map(r => ({ chat: r.item, byId: false }));
		
		// avoid duplicates
		const seen = new Set(byTitle.map(m => m.chat.id));
		const byId = scopedChats()
			.filter(c => !seen.has(c.id) && c.id.toLowerCase().includes(lq))
			.map(chat => ({ chat, byId: true }));
		return [...byId, ...byTitle];
	});

	// Folder options, indexed for fuzzy matching. Depends only on the chat list, so
	// it's memoized separately from the query to avoid rebuilding the index per keystroke.
	const folderOptions = createMemo(() => {
		const byFolder = new Map<string, number>();
		for (const c of props.chatList) {
			const f = c.chat_folder || NOFOLDER;
			byFolder.set(f, (byFolder.get(f) || 0) + 1);
		}
		const options = Array.from(byFolder.entries())
			.map(([path, count]) => ({
				path,
				name: folderLabel(path === NOFOLDER ? '' : path),
				parent: folderParent(path === NOFOLDER ? '' : path),
				count,
			}));
		return {
			options,
			fuse: new Fuse(options, { keys: ['name', 'path'], ignoreLocation: true, threshold: 0.4 }),
		};
	});

	/** Folders matching `term`: everything when blank, exact label/path hits when there
	 *  are any (so a name that prefixes another folder isn't ambiguous), else fuzzy. */
	function folderMatches(term: string) {
		const { options, fuse } = folderOptions();
		const t = term.trim();
		if (!t) return options;
		const lt = t.toLowerCase();
		const exact = options.filter(o => o.name.toLowerCase() === lt || o.path.toLowerCase() === lt);
		if (exact.length) return exact;
		return fuse.search(t, { limit: 10 }).map(r => r.item);
	}

	// Folders match live alongside titles, and are the only results while a `folder:`
	// term is being narrowed down.
	const folderSearch = createMemo(() => {
		const { folderTerm, text } = parsed();
		if (folderTerm !== null) return text ? [] : folderMatches(folderTerm);
		return text ? folderMatches(text) : [];
	});

	function jumpToFolder(folder: string) {
		setQuery('');
		setContentResults(null);
		// The list is hidden while a query is active; wait a frame for it to show,
		// then scroll the folder header into the visible area.
		requestAnimationFrame(() => {
			const el = document.querySelector(`[data-folder="${CSS.escape(folder)}"]`);
			el?.scrollIntoView({ block: 'nearest' });
		});
	}

	/** `folder:` token for a folder term, quoted only when it needs to be. */
	const folderToken = (term: string) => `folder:${/\s/.test(term) ? `"${term}"` : term} `;

	let searchInput: HTMLInputElement | undefined;
	function scopeToFolder(f: { name: string, path: string }) {
		// Labels are just the leaf name, so fall back to the full path when two
		// folders share one — otherwise the term would resolve to both.
		const ambiguous = folderOptions().options.filter(o => o.name === f.name).length > 1;
		setQuery(folderToken(ambiguous ? f.path : f.name));
		setContentResults(null);
		searchInput?.focus();
	}

	/** Toggle the folder-only mode, carrying the typed text across in both directions. */
	function toggleFolderOnly() {
		const { folderTerm, text } = parsed();
		setQuery(folderTerm === null ? folderToken(text).trimEnd() : [folderTerm, text].filter(Boolean).join(' '));
		setContentResults(null);
		searchInput?.focus();
	}

	async function runContentSearch() {
		const { text: q, folderTerm } = parsed();
		const folders = folderScope();
		if (!q || !props.onSearchMessages || searching()) return;
		setSearching(true);
		try {
			// NOFOLDER is a display-only sentinel; the db knows unfoldered chats as ''
			const hits = await props.onSearchMessages(q, folders?.map(f => f === NOFOLDER ? '' : f));
			// Ignore a result set the user has already typed or re-scoped past
			const now = parsed();
			if (now.text === q && now.folderTerm === folderTerm) setContentResults(hits);
		} finally {
			setSearching(false);
		}
	}

	// Track expanded folders here so state survives ChatGroup remounts on chat switch
	const [expandedFolders, setExpandedFolders] = createSignal<Set<string>>(new Set());
	const toggleFolder = (folder: string) => setExpandedFolders(prev => {
		const next = new Set(prev);
		next.has(folder) ? next.delete(folder) : next.add(folder);
		return next;
	});

	const grouped = createMemo(() => {
		const currentFolder = props.currentChatFolder || NOFOLDER;
		const byId = new Map(props.chatList.map(c => [c.id, c]));
		// Resolve each chat to its top-level ancestor — nesting is capped at two
		// display levels, so anything deeper flattens under its root.
		const rootOf = (c: Chat): Chat => {
			let cur = c, guard = 0;
			while (cur.parent_id && byId.has(cur.parent_id) && guard++ < 50) cur = byId.get(cur.parent_id)!;
			return cur;
		};

		const nodes = new Map<string, ChatNode>();
		const nodeFor = (chat: Chat) => {
			let n = nodes.get(chat.id);
			if (!n) nodes.set(chat.id, n = { chat, children: [] });
			return n;
		};
		for (const chat of props.chatList) {
			const root = rootOf(chat);
			if (root.id === chat.id) nodeFor(chat);
			else nodeFor(root).children.push(chat);
		}

		// Group root nodes by the root's folder
		const byFolder = new Map<string, ChatNode[]>();
		for (const node of nodes.values()) {
			const folder = node.chat.chat_folder || NOFOLDER;

			if (!byFolder.has(folder)) byFolder.set(folder, []);
			byFolder.get(folder)!.push(node);
		}
		const nodeLatest = (n: ChatNode) => Math.max(n.chat.updated, ...n.children.map(c => c.updated));
		for (const list of byFolder.values()) {
			list.sort((a, b) => nodeLatest(b) - nodeLatest(a));
			for (const n of list) n.children.sort((a, b) => b.updated - a.updated);
		}

		const entries: [string, ChatNode[], boolean][] = [];

		// Pinned folder first (stable across chat switches)
		if (byFolder.has(pinnedFolder)) {
			entries.push([pinnedFolder, byFolder.get(pinnedFolder)!, currentFolder === pinnedFolder]);
			byFolder.delete(pinnedFolder);
		}

		// sort by latest chat (including fork timestamps)
		const sortedFolders = Array.from(byFolder.keys()).filter(f => f !== '')
			.sort((a, b) => nodeLatest(byFolder.get(b)![0]) - nodeLatest(byFolder.get(a)![0]));

		for (const folder of sortedFolders)
			entries.push([folder, byFolder.get(folder)!, currentFolder === folder]);

		return entries;
	});

	return (
		<div class="chat-switcher">
			<button class="chat-new-button" onClick={() => props.onCreateChat()}>
				<TbOutlinePlus size={16} /> New Chat
			</button>
			<div class="chat-search">
				<TbOutlineSearch size={14} />
				<input
					ref={searchInput}
					type="text"
					placeholder="Search chats & folders..."
					value={query()}
					onInput={e => { setQuery(e.currentTarget.value); setContentResults(null); }}
					onKeyDown={e => {
						if (e.key === 'Enter') { e.preventDefault(); void runContentSearch(); }
						if (e.key === 'Escape') { setQuery(''); setContentResults(null); }
					}}
				/>
				<Show when={query()}>
					<button class="slim-but" onClick={() => { setQuery(''); setContentResults(null); }} title="Clear">×</button>
				</Show>
			</div>
			<Show when={query().trim()}>
				<div class="chat-search-filters">
					<button
						classList={{ 'chat-search-filter': true, 'chat-search-filter-on': parsed().folderTerm !== null }}
						onClick={toggleFolderOnly}
						title="Restrict the search to folders (folder:name)"
					>
						<TbOutlineFolder size={12} /> Folder
					</button>
					{/* Echo what the term actually resolved to — makes a mis-parse visible */}
					<Show when={folderScope()}>
						{scope => (
							<span class="chat-search-scope" title={scope().join('\n')}>
								{!parsed().text
									? 'pick a folder, or add a query to search inside'
									: `in ${scope().length === 1
										? folderLabel(scope()[0] === NOFOLDER ? '' : scope()[0])
										: `${scope().length} folders`}`}
							</span>
						)}
					</Show>
				</div>
				{/* Kept out of the scrolling list so it stays reachable with many results */}
				<Show when={props.onSearchMessages && parsed().text}>
					<button class="chat-search-deep" disabled={searching()} onClick={() => void runContentSearch()}>
						{searching() ? 'Searching…' : contentResults() ? 'Search again ↵' : 'Search message contents ↵'}
					</button>
				</Show>
				<div class="chat-search-results">
					<Show when={folderSearch().length > 0}>
						<div class="chat-search-label">Folders</div>
						<For each={folderSearch()}>
							{f => (
								<div class="chat-search-hit-row">
									<button class="chat-search-hit" onClick={() => jumpToFolder(f.path)} title="Scroll to folder">
										<div class="chat-search-hit-head">
											<TbOutlineFolder size={12} />
											<span class="chat-search-hit-name">{f.name}</span>
											<span class="chat-search-hit-meta">{f.count} chat{f.count !== 1 ? 's' : ''}</span>
										</div>
										<Show when={shortenPath(f.parent)}>
											<span class="chat-search-hit-folder">{shortenPath(f.parent)}</span>
										</Show>
									</button>
									<button class="slim-but" title="Search inside this folder"
										onClick={() => scopeToFolder(f)}>
										<TbOutlineFolderSearch size={15} />
									</button>
									<button class="slim-but" title="Create a new chat in this folder"
										onClick={() => {
											props.onCreateChatInFolder(f.path === NOFOLDER ? '' : f.path);
											setQuery('');
										}}>
										<TbOutlinePlus size={15} />
									</button>
								</div>
							)}
						</For>
					</Show>
					<Show when={folderScope()?.length === 0}>
						<div class="chat-search-empty">No folders match “{parsed().folderTerm}”</div>
					</Show>
					<Show when={parsed().text}>
					<div class="chat-search-label">Chats</div>
					<For each={chatSearch()} fallback={<div class="chat-search-empty">No matching titles</div>}>
						{m => (
							<button class="chat-search-hit" onClick={() => props.onSwitchChat(m.chat.id)}>
								<div class="chat-search-hit-head">
									<span class="chat-search-hit-name">{m.chat.name}</span>
									<Show when={m.chat.id === props.currentChatId}>
										<span class="chat-search-hit-current">current</span>
									</Show>
									<span class="chat-search-hit-meta">{formatRelativeTime(m.chat.updated)}</span>
								</div>
								<div class="chat-search-hit-folder">
									<TbOutlineFolder size={11} /> {folderLabel(m.chat.chat_folder || '')}
									<Show when={m.byId}>
										<span class="chat-search-hit-meta">#{m.chat.id.slice(0, 8)}</span>
									</Show>
								</div>
							</button>
						)}
					</For>
					</Show>

					<Show when={contentResults()}>
						<div class="chat-search-label">Messages</div>
						<For each={contentResults()} fallback={<div class="chat-search-empty">No matching messages</div>}>
							{r => (
								<button class="chat-search-hit" onClick={() => props.onSwitchChat(r.chatId, true, r.idx)}>
									<div class="chat-search-hit-head">
										<span class="chat-search-hit-name">{r.chatName}</span>
										<Show when={r.chatId === props.currentChatId}>
											<span class="chat-search-hit-current">current</span>
										</Show>
										<span class="chat-search-hit-meta">{formatRelativeTime(r.updated)}</span>
									</div>
									<div class="chat-search-hit-folder">
										<TbOutlineFolder size={11} /> {folderLabel(r.chatFolder || '')}
										<span class="chat-search-hit-meta">
											{r.role} #{r.idx}{r.versionIndex !== undefined ? ` · v${r.versionIndex + 1}` : ''}
										</span>
									</div>
									<div class="chat-search-snippet" innerHTML={r.snippet} />
								</button>
							)}
						</For>
					</Show>
				</div>
			</Show>
			<div class="chat-list" style={query().trim() ? 'display: none' : undefined}>
				<ChatListContext.Provider value={{
				get currentChatId() { return props.currentChatId; },
				get runningChatIds() { return props.runningChatIds || new Set(); },
				onSwitch: props.onSwitchChat,
				onDelete: props.onDeleteChat,
				onRename: props.onRenameChat,
				onDuplicate: props.onDuplicateChat,
				onGenerateTitle: props.onGenerateTitle,
			}}>
				<For each={grouped()}>
					{([folder, nodes, isCurrent]) => (
						<ChatGroup
							folder={folder}
							nodes={nodes}
							isCurrent={isCurrent}
							onCreateInFolder={props.onCreateChatInFolder}
							expanded={() => expandedFolders().has(folder)}
							onToggleExpand={() => toggleFolder(folder)}
						/>
					)}
				</For>
			</ChatListContext.Provider>
			</div>
		</div>
	);
}

// ── Provider Manager ────────────────────────────────────────────────────

function ProviderManager(props: {
	providers: Record<Provider, ProviderConfig>,
	setProviders: Setter<Record<Provider, ProviderConfig>>,
	provider: Provider
}) {
	function update(provider: Provider, patch: Partial<ProviderConfig>) {
		props.setProviders(prev => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));
	}

	function removeProvider(key: string) {
		props.setProviders(prev => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
	}

	const isBuiltin = (key: string) => key in providerNames;

	const builtinKeys = () => Object.keys(props.providers).filter(k => isBuiltin(k));
	const customKeys = () => Object.keys(props.providers).filter(k => !isBuiltin(k));

	const [newName, setNewName] = createSignal('');
	const [newUrl, setNewUrl] = createSignal('');
	const [newKey, setNewKey] = createSignal('');

	function addProvider() {
		const name = newName().trim();
		const url = newUrl().trim();
		if (!name || !url) return;
		const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
		if (props.providers[key]) return; // already exists
		props.setProviders(prev => ({
			...prev,
			[key]: { url, apiKey: newKey().trim(), enabled: true, name }
		}));
		setNewName(''); setNewUrl(''); setNewKey('');
	}

	const [kagiKey, setKagiKey] = createSignal(localStorage.getItem('kagiKey') ?? '');
	const [parallelKey, setParallelKey] = createSignal(localStorage.getItem('parallelKey') ?? '');
	const [extractProvider, setExtractProvider] = createSignal(localStorage.getItem('extractProvider') ?? 'kagi');
	const [searchProvider, setSearchProvider] = createSignal(localStorage.getItem('searchProvider') ?? 'kagi');
	const [parallelSearchMode, setParallelSearchMode] = createSignal(localStorage.getItem('parallelSearchMode') ?? 'basic');

	return (
		<details class="sidebar-section api-key-manager" open={false}>
			<summary>
				<h4 class='loreHeader'>Providers</h4>
			</summary>

			<For each={builtinKeys()}>
				{key => { const cfg = () => props.providers[key]; return (
					<div class={`provider-entry ${props.provider === key ? 'active-provider' : ''} ${!cfg()?.enabled ? 'provider-disabled' : ''}`} style="margin: 0 0 10px 10px;">
						<label style="margin: 0; display: flex; align-items: center; gap: 6px;">
							<input
								type="checkbox"
								checked={cfg()?.enabled}
								onInput={e => update(key, { enabled: e.target.checked })}
							/>
							<span style="font-size: 0.9em; font-weight: bold;">{(providerNames as Record<string, string>)[key]}</span>
						</label>
						<Show when={cfg()?.enabled}>
							<input
								type='text'
								placeholder='API key'
								value={cfg()?.apiKey ?? ''}
								onInput={e => update(key, { apiKey: e.target.value })}
								style="margin-top: 4px;"
							/>
							<div style="display: flex; align-items: center; gap: 4px; margin-top: 2px;">
								<input
									type='text'
									placeholder='API URL'
									value={cfg()?.url ?? ''}
									onInput={e => update(key, { url: e.target.value })}
									style="flex: 1; font-size: 0.8em; opacity: 0.7;"
								/>
								<Show when={cfg()?.url !== (DEFAULT_PROVIDERS as Record<string, ProviderConfig>)[key]?.url}>
									<button class='slim-but' onClick={() => update(key, { url: (DEFAULT_PROVIDERS as Record<string, ProviderConfig>)[key].url })} title='Reset to default URL' style="padding: 2px 4px; font-size: 0.75em;">↺</button>
								</Show>
							</div>
						</Show>
					</div>
				)}}
			</For>

			<For each={customKeys()}>
				{key => { const cfg = () => props.providers[key]; return (
					<div class={`provider-entry ${props.provider === key ? 'active-provider' : ''} ${!cfg()?.enabled ? 'provider-disabled' : ''}`} style="margin: 0 0 10px 10px;">
						<div style="display: flex; align-items: center; gap: 6px;">
							<input
								type="checkbox"
								checked={cfg()?.enabled}
								onInput={e => update(key, { enabled: e.target.checked })}
							/>
							<span style="font-size: 0.9em; font-weight: bold;">{cfg()?.name || key}</span>
							<button class='slim-but' style="margin-left: auto;" onClick={() => removeProvider(key)} title='Remove provider'>
								<TbOutlineTrashX size={14} color='red' />
							</button>
						</div>
						<Show when={cfg()?.enabled}>
							<input
								type='text'
								placeholder='API key (optional)'
								value={cfg()?.apiKey ?? ''}
								onInput={e => update(key, { apiKey: e.target.value })}
								style="margin-top: 4px;"
							/>
							<input
								type='text'
								placeholder='API URL'
								value={cfg()?.url ?? ''}
								onInput={e => update(key, { url: e.target.value })}
								style="margin-top: 2px; font-size: 0.8em; opacity: 0.7;"
							/>
						</Show>
					</div>
				)}}
			</For>

			<div style="margin: 8px 0 0 10px; display: flex; flex-direction: column; gap: 4px;">
				<div style="display: flex; gap: 4px; align-items: center;">
					<input type='text' placeholder='Name' value={newName()} onInput={e => setNewName(e.target.value)} style="flex: 1; font-size: 0.85em;" onKeyDown={e => e.key === 'Enter' && addProvider()} />
					<button class='slim-but' onClick={addProvider} title='Add provider'><TbOutlinePlus size={14} /></button>
				</div>
				<input type='text' placeholder='URL' value={newUrl()} onInput={e => setNewUrl(e.target.value)} style="font-size: 0.8em; opacity: 0.7;" onKeyDown={e => e.key === 'Enter' && addProvider()} />
				<input type='text' placeholder='API key (optional)' value={newKey()} onInput={e => setNewKey(e.target.value)} style="font-size: 0.8em; opacity: 0.7;" onKeyDown={e => e.key === 'Enter' && addProvider()} />
			</div>

			<div style="margin: 12px 0 0 10px; border-top: 1px solid var(--border-color, #555); padding-top: 8px;">
				<span style="font-size: 0.9em; font-weight: bold; opacity: 0.7;">Utility APIs</span>
				<div style="margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
						<div style="display: flex; flex-direction: column; gap: 4px;">
						<label style="margin: 0; display: flex; align-items: center; gap: 6px; font-size: 0.85em;">
							Extract via
							<select
								value={extractProvider()}
								onInput={e => { setExtractProvider(e.target.value); localStorage.setItem('extractProvider', e.target.value); updateFetchUrlTool(); }}
								style="flex: 1;"
							>
								<option value='kagi'>Kagi</option>
								<option value='parallel'>Parallel</option>
							</select>
						</label>
						<label style="margin: 0; display: flex; align-items: center; gap: 6px; font-size: 0.85em;">
							Search via
							<select
								value={searchProvider()}
								onInput={e => { setSearchProvider(e.target.value); localStorage.setItem('searchProvider', e.target.value); updateWebSearchTool(); }}
								style="flex: 1;"
							>
								<option value='kagi'>Kagi</option>
								<option value='parallel'>Parallel</option>
							</select>
						</label>
						<Show when={searchProvider() === 'parallel'}>
							<label style="margin: 0; display: flex; align-items: center; gap: 6px; font-size: 0.85em;">
								Parallel mode
								<select
									value={parallelSearchMode()}
									onInput={e => { setParallelSearchMode(e.target.value); localStorage.setItem('parallelSearchMode', e.target.value); }}
									style="flex: 1;"
								>
									<option value='turbo'>Turbo</option>
									<option value='basic'>Basic</option>
									<option value='advanced'>Advanced</option>
								</select>
							</label>
						</Show>
					</div>
					<input
						type='text'
						placeholder='Kagi API key'
						value={kagiKey()}
						onInput={e => { setKagiKey(e.target.value); localStorage.setItem('kagiKey', e.target.value); updateFetchUrlTool(); updateWebSearchTool(); }}
					/>
					<input
						type='text'
						placeholder='Parallel API key'
						value={parallelKey()}
						onInput={e => { setParallelKey(e.target.value); localStorage.setItem('parallelKey', e.target.value); updateFetchUrlTool(); updateWebSearchTool(); }}
					/>
				</div>
			</div>
		</details>
	);
}

// ── Macro Manager ───────────────────────────────────────────────────────

function MacroManager(props: {
	macros: Record<string, string>,
	setMacros: Setter<Record<string, string>>
}) {
	const [newKey, setNewKey] = createSignal('');
	const [newVal, setNewVal] = createSignal('');

	// Use keys() instead of entries() - strings are compared by value,
	// so For's keyed reconciliation preserves DOM elements across updates
	const keys = () => Object.keys(props.macros).filter(key => key.trim() !== 'agents');

	function addMacro() {
		const k = newKey().trim();
		if (!k) return;
		props.setMacros(prev => ({ ...prev, [k]: newVal() }));
		setNewKey('');
		setNewVal('');
	}

	function tryAddOnBlur(e: FocusEvent) {
		const related = e.relatedTarget as HTMLElement | null;
		// Don't commit while focus is still moving inside the add row
		if (related && related.closest('.macro-add-row')) return;
		if (newKey().trim()) addMacro();
	}

	function removeMacro(key: string) {
		props.setMacros(prev => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
	}

	function updateMacro(key: string, field: 'key' | 'value', raw: string) {
		if (field === 'value') {
			props.setMacros(prev => ({ ...prev, [key]: raw }));
		} else {
			const trimmed = raw.trim();
			if (!trimmed || trimmed === key) return;
			props.setMacros(prev => {
				const next = { ...prev };
				const val = next[key];
				delete next[key];
				next[trimmed] = val;
				return next;
			});
		}
	}

	return (
		<details class='sidebar-section' style='margin: 15px 0 8px 0;'>
			<summary>
				<span style='font-family: var(--font-ui); font-weight: bold'>Macros</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					use @@key in prompts
				</span>
			</summary>
			<div class='promptManager'>
				<For each={keys()}>
					{key => (
						<div style='display: flex; gap: 6px; align-items: center;'>
							<input
								type='text'
								value={key}
								style='width: 100px; font-family: var(--font-mono, monospace); font-size: 0.85em;'
								onBlur={e => updateMacro(key, 'key', e.currentTarget.value)}
								onKeyDown={e => e.key === 'Enter' && updateMacro(key, 'key', e.currentTarget.value)}
							/>
							<span style='opacity: 0.5'>→</span>
							<input
								type='text'
								value={props.macros[key]}
								style='flex: 1;'
								onInput={e => updateMacro(key, 'value', e.currentTarget.value)}
							/>
							<button class='slim-but' onClick={() => removeMacro(key)} title='Remove macro'>
								<TbOutlineTrashX size={14} color='red' />
							</button>
						</div>
					)}
				</For>
				<div class='macro-add-row' style='display: flex; gap: 6px; align-items: center; margin-top: 4px;' onFocusOut={tryAddOnBlur}>
					<input
						type='text'
						placeholder='key'
						value={newKey()}
						style='width: 100px; font-family: var(--font-mono, monospace); font-size: 0.85em;'
						onInput={e => setNewKey(e.currentTarget.value)}
						onKeyDown={e => e.key === 'Enter' && addMacro()}
					/>
					<span style='opacity: 0.5'>→</span>
					<input
						type='text'
						placeholder='value'
						value={newVal()}
						style='flex: 1;'
						onInput={e => setNewVal(e.currentTarget.value)}
						onKeyDown={e => e.key === 'Enter' && addMacro()}
					/>
					<button class='slim-but' onClick={addMacro} title='Add macro'>
						<TbOutlinePlus size={14} />
					</button>
				</div>
				<div style='font-size: 0.8em; opacity: 0.5; margin-top: 2px;'>
					Use @@key in prompts or messages. Built-in: @@time, @@date, @@model, @@folder, @@id.<br/>
					ST macros ({"{{char}}"}, {"{{user}}"}, etc.) are auto-converted on import.
				</div>
			</div>
		</details>
	);
}

// ── Agent Manager (spawn_agent tier models + presets, Tauri only) ────────

const AGENT_TIERS = ['lite', 'medium', 'ultra'] as const;

function TitlerManager(props: {
	settings: TitlerSettings,
	setSettings: Setter<TitlerSettings>,
	providers: Record<Provider, ProviderConfig>,
}) {
	return (
		<details class='sidebar-section' style='margin-bottom: 10px;'>
			<summary>
				<span style='font-family: var(--font-ui); font-weight: bold'>Auto-titler</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					model that names chats
				</span>
			</summary>
			<div class='promptManager'>
				<ModelPicker
					compact
					autoPickOnProviderChange={false}
					provider={props.settings.provider}
					setProvider={p => props.setSettings(prev => ({ ...prev, provider: p }))}
					model={props.settings.model}
					setModel={m => props.setSettings(prev => ({ ...prev, model: m }))}
					providers={props.providers}
				/>
				<textarea
					class='prompt'
					rows={3}
					placeholder='System prompt for the titler'
					value={props.settings.prompt}
					onInput={e => props.setSettings(prev => ({ ...prev, prompt: e.currentTarget.value }))}
				/>
				<label style='display: flex; align-items: center; gap: 8px; margin-top: 4px;'>
					<span style='opacity: 0.8; font-size: 0.9em;'>Auto-title after</span>
					<input
						type='number'
						min={0}
						style='width: 64px;'
						value={props.settings.autoAfter}
						onInput={e => props.setSettings(prev => ({ ...prev, autoAfter: Math.max(0, parseInt(e.currentTarget.value) || 0) }))}
				/>
					<span style='opacity: 0.8; font-size: 0.9em;'>messages (0 = off)</span>
				</label>
			</div>
		</details>
	);
}

function AgentManager(props: {
	settings: AgentSettings,
	setSettings: Setter<AgentSettings>,
	providers: Record<Provider, ProviderConfig>,
}) {
	const provName = (id: string, c: ProviderConfig) => c.name || (providerNames as Record<string, string>)[id] || id;
	// Preset tool selection excludes tools agents can't have
	const presetTools = tools.filter(t => t.function.name !== 'spawn_agent' && t.function.name !== 'create_timer');

	const updPreset = (i: number, patch: Partial<AgentPreset>): void => {
		props.setSettings(prev => ({ ...prev, presets: prev.presets.map((p, j) => j === i ? { ...p, ...patch } : p) }));
	};

	const isTier = (m: string) => AGENT_TIERS.includes(m as typeof AGENT_TIERS[number]);
	// A freshly picked custom source has no model yet, which is indistinguishable from 'self' in the preset itself
	const [pickingCustom, setPickingCustom] = createSignal<Record<number, boolean>>({});
	const modelSource = (i: number, preset: AgentPreset) => {
		const m = preset.model.trim();
		if (isTier(m)) return m;
		if (m && m !== 'self') return 'custom';
		return pickingCustom()[i] ? 'custom' : 'self';
	};
	const delPreset = (i: number): void => {
		props.setSettings(prev => ({ ...prev, presets: prev.presets.filter((_, j) => j !== i) }));
		// Indices above the removed one shift down
		setPickingCustom(prev => Object.fromEntries(
			Object.entries(prev).filter(([k]) => Number(k) !== i).map(([k, v]) => [Number(k) > i ? Number(k) - 1 : Number(k), v])
		));
	};

	return (
		<details class='sidebar-section' style='margin-bottom: 10px;'>
			<summary>
				<span style='font-family: var(--font-ui); font-weight: bold'>Agents</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					spawn_agent models & presets
				</span>
			</summary>
			<div class='promptManager'>
				<For each={AGENT_TIERS}>
					{tier => (
						<div>
							<div style='display: flex; gap: 6px; align-items: center;'>
								<span style='width: 60px; opacity: 0.7; font-size: 0.9em;'>{tier}</span>
								<ModelPicker
									compact
									autoPickOnProviderChange={false}
									provider={props.settings.models[tier].provider}
									setProvider={p => props.setSettings(prev => ({ ...prev, models: { ...prev.models, [tier]: { ...prev.models[tier], provider: p } } }))}
									model={props.settings.models[tier].model}
									setModel={m => props.setSettings(prev => ({ ...prev, models: { ...prev.models, [tier]: { ...prev.models[tier], model: m } } }))}
									providers={props.providers}
								/>
							</div>
							<Show when={props.settings.models[tier].model.trim()}>
								<textarea
									class='prompt'
									rows={2}
									placeholder='System prompt for this tier (empty = inherit chat prompts)'
									value={props.settings.models[tier].prompt ?? ''}
									onInput={e => props.setSettings(prev => ({ ...prev, models: { ...prev.models, [tier]: { ...prev.models[tier], prompt: e.currentTarget.value } } }))}
								/>
							</Show>
						</div>
					)}
				</For>

				<strong style='opacity: 0.6; margin-top: 8px'>Presets</strong>
				<Index each={props.settings.presets}>
					{(preset, i) => (
						<details class='sidebar-section'>
							<summary>
								<span style='font-family: var(--font-ui);'>{preset().name || 'unnamed'}</span>
								<button
									class='slim-but'
									style='float: right;'
									title='Delete preset'
									onClick={e => {
										e.preventDefault();
										delPreset(i);
									}}
								>
									<TbOutlineTrashX size={14} color='red' />
								</button>
							</summary>
							<label>Name
								<input type='text' value={preset().name} onInput={e => updPreset(i, { name: e.currentTarget.value })} />
							</label>
							<label title='Shown to the model in the tool description'>Description
								<input type='text' placeholder='e.g. reviews code changes for bugs' value={preset().description} onInput={e => updPreset(i, { description: e.currentTarget.value })} />
							</label>
							<label title='Where this preset gets its model from'>Model source
								<select
									value={modelSource(i, preset())}
									onInput={e => {
										const v = e.currentTarget.value;
										setPickingCustom(prev => ({ ...prev, [i]: v === 'custom' }));
										if (v !== 'custom') updPreset(i, { model: v });
										else if (!preset().model.trim() || isTier(preset().model.trim()) || preset().model.trim() === 'self') updPreset(i, { model: '' });
									}}
								>
									<option value='self'>self (same as chat)</option>
									<option value='lite'>lite</option>
									<option value='medium'>medium</option>
									<option value='ultra'>ultra</option>
									<option value='custom'>custom…</option>
								</select>
							</label>
							<Show when={isTier(preset().model.trim())}>
								<div style='margin-left: 12px; opacity: 0.7; font-size: 0.85em;'>
									{(() => { const t = preset().model.trim() as typeof AGENT_TIERS[number]; const ref = props.settings.models[t]; return ref?.model.trim() ? `${ref.model} (${provName(ref.provider, props.providers[ref.provider])})` : `${t} tier (not configured)`; })()}
								</div>
							</Show>
							<Show when={modelSource(i, preset()) === 'custom'}>
								<div style='margin-left: 12px;'>
									<ModelPicker
										compact
										autoPickOnProviderChange={false}
										provider={preset().provider || 'or'}
										setProvider={p => updPreset(i, { provider: p })}
										model={preset().model}
										setModel={m => updPreset(i, { model: m })}
										providers={props.providers}
									/>
								</div>
							</Show>
							<textarea
								class='prompt'
								rows={4}
								placeholder='System prompt (empty = inherit chat prompts)'
								value={preset().prompt}
								onInput={e => updPreset(i, { prompt: e.currentTarget.value })}
							/>
							<label>
								<input
									type='checkbox'
									checked={preset().tools !== undefined}
									onInput={e => updPreset(i, { tools: e.currentTarget.checked ? {} : undefined })}
								/>
								<span>Custom tools (off = inherit chat tools)</span>
							</label>
							<Show when={preset().tools}>
								<For each={presetTools}>
									{tool => (
										<label style='margin-left: 12px;'>
											<input
												type='checkbox'
												checked={preset().tools?.[tool.function.name] === true}
												onInput={e => updPreset(i, { tools: { ...preset().tools, [tool.function.name]: e.currentTarget.checked } })}
											/>
											<span>{tool.function.name}</span>
										</label>
									)}
								</For>
							</Show>
							<label>Max turns
								<input
									type='number'
									min='1'
									max='250'
									style='width: 70px;'
									placeholder='10'
									value={preset().maxTurns ?? ''}
									onInput={e => updPreset(i, { maxTurns: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })}
								/>
							</label>
						</details>
					)}
				</Index>
				<button
					style='margin-top: 4px;'
					onClick={() => props.setSettings(prev => ({ ...prev, presets: [...prev.presets, { name: 'new-preset', description: '', model: '', prompt: '' }] }))}
				>
					<TbOutlinePlus size={14} /> Add preset
				</button>
				<div style='font-size: 0.8em; opacity: 0.5; margin-top: 2px;'>
					Tier models are callable via spawn_agent's model param. Presets bundle a prompt, model and tools under a name the model can call.
				</div>
			</div>
		</details>
	);
}

// ── Database Backups (Tauri only) ───────────────────────────────────────

const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

function fmtSize(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function fmtInterval(ms: number): string {
	const units: [number, string][] = [[7 * 86400e3, 'w'], [86400e3, 'd'], [3600e3, 'h'], [60e3, 'm'], [1000, 's']];
	const [size, label] = units.find(([s]) => ms >= s) ?? [1, 'ms'];
	return `${ms / size}${label}`;
}

function BackupManager(props: { setError?: Setter<string | null> | undefined, setInfo?: Setter<string | null> | undefined }) {
	const [settings, setSettings] = createSignal<BackupSettings>(loadBackupSettings());
	const [files, setFiles] = createSignal<BackupFile[]>([]);
	const [others, setOthers] = createSignal(0);
	const [pending, setPending] = createSignal<{ file: BackupFile, kind: 'db' | 'settings' } | null>(null);
	const [backupFirst, setBackupFirst] = createSignal(true);
	const [busy, setBusy] = createSignal('');

	const update = (patch: Partial<BackupSettings>) => {
		const next = { ...settings(), ...patch };
		setSettings(next);
		saveBackupSettings(next);
	};

	const refresh = async () => {
		setOthers(await otherInstances());
		try { setFiles(await listBackups()); }
		catch (e) { props.setError?.('Failed to list backups: ' + errMsg(e)); }
	};

	const total = createMemo(() => files().reduce((n, f) => n + f.size, 0));
	const policy = createMemo(() => PROFILES[settings().profile].rules
		.map(r => `${fmtInterval(r.every)}×${r.keep}`).join(', '));
	const isPending = (file: BackupFile, kind: 'db' | 'settings') =>
		pending()?.kind === kind && pending()?.file.path === file.path;
	const togglePending = (file: BackupFile, kind: 'db' | 'settings') =>
		setPending(p => p?.kind === kind && p.file.path === file.path ? null : { file, kind });

	async function backupNow() {
		setBusy('Backing up…');
		try {
			const file = await createBackup({ profile: settings().profile });
			props.setInfo?.(`Backed up to ${file.name} (${fmtSize(file.size)})`);
			await refresh();
		} catch (e) {
			props.setError?.('Backup failed: ' + errMsg(e));
		} finally { setBusy(''); }
	}

	async function confirmPending() {
		const target = pending();
		if (!target) return;
		const isDb = target.kind === 'db';
		setBusy(isDb ? 'Restoring…' : 'Applying settings…');
		try {
			if (isDb) await restoreBackup(target.file, { backupFirst: backupFirst() });
			else await applySettings(target.file);
			location.reload();
		} catch (e) {
			props.setError?.((isDb ? 'Restore failed (database left untouched): ' : 'Could not apply settings: ') + errMsg(e));
			setBusy('');
			setPending(null);
			void refresh();
		}
	}

	return (
		<details class='sidebar-section' style='margin-bottom: 10px;' onToggle={e => e.currentTarget.open && refresh()}>
			<summary>
				<span style='font-family: var(--font-ui); font-weight: bold'>Backups</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					snapshots of the chat database
				</span>
			</summary>
			<div class='promptManager'>
				<label>
					<input
						type='checkbox'
						checked={settings().enabled}
						onInput={e => update({ enabled: e.currentTarget.checked })}
					/>
					<span>Automatic backups</span>
				</label>

				<label title='How many snapshots survive at each age: interval×count'>
					<span>Keep</span>
					<select
						value={settings().profile}
						onChange={e => update({ profile: e.currentTarget.value as ProfileName })}
					>
						<For each={Object.entries(PROFILES)}>
							{([key, p]) => <option value={key}>{p.label}</option>}
						</For>
					</select>
				</label>
				<div style='font-size: 0.8em; opacity: 0.5;'>{policy()}</div>

				<div class='backup-actions'>
					<button class='slim-but' disabled={!!busy()} onClick={backupNow}>Back up now</button>
					<button class='slim-but' onClick={() => openBackupsFolder()}>Open folder</button>
					<span style='font-size: 0.8em; opacity: 0.6;'>
						{busy() || (files().length ? `${files().length} · ${fmtSize(total())}` : 'none yet')}
					</span>
				</div>

				<Show when={others() > 0}>
					<div class='backup-confirm'>
						{others()} other app window{others() > 1 ? 's have' : ' has'} this database open, so it
						can't be replaced — each window is a separate process still writing to the file.
						Settings can still be applied.
					</div>
				</Show>

				<For each={files()}>
					{file => (
						<div class='backup-row'>
							<div class='backup-row-head'>
								<span>{new Date(file.time).toLocaleString()}</span>
								<span style='opacity: 0.5;'>{fmtSize(file.size)}</span>
								<span style='flex: 1;' />
								<Show when={file.settings}>
									<button
										class='slim-but'
										disabled={!!busy()}
										title='Prompts, configs, lore, macros and providers as they were then'
										onClick={() => togglePending(file, 'settings')}
									>Settings</button>
								</Show>
								<button
									class='slim-but'
									disabled={!!busy() || others() > 0}
									onClick={() => togglePending(file, 'db')}
								>Restore</button>
							</div>
							<Show when={isPending(file, 'db')}>
								<div class='backup-confirm'>
									<strong>Every chat and message in the current database will be replaced</strong> by
									this snapshot. Settings are left alone — apply them separately if you want them
									to match. This window reloads afterwards.
									<label>
										<input
											type='checkbox'
											checked={backupFirst()}
											onInput={e => setBackupFirst(e.currentTarget.checked)}
										/>
										<span>Snapshot the current database first</span>
									</label>
									<div class='backup-actions'>
										<button class='slim-but red' disabled={!!busy()} onClick={confirmPending}>
											Replace database
										</button>
										<button class='slim-but' onClick={() => setPending(null)}>Cancel</button>
									</div>
								</div>
							</Show>
							<Show when={isPending(file, 'settings')}>
								<div class='backup-confirm'>
									<strong>Your prompts, configs, lore, macros and provider keys will be replaced</strong> by
									this snapshot's. Anything added since is lost; chats and messages are untouched.
									This window reloads afterwards.
									<div class='backup-actions'>
										<button class='slim-but red' disabled={!!busy()} onClick={confirmPending}>
											Replace settings
										</button>
										<button class='slim-but' onClick={() => setPending(null)}>Cancel</button>
									</div>
								</div>
							</Show>
						</div>
					)}
				</For>
				<Show when={settings().enabled && lastBackupTime() > 0 && !files().length}>
					<div style='font-size: 0.8em; opacity: 0.5;'>Last attempt {new Date(lastBackupTime()).toLocaleString()}</div>
				</Show>
			</div>
		</details>
	);
}

// ── Image Folder Selector ───────────────────────────────────────────────

function ImageFolderSelector(props: {
	imageFolderHandle: FileSystemDirectoryHandle | null,
	setImageFolderHandle: Setter<FileSystemDirectoryHandle | null>,
	scanImageFolder: (dirHandle: FileSystemDirectoryHandle) => Promise<void>
}) {
	async function handleFolderSelect() {
		if (!(window as any).showDirectoryPicker) {
			alert('File System Access API not supported in this browser. Please use Chrome or Edge.');
			return;
		}

		try {
			const dirHandle = await (window as any).showDirectoryPicker();
			props.setImageFolderHandle(dirHandle);
			await props.scanImageFolder(dirHandle);
		} catch (error) {
			if ((error as any).name !== 'AbortError') {
				console.error('Error selecting folder:', error);
				alert('Failed to select folder: ' + (error as Error).message);
			}
		}
	}

	return (
		<label title="Select a folder containing images for display in chat" style="margin-top: 8px;">
			<span>Image Folder</span>
				<button class='messageMenuButton' onClick={handleFolderSelect} style="margin-right: 8px;">
					{props.imageFolderHandle ? 'Change Folder' : 'Open Folder'}
				</button>
				<Show when={props.imageFolderHandle}>
					<span style="font-size: 0.9em; opacity: 0.8;">
						{props.imageFolderHandle?.name}
					</span>
				</Show>
		</label>
	);
}
