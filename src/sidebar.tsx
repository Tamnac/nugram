import { For, Show, Setter, createSignal, createMemo, onCleanup, createEffect, onMount, Index, createContext, useContext, on, createDeferred } from 'solid-js';
import Fuse from 'fuse.js';
import { SetStoreFunction, produce } from 'solid-js/store'
import type { FileAttachment, Options, ExtraBodyRule, cacheType, cacheLength, Provider, Prompt, Config, ProviderConfig, ToolApprove, AgentSettings, TitlerSettings, SshBackendConfig } from './helpers/types'
import { JsonField } from './helpers/JsonEditor';
import { providerNames, themeNames, DEFAULT_PROVIDERS, isGpt56OrLater, toolModeOf, extraBodyRuleMatches, type BuiltinProvider, type ApiType, type ToolMode } from './helpers/types';
import { providerLabel } from './helpers/modelCatalog';
import { tools, updateFetchUrlTool, updateWebSearchTool } from './helpers/tools';
import { ModelPicker } from './helpers/ModelPicker';
import { PromptManager, ConfigSelector, SamplingParameters, modelMatchesTrigger } from './helpers/PromptManager';
import { READ_FILES_SPEC, type CompactSettings } from './helpers/compact';
import { TSeg, ReasoningControls, Modal } from './helpers/Comps'
import { LoreEntry } from './helpers/lore'

import { LoreManager } from './helpers/LoreManager';
import { AgentManager } from './helpers/AgentManager';
import { TbOutlineTrashX, TbOutlinePlus, TbOutlineSettings2, TbOutlineMessages, TbOutlineAdjustmentsAlt, TbOutlinePencil, TbOutlineFolder, TbOutlineCopy, TbOutlineSearch, TbOutlineFolderSearch, TbOutlineChevronRight, TbOutlineChevronDown, TbOutlineChevronUp, TbOutlineDotsVertical, TbOutlineSparkles, TbOutlineTag, TbOutlineInfoCircle, TbOutlineArrowUpRight, TbOutlineAlertTriangle } from 'solid-icons/tb';
import { Portal } from 'solid-js/web';
import { isTauri, selectFolder } from './helpers/platform';
import { PROFILES, listBackups, createBackup, restoreBackup, applySettings, otherInstances, backupsDir, validateBackupDirectory, openBackupsFolder, loadBackupSettings, saveBackupSettings, lastBackupTime, type BackupFile, type BackupSettings, type ProfileName } from './helpers/backup';
import { confirmDialog } from './helpers/platform';
import type { Chat, MessageSearchResult } from './helpers/db';
import { parseFacets } from './helpers/search';
import { storeImageOriginal, attachFile } from './helpers/attachments';
import { widgetRegistry, type Widget } from './helpers/widgets';
import { DERIVED_MACROS } from './helpers/Extras';
import type { SkillDirs, SkillEntry } from './helpers/skills';
import { listSshConfigHosts, type DiscoveredHost } from './helpers/backend/sshConfig';
import { backendFor, type Backend, type DirEntry } from './helpers/backend';
import { imageFolderLabel, pickImageFolder, clearImageFolder } from './helpers/imageFolder';
import { effectiveTools, toolEnabled, type ChatState } from './helpers/chatState';

type SidebarTab = 'settings' | 'chats' | 'current';

export function Sidebar(props: {
	prompts: Prompt[],
	setPrompts: SetStoreFunction<Prompt[]>,
	configs: Config[],
	setConfigs: SetStoreFunction<Config[]>,
	/** The open chat; the Current Chat tab edits it. */
	chat: ChatState,
	setChat: SetStoreFunction<ChatState>,
	cache: cacheType,
	setCache: Setter<cacheType>,
	cacheLength: cacheLength,
	setCacheLength: Setter<cacheLength>,
	options: Options,
	setOptions: SetStoreFunction<Options>,
	lore: LoreEntry[],
	setLore: SetStoreFunction<LoreEntry[]>,
	providers: Record<Provider, ProviderConfig>,
	setProviders: Setter<Record<Provider, ProviderConfig>>,
	setError?: Setter<string | null> | undefined,
	setInfo?: Setter<string | null> | undefined,
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
	onSwitchChat?: (id: string, addHistory?: boolean, scrollToDbId?: number) => void,
	onSearchMessages?: ((query: string, folders?: string[], tags?: string[], excludeTags?: string[]) => Promise<MessageSearchResult[]>) | undefined,
	onCreateChat?: () => void,
	onCreateChatInFolder: ((folder: string) => void),
	onDeleteChat?: (id: string) => void,
	onRenameChat?: (id: string, name: string) => void,
	onDuplicateChat?: (id: string) => void,
	onSetTags?: ((id: string, tags: string[]) => void) | undefined,
	onTagFolder?: ((folder: string, tag: string) => void) | undefined,
	onRenameTag?: ((from: string, to: string) => void) | undefined,
	onDeleteTag?: ((tag: string) => void) | undefined,
	skillDirs: SkillDirs,
	setSkillDirs: Setter<SkillDirs>,
	/** What the open chat's skill scans found. */
	skills: { project: SkillEntry[]; global: SkillEntry[] },
	/** SSH tool hosts (Tauri only); `chat.backend` picks one. */
	sshBackends?: SshBackendConfig[],
	setSshBackends?: SetStoreFunction<SshBackendConfig[]>,
	/** Moves the chat to a folder, inheriting settings from the folder's last chat. */
	setChatFolder?: (folder: string) => void,
	agentSettings?: AgentSettings,
	setAgentSettings?: Setter<AgentSettings>,
	titlerSettings?: TitlerSettings,
	setTitlerSettings?: Setter<TitlerSettings>,
	compactSettings: CompactSettings,
	setCompactSettings: Setter<CompactSettings>,
	onGenerateTitle?: ((id: string) => Promise<boolean>) | undefined,
}) {

	const [activeTab, setActiveTab] = createSignal<SidebarTab>(
		(localStorage.getItem('sidebarTab') as SidebarTab) || 'current'
	);

	const activeConfigIndex = createMemo(() => {
		const i = props.configs.findIndex(c => c.name === props.chat.configName);
		return i >= 0 ? i : 0;
	});
	const activeConfig = createMemo(() => props.configs[activeConfigIndex()]);
	const gptCache = createMemo(() => isGpt56OrLater(props.chat.model));
	const claudeCache = createMemo(() => props.chat.provider === 'or' || props.chat.provider === 'anth_local' || props.chat.provider === 'nano');
	
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
	let sidebarBody: HTMLDivElement | undefined;
	let tabTransition: ViewTransition | undefined;
	let tabSwitchId = 0;
	function switchTab(tab: SidebarTab): Promise<void> {
		const id = ++tabSwitchId;
		tabTransition?.skipTransition();
		
		const update = () => {
			if (id !== tabSwitchId || tab === activeTab()) return;
			localStorage.setItem('sidebarTab', tab);
			setActiveTab(tab);
			if (sidebarBody) sidebarBody.scrollTop = 0;
		};

		if (!props.sidebarOpen || tab === activeTab() || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
			delete document.documentElement.dataset.sidebarTransition;
			update();
			return Promise.resolve();
		}

		const tabs: SidebarTab[] = ['settings', 'chats', 'current'];
		document.documentElement.dataset.sidebarTransition = tabs.indexOf(tab) > tabs.indexOf(activeTab()) ? 'forward' : 'backward';
		tabTransition = document.startViewTransition(update);
		void tabTransition.finished.then(() => {
			if (id !== tabSwitchId) return;
			delete document.documentElement.dataset.sidebarTransition;
			tabTransition = undefined;
		});
		return tabTransition.updateCallbackDone;
	}

	onMount(() => {
		if (!isTauri) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'o') return;
			e.preventDefault();
			const switched = switchTab('chats');
			props.setSidebarOpen(true);
			void switched.then(() => {
				if (!props.sidebarOpen || activeTab() !== 'chats') return;
				const input = sidebarBody?.querySelector<HTMLInputElement>('.chat-search input');
				input?.focus();
				input?.select();
			});
		};
		document.addEventListener('keydown', handleKeyDown);
		onCleanup(() => document.removeEventListener('keydown', handleKeyDown));
	});
	onCleanup(() => {
		tabSwitchId++;
		tabTransition?.skipTransition();
		delete document.documentElement.dataset.sidebarTransition;
	});

	let bgFileInput!: HTMLInputElement;

	async function pickBackground(input: HTMLInputElement) {
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			const id = await storeImageOriginal(file);
			props.setChat('background', prev => ({ image: id, name: file.name, dim: prev?.dim ?? 0.3, blur: prev?.blur ?? 0 }));
		} catch (err) {
			props.setError?.('Failed to store background image: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

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
						title="Chats (Ctrl+O)"
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

			<div class="sidebar-body" ref={sidebarBody}>
			{/* # Settings tab ───────────────────────────────────── */}
			<Show when={activeTab() === 'settings'}>
				<h3 class='settings-header'>Display</h3>

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

				<div style='height: 1em'></div> {/*spacer*/}

				<ProviderManager providers={props.providers} setProviders={props.setProviders} provider={props.chat.provider} />

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
								const ruleMatches = createMemo(() => {
									if (!rule.providerPattern.trim() && !rule.modelPattern.trim()) return undefined;
									if (errors().providerError || errors().modelError) return 'invalid' as const;
									return extraBodyRuleMatches(rule, props.chat.provider, providerLabel(props.chat.provider, props.providers), props.chat.model);
								});
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
											<Show when={ruleMatches() !== undefined}>
												{(() => {
													const m = ruleMatches();
													const target = () => `${props.chat.provider} / ${props.chat.model}`;
													if (m === 'invalid') return <span class='sampler-match-badge invalid' title='Invalid pattern'>✕</span>;
													if (m) return <span class='sampler-match-badge match' title={`Matches current: ${target()}`}>✓</span>;
													return <span class='sampler-match-badge' title={`Doesn't match current: ${target()}`}>–</span>;
												})()}
											</Show>
											<button class='slim-but red' onClick={removeRule} title='Remove rule'>×</button>
										</div>
										<JsonField
											textClass={`prompt extra-body-input ${Object.keys(errors()).length > 0 ? 'invalid' : ''}`}
											placeholder={'JSON merged into the request body when patterns match, e.g.\n{ "provider": { "order": ["openai"] } }'}
											text={rule.body}
											onChange={body => updateRule('body', body)}
											rows={4}
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

				<details class='sidebar-section'>
				<summary><span class='sidebar-section-title'>Auto-Compact</span></summary>
				<div class='promptManager'>
					<label style='display: flex; align-items: center; gap: 8px;' title="Estimated context (in thousands of tokens) at which loop-mode compaction triggers, for chats that have it enabled">
						<span style='opacity: 0.8; font-size: 0.9em;'>Threshold</span>
						<input type='number' min={0} style='width: 70px;' value={Math.round(props.compactSettings.tokens / 1000)}
							onInput={e => props.setCompactSettings(prev => ({ ...prev, tokens: Math.max(0, parseInt(e.currentTarget.value) || 0) * 1000 }))} />
						<span style='opacity: 0.8; font-size: 0.9em;'>K tokens</span>
					</label>
					<label><span style='opacity: 0.8; font-size: 0.9em;'>Compaction prompt</span></label>
					<textarea class='prompt' rows={8} title="The user message sent to elicit the compaction summary"
						value={props.compactSettings.prompt}
						onInput={e => props.setCompactSettings(prev => ({ ...prev, prompt: e.currentTarget.value }))} />
					<details>
						<summary style='opacity: 0.6; font-size: 0.85em; cursor: pointer;'>Appended automatically: file re-read format</summary>
						<pre style='opacity: 0.6; font-size: 0.85em; white-space: pre-wrap; margin: 4px 0; border: none'>{READ_FILES_SPEC}</pre>
					</details>
				</div>
			</details>

			<Show when={isTauri && props.titlerSettings && props.setTitlerSettings}>
					<TitlerManager settings={props.titlerSettings!} setSettings={props.setTitlerSettings!} providers={props.providers} />
				</Show>

				<Show when={isTauri && props.sshBackends && props.setSshBackends}>
					<RemoteBackendManager backends={props.sshBackends!} setBackends={props.setSshBackends!} />
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
					currentChatFolder={props.chat.chatFolder}
					onSwitchChat={props.onSwitchChat || (() => {})}
					onSearchMessages={props.onSearchMessages}
					onCreateChat={props.onCreateChat || (() => {})}
					onCreateChatInFolder={props.onCreateChatInFolder}
					onDeleteChat={props.onDeleteChat || (() => {})}
					onRenameChat={props.onRenameChat || (() => {})}
					onDuplicateChat={props.onDuplicateChat || (() => {})}
					onGenerateTitle={props.onGenerateTitle}
					onSetTags={props.onSetTags}
					onTagFolder={props.onTagFolder}
					onRenameTag={props.onRenameTag}
					onDeleteTag={props.onDeleteTag}
				/>
			</Show>

			{/*#  Current Chat tab */}
			<Show when={activeTab() === 'current'}>
				<ConfigSelector
					configs={props.configs}
					setConfigs={props.setConfigs}
					activeConfigName={props.chat.configName}
					setActiveConfigName={name => props.setChat('configName', name)}
					setError={props.setError}
					setInfo={props.setInfo}
					model={props.chat.model}
				/>

				<details class='sidebar-section'>
					<summary>
						<span class='sidebar-section-title'>Prompts</span>
						<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
							{props.prompts.filter(p => p.enabled && modelMatchesTrigger(p.modelTrigger, props.chat.model).matches).length} active / {props.prompts.filter(p => p.enabled).length} enabled
						</span>
					</summary>
					<PromptManager prompts={props.prompts} setPrompts={props.setPrompts} model={props.chat.model} />
				</details>

				<SamplingParameters
					options={props.options}
					setOptions={props.setOptions}
					provider={props.chat.provider}
					configs={props.configs}
					setConfigs={props.setConfigs}
					activeConfigName={props.chat.configName}
					model={props.chat.model}
				/>

				<details class='sidebar-section tools-section'>
					<summary><span class='sidebar-section-title'>Tools</span></summary>
					<div class='tools-grid'>
						<For each={tools}>
						{tool => {
							const name = tool.function.name;
							const overridden = () => name in props.chat.toolOverrides;
							return (
								<label classList={{ 'tool-overridden': overridden() }} title={overridden() ? 'Set for this chat, differs from the config' : undefined}>
									<input type="checkbox"
										checked={overridden() ? props.chat.toolOverrides[name] : toolEnabled(activeConfig()?.tools, name)}
										onInput={e => {
											const on = e.target.checked;
											props.setChat('toolOverrides', produce(overrides => {
												if (on === toolEnabled(activeConfig()?.tools, name)) delete overrides[name];
												else overrides[name] = on;
											}));
										}}
									/>
									<span>{name}</span>
								</label>
							);
						}}
						</For>
					</div>
					<Show when={Object.keys(props.chat.toolOverrides).length}>
						<div class='tools-override-actions'>
							<button class='messageMenuButton' title='Use the config selection in this chat' onClick={() => props.setChat({ toolOverrides: {} })}>Reset to config</button>
							<button class='messageMenuButton' title="Make this chat's selection the config default" onClick={() => {
								const selection = effectiveTools(activeConfig()?.tools, props.chat.toolOverrides, tools.map(t => t.function.name));
								if (selection) props.setConfigs(activeConfigIndex(), { tools: selection });
								props.setChat({ toolOverrides: {} });
							}}>Save to config</button>
						</div>
					</Show>
					<label title={'Native: each tool on its own\nBatched: one `run` tool whose calls are grouped into ordered steps\nrun_js only: tools are functions inside run_js'}>
						<span>Tool calls</span>
						<select
							value={toolModeOf(activeConfig())}
							onInput={e => props.setConfigs(activeConfigIndex(), 'toolMode', e.target.value as ToolMode)}>
							<option value='native'>Native</option>
							<option value='run'>Batched</option>
							<option value='js'>run_js only</option>
						</select>
					</label>
				</details>

				<Show when={isTauri && props.agentSettings && props.setAgentSettings}>
					<AgentManager
						settings={props.agentSettings!}
						setSettings={props.setAgentSettings!}
						configName={activeConfig()?.name ?? ''}
						presets={activeConfig()?.agentPresets ?? []}
						setPresets={presets => props.setConfigs(activeConfigIndex(), 'agentPresets', presets)}
						providers={props.providers}
					/>
				</Show>

				<h3 class='sidebar-section-title'>Appearance</h3>
				<div class='sidebar-group'>
					<label title='Select theme'>
						<span>Theme</span>
						<select
							value={props.chat.theme}
							onInput={e => props.setChat('theme', e.target.value)}>
							<For each={Object.entries(themeNames)}>
								{([value, label]) => <option value={value}>{label}</option>}
							</For>
						</select>
					</label>

					<div title='Per-chat image shown behind the conversation'>
						<label>
							<span>Background</span>
							<button class='messageMenuButton' onClick={() => bgFileInput.click()}>Select image</button>
							<Show when={props.chat.background}>
								<button class='messageMenuButton' onClick={() => props.setChat('background', undefined)}>Clear</button>
							</Show>
						</label>
						<input ref={bgFileInput} type="file" accept="image/*" style="display: none" onChange={e => void pickBackground(e.target)} />

						<Show when={props.chat.background?.name}>{name => (
							<div class='sidebar-note path' title={name()}>{name()}</div>
						)}</Show>

						<Show when={props.chat.background}>{bg => (<>
							<label title='Fade the image into the theme background color'>
								<span>Mix ({Math.round(bg().dim * 100)}%)</span>
								<input type="range" min="0" max="1" step="0.05" value={bg().dim}
									onInput={e => props.setChat('background', 'dim', e.target.valueAsNumber)} />
							</label>
							<label title='Blur the image'>
								<span>Blur ({bg().blur}px)</span>
								<input type="range" min="0" max="40" step="1" value={bg().blur}
									onInput={e => props.setChat('background', 'blur', e.target.valueAsNumber)} />
							</label>
						</>)}</Show>
					</div>
				</div>

				<h3 class='sidebar-section-title'>Workspace</h3>
				<div class='sidebar-group'>
					<ImageFolderSelector setError={props.setError} />

					<Show when={isTauri && props.setChatFolder}>
						<FolderPicker
							chatList={props.chatList || []}
							chatFolder={props.chat.chatFolder}
							setChatFolder={props.setChatFolder!}
							backendId={props.chat.backend}
						/>
					</Show>

					<Show when={isTauri && props.sshBackends?.length}>
						<label title="Where this chat's shell and file tools run">
							<span>Tool backend</span>
							<select value={props.chat.backend} onInput={e => {
								const backend = e.currentTarget.value;
								if (backend !== props.chat.backend) props.setChat({ backend, chatFolder: '' });
							}}>
								<option value='local'>This machine</option>
								<For each={props.sshBackends}>{b => <option value={b.id}>{b.label || b.host}</option>}</For>
							</select>
						</label>
					</Show>

					<Show when={props.currentChatId}>
						<div class='chat-id-row wide'>
							<span>ID</span>
							<button class='chat-id-value' onClick={() => navigator.clipboard.writeText(props.currentChatId!)} title='Copy chat ID'>
								{props.currentChatId}
								<TbOutlineCopy size={12} />
							</button>
						</div>
					</Show>
				</div>

				<h3 class='sidebar-section-title'>Chat Options</h3>
				<div class='sidebar-group'>
					<label title="Send a random seed with each request to avoid repeated outputs">
						<span>Random seed</span>
						<input
							type="checkbox"
							checked={props.options.random_seed}
							onInput={e => props.setOptions('random_seed', e.target.checked)}
						/>
					</label>

					<Show when={gptCache() || (claudeCache() && /claude|sonnet|opus|fable|mythos|haiku/i.test(props.chat.model))}>
						<div class='setting-row'><span>{gptCache() ? 'GPT Cache' : 'Claude Cache'}</span>
							<TSeg
								options={gptCache() ? { smart: '30m', none: 'None' } : { smart: 'Anth', none: 'None' }}
								selected={props.cache}
								setSelected={props.setCache}
								tooltips={gptCache() ? { smart: 'Implicit and explicit prompt caching (30 minute minimum lifetime)' } : { smart: 'Add cache_control blocks for Anthropic' }}
							/>
							<Show when={!gptCache() && props.cache !== 'none'}>
								<TSeg options={{ '5m': '5m', '1h': '1h' }} selected={props.cacheLength} setSelected={props.setCacheLength} tooltips={{ '5m': 'Cache for 5 minutes (1.25x cost)', '1h': 'Cache for 1 hour (2x cost)' }} />
							</Show>
						</div>
					</Show>

					<label title="Loop mode only: when context exceeds threshold, model summarizes and continues. Per chat.">
						<span>Auto-compact</span>
						<input type="checkbox" checked={props.chat.autoCompact} onInput={e => props.setChat('autoCompact', e.target.checked)} />
					</label>
					<div class='sidebar-note'>Threshold & prompt are global — see the Settings tab.</div>
				</div>

				<h3 class='sidebar-section-title'>Reasoning</h3>
				<div class='sidebar-group'>
					<ReasoningControls
						reasoning={activeConfig()?.reasoning}
						preserveReasoning={activeConfig()?.preserveReasoning}
						reasoningPrefill={activeConfig()?.reasoningPrefill}
						setReasoning={v => props.setConfigs(activeConfigIndex(), 'reasoning', v)}
						setPreserveReasoning={v => props.setConfigs(activeConfigIndex(), 'preserveReasoning', v)}
						setPrefill={patch => props.setConfigs(activeConfigIndex(), 'reasoningPrefill', prev => ({ ...(prev ?? { enabled: false, content: '' }), ...patch }))}
					/>
				</div>

				<Show when={isTauri}>
					<h3 class='sidebar-section-title'>Permissions</h3>
					<div class='sidebar-group'>
						<div class='setting-row'><span>Approve edits</span>
							<TSeg options={{ off: 'Off', chat: 'Chat', always: 'Always' }} selected={props.chat.toolApprove} setSelected={mode => props.setChat('toolApprove', mode as ToolApprove)}
								tooltips={{off: 'Require permission every edit', chat: 'Allow all edits in this chat', always: 'Allow all edits in all chats'}}/>
						</div>
						<div class='setting-row'><span>Outside folder</span>
							<TSeg options={{ off: 'Off', chat: 'Chat', always: 'Always' }} selected={props.chat.toolApproveOutside} setSelected={mode => props.setChat('toolApproveOutside', mode as ToolApprove)}
								tooltips={{off: 'Require permission every outside edit', chat: 'Allow all outside edits in this chat', always: 'Allow all outside edits in all chats'}}/>
						</div>
					</div>
				</Show>

				<MacroManager chat={props.chat} setChat={props.setChat} skillDirs={props.skillDirs} setSkillDirs={props.setSkillDirs} />
				<Show when={isTauri}>
					<AttachableLists chat={props.chat} setChat={props.setChat} skills={props.skills} setError={props.setError} />
				</Show>
				<Show when={!isTauri}>
					<details class='sidebar-section'>
						<summary><span class='sidebar-section-title'>Lore</span></summary>
						<LoreManager lore={props.lore} setLore={props.setLore} loreId={props.chat.loreId} setError={props.setError} />
					</details>
				</Show>
			</Show>
			</div>
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
	/** Tool backend whose folders are listed/browsed; 'local' or an ssh backend id. */
	backendId?: string | undefined;
}) {
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal('');
	const [remoteBrowse, setRemoteBrowse] = createSignal(false);
	const backend = createMemo(() => backendFor(props.backendId));
	const [highlighted, setHighlighted] = createSignal(0);
	const [fuse, setFuse] = createSignal<Fuse<FolderOption> | null>(null);

	const knownFolders = createMemo(() => {
		const byFolder = new Map<string, number>();
		for (const chat of props.chatList) {
			const f = chat.chat_folder;
			if (!f) continue;
			// Only folders from chats on this backend — a Windows path is meaningless on a remote.
			if ((chat.backend || 'local') !== backend().id) continue;
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
		if (backend().id !== 'local') {
			setRemoteBrowse(true);
			return;
		}
		const folder = await selectFolder();
		if (!folder) return;
		props.setChatFolder(folder);
		setOpen(false);
		setQuery('');
	}

	function select(folder: string) {
		props.setChatFolder(folder);
		setRemoteBrowse(false);
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
				<span>Folder</span>
				<button class='chat-id-value folder-picker-trigger' title={props.chatFolder || undefined} onClick={() => { setRemoteBrowse(false); setOpen(o => !o); }}>
					{props.chatFolder ? shortenPath(props.chatFolder) : 'Select folder...'}
				</button>
				<Show when={props.chatFolder}>
					<button class='slim-but' onClick={clear} title='Clear folder'>×</button>
				</Show>
			</div>
			<Show when={open()}>
				<div class='folder-picker-dropdown'>
					<Show when={!remoteBrowse()}>
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
						<button class='folder-picker-browse' onClick={() => void browse()}>
							<TbOutlineFolder size={14} />
							<span>{backend().id === 'local' ? 'Browse system...' : `Browse ${backend().label}...`}</span>
						</button>
					</Show>
					<Show when={remoteBrowse()}>
						<RemoteFolderBrowser backend={backend()} initial={props.chatFolder || ''} onSelect={select} onCancel={() => setRemoteBrowse(false)} />
					</Show>
				</div>
			</Show>
		</div>
	);
}

/** Remote directory browser: an editable path, subdirectories via
 *  backend.readDir, and a select action. POSIX paths only (ssh backends). */
function RemoteFolderBrowser(props: {
	backend: Backend;
	initial: string;
	onSelect: (path: string) => void;
	onCancel: () => void;
}) {
	const [path, setPath] = createSignal('');
	const [entries, setEntries] = createSignal<DirEntry[]>([]);
	const [error, setError] = createSignal('');
	const [loading, setLoading] = createSignal(true);

	async function nav(p: string) {
		setLoading(true);
		setError('');
		try {
			if (!p) p = await props.backend.homeDir();
			const list = await props.backend.readDir(p);
			setEntries(list
				.filter(e => e.isDirectory && e.name !== '.' && e.name !== '..')
				.sort((a, b) => a.name.localeCompare(b.name)));
			setPath(p);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	onMount(() => void nav(props.initial));

	const parent = () => folderParent(path());
	const child = (name: string) => path().replace(/\/+$/, '') + '/' + name;

	return (
		<div>
			<div class='folder-picker-search'>
				<TbOutlineFolder size={14} />
				<input
					type='text'
					placeholder='Remote path...'
					value={path()}
					onInput={e => setPath(e.currentTarget.value)}
					onKeyDown={e => {
						if (e.key === 'Enter') void nav(path());
						if (e.key === 'Escape') props.onCancel();
					}}
				/>
			</div>
			<div class='folder-picker-list'>
				<Show when={parent()}>
					<button class='folder-picker-item' onClick={() => void nav(parent())}>
						<span class='folder-picker-name'>..</span>
						<span class='folder-picker-parent'>{shortenPath(parent())}</span>
					</button>
				</Show>
				<For each={entries()}>
					{e => (
						<button class='folder-picker-item' onClick={() => void nav(child(e.name))} title={child(e.name)}>
							<span class='folder-picker-name'>{e.name}</span>
						</button>
					)}
				</For>
				<Show when={loading()}>
					<div class='folder-picker-empty'>Loading...</div>
				</Show>
				<Show when={!loading() && error()}>
					<div class='folder-picker-empty'>{error()}</div>
				</Show>
				<Show when={!loading() && !error() && entries().length === 0}>
					<div class='folder-picker-empty'>No subdirectories</div>
				</Show>
			</div>
			<div class='folder-picker-remote-actions'>
				<button onClick={() => path() && props.onSelect(path())} title={path() || undefined}>Select this folder</button>
				<button onClick={props.onCancel}>Cancel</button>
			</div>
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
	allTags: () => string[],
	folderCounts: () => Record<string, number>,
	onSetTags?: ((id: string, tags: string[]) => void) | undefined,
	onTagFolder?: ((folder: string, tag: string) => void) | undefined,
	onSearchFolder: (folder: string) => void,
	onTagSearch: (tag: string) => void,
	openTagEditor: (chat: Chat, anchor: HTMLElement) => void,
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
	const tagsFor = () => props.chat.tags ?? [];
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
						<div class="chat-item-sub">
							<span class="chat-item-date">{formatRelativeTime(props.chat.updated)}</span>
							<Show when={tagsFor().length}>
								<span class="chat-item-tags">
									<For each={tagsFor()}>
									{t => (
										<button class="chat-tag" title={`Filter by “${t}”`}
											onClick={e => { e.stopPropagation(); ctx.onTagSearch(t); }}>
											{t}
										</button>
									)}
									</For>
								</span>
							</Show>
					</div>
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
							<div ref={menuEl} class="popup-menu" style={menuPos()} onClick={e => e.stopPropagation()}>
								<button onClick={() => { setMenuOpen(false); startRename(); }}><TbOutlinePencil size={14} /> Rename</button>
								<button onClick={() => { setMenuOpen(false); ctx.onDuplicate(props.chat.id); }}><TbOutlineCopy size={14} /> Duplicate</button>
								<Show when={ctx.onGenerateTitle}>
									<button onClick={() => { setMenuOpen(false); void ctx.onGenerateTitle!(props.chat.id); }}><TbOutlineSparkles size={14} /> Generate title</button>
								</Show>
								<Show when={ctx.onSetTags}>
									<button onClick={() => { setMenuOpen(false); ctx.openTagEditor(props.chat, menuBtn); }}><TbOutlineTag size={14} /> Tags…</button>
								</Show>
								<button class="popup-menu-danger" onClick={e => { setMenuOpen(false); handleDelete(e); }}><TbOutlineTrashX size={14} /> Delete</button>
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

/** Floating tag editor, anchored and closed like the chat-item menu.
 *
 *  Chat mode (`tags` + `onSetTags`): chip list with × plus free input — every
 *  add/remove applies immediately. Folder mode (`onApplyTag`): a single input
 *  that applies one tag to every chat in a folder in one shot. */
function TagEditor(props: {
	anchor: HTMLElement,
	tags?: string[] | undefined,
	folderChatCount?: number | undefined,
	allTags: () => string[],
	onSetTags?: ((tags: string[]) => void) | undefined,
	onApplyTag?: ((tag: string) => void) | undefined,
	onClose: () => void,
}) {
	const [pos, setPos] = createSignal<Record<string, string>>({});
	const [draft, setDraft] = createSignal('');
	const [tags, setTags] = createSignal<string[]>(props.tags ?? []);
	const chatMode = () => props.onSetTags !== undefined;
	let popEl: HTMLDivElement | undefined;

	createEffect(() => {
		const rect = props.anchor.getBoundingClientRect();
		setPos({ top: `${rect.bottom + 4}px`, left: `${Math.max(8, rect.left - 100)}px` });
		function onDocClick(e: MouseEvent) {
			const t = e.target as Node;
			if (!props.anchor.contains(t) && !popEl?.contains(t)) props.onClose();
		}
		document.addEventListener('mousedown', onDocClick);
		onCleanup(() => document.removeEventListener('mousedown', onDocClick));
	});

	function add(tag: string) {
		const v = tag.trim();
		if (!v) return;
		if (chatMode()) {
			if (!tags().some(t => t.toLowerCase() === v.toLowerCase())) {
				setTags([...tags(), v]);
				props.onSetTags?.(tags());
			}
			setDraft('');
		} else {
			props.onApplyTag?.(v);
			props.onClose();
		}
	}

	function remove(tag: string) {
		setTags(tags().filter(t => t !== tag));
		props.onSetTags?.(tags());
	}

	const suggestions = createMemo(() => {
		const q = draft().trim().toLowerCase();
		const existing = new Set(tags().map(t => t.toLowerCase()));
		return props.allTags().filter(t => !existing.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q))).slice(0, 8);
	});

	return (
		<Portal mount={document.body}>
			<div ref={popEl} class="popup-menu chat-tag-editor" style={{ ...pos(), 'min-width': '230px' }} onClick={e => e.stopPropagation()}>
				<Show when={chatMode()}>
					<div class="chat-tag-chips">
						<For each={tags()} fallback={<span class="chat-tag-empty">No tags yet</span>}>
							{t => (
								<span class="chat-tag">
									{t}
									<button class="slim-but" title="Remove" onClick={() => remove(t)}>×</button>
								</span>
							)}
						</For>
					</div>
				</Show>
				<input
					class="chat-rename-input"
					style="width: calc(100% - 12px); margin: 4px 6px"
					value={draft()}
					placeholder={chatMode()
						? 'Add tag — Enter to add'
						: `Apply one tag to all ${props.folderChatCount ?? ''} chat${props.folderChatCount === 1 ? '' : 's'} in this folder…`}
					onInput={e => setDraft(e.currentTarget.value)}
					onKeyDown={e => {
						if (e.key === 'Enter') { e.preventDefault(); add(draft()); }
						if (e.key === 'Escape') props.onClose();
					}}
					ref={el => setTimeout(() => el.focus(), 0)}
				/>
				<Show when={draft().trim()}>
					<For each={suggestions()} fallback={<span class="chat-tag-empty">New tag — press Enter</span>}>
						{t => <button onClick={() => add(t)}><TbOutlineTag size={13} /> {t}</button>}
					</For>
				</Show>
			</div>
		</Portal>
	);
}

/** One row in the search box's Tags section: filter, rename everywhere, delete everywhere. */
function TagSearchRow(props: {
	option: { tag: string, count: number },
	active: boolean,
	/** Flat index across all rendered search hits, for arrow-key selection. */
	hit: number,
	selected: boolean,
	onScope: () => void,
	onRename?: ((from: string, to: string) => void) | undefined,
	onDelete?: ((tag: string) => void) | undefined,
}) {
	const [renaming, setRenaming] = createSignal(false);
	const [edit, setEdit] = createSignal('');
	function commitRename() {
		const v = edit().trim();
		setRenaming(false);
		if (v && v.toLowerCase() !== props.option.tag.toLowerCase()) props.onRename?.(props.option.tag, v);
	}
	return (
		<div class="chat-search-hit-row" data-hit={props.hit}
			classList={{ 'chat-tag-active': props.active, 'chat-search-hit-active': props.selected }}>
			<Show when={renaming()} fallback={
				<button class="chat-search-hit chat-tag-row" onClick={props.onScope} title="Filter chats by this tag">
					<div class="chat-search-hit-head">
						<TbOutlineTag size={12} />
						<span class="chat-search-hit-name">#{props.option.tag}</span>
						<span class="chat-search-hit-meta">{props.option.count} chat{props.option.count !== 1 ? 's' : ''}</span>
					</div>
				</button>
			}>
				<input
					class="chat-rename-input"
					style="margin: 4px 6px"
					value={edit()}
					onInput={e => setEdit(e.currentTarget.value)}
					onBlur={() => setRenaming(false)}
					onKeyDown={e => {
						if (e.key === 'Enter') commitRename();
						if (e.key === 'Escape') setRenaming(false);
					}}
					ref={el => setTimeout(() => el.focus(), 0)}
				/>
			</Show>
			<Show when={props.onRename}>
				<button class="slim-but" title="Rename this tag everywhere" onClick={() => { setEdit(props.option.tag); setRenaming(true); }}>
					<TbOutlinePencil size={14} />
				</button>
			</Show>
			<Show when={props.onDelete}>
				<button class="slim-but" title="Remove this tag from all chats"
					onClick={() => { void (async () => {
						if (await confirmDialog(`Remove “${props.option.tag}” from all chats?`)) props.onDelete!(props.option.tag);
					})(); }}>
					<TbOutlineTrashX size={14} />
				</button>
			</Show>
		</div>
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
	const [tagOpen, setTagOpen] = createSignal(false);
	let tagBtn!: HTMLButtonElement;
	let header!: HTMLDivElement;
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
	// Collapsing shrinks the list under a stuck header; bring it back into view
	const toggle = () => {
		const collapsing = expanded();
		props.onToggleExpand();
		if (collapsing) header.scrollIntoView({ block: 'nearest' });
	};

	return (
		<div class="chat-group">
			<div ref={header} data-folder={props.folder} classList={{'chat-folder-header': true, 'chat-folder-header-current': props.isCurrent}}
				title={props.folder || undefined}
				style="justify-content: space-between;"
			>
				<div style="display: flex; align-items: center; gap: 6px; overflow: hidden;"
					classList={{ 'chat-folder-name-toggle': collapsible() }}
					onClick={() => collapsible() && toggle()}
				>
					<TbOutlineFolder size={14} />
					<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{folderLabel(props.folder)}</span>
				</div>
				<div style="display: flex; align-items: center; gap: 2px; flex-shrink: 0;">
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
					<button class="slim-but" onClick={e => { e.stopPropagation(); ctx.onSearchFolder(props.folder === NOFOLDER ? '' : props.folder); }}
						title="Search inside this folder">
						<TbOutlineFolderSearch size={14} />
					</button>
					<Show when={ctx.onTagFolder}>
						<button ref={tagBtn} class="slim-but" onClick={e => { e.stopPropagation(); setTagOpen(v => !v); }}
							title={ctx.folderCounts()[props.folder]
								? `Tag all ${ctx.folderCounts()[props.folder]} chats in this folder`
								: 'Tag all chats in this folder'}>
							<TbOutlineTag size={14} />
						</button>
					</Show>
					<Show when={collapsible() && expanded()}>
						<button class="slim-but chat-folder-collapse" onClick={e => { e.stopPropagation(); toggle(); }}
							title="Show less">
							<TbOutlineChevronUp size={14} />
						</button>
					</Show>
				</div>
			</div>
			<Show when={tagOpen() && ctx.onTagFolder}>
				<TagEditor
					anchor={tagBtn}
					folderChatCount={ctx.folderCounts()[props.folder]}
					allTags={ctx.allTags}
					onApplyTag={tag => ctx.onTagFolder!(props.folder === NOFOLDER ? '' : props.folder, tag)}
					onClose={() => setTagOpen(false)}
				/>
			</Show>
			<For each={visibleNodes()}>
			{node => (
				<ChatItem chat={node.chat} children={node.children} />
			)}
			</For>
			<Show when={collapsible()}>
				<button
					class="chat-folder-toggle"
					onClick={toggle}
				>
					{expanded() ? 'show less' : `${hiddenCount()} more…`}
				</button>
			</Show>
		</div>
	);
}

function ChatSwitcher(props: {
	chatList: Chat[],
	currentChatId: string,
	currentChatFolder?: string | undefined,
	runningChatIds?: Set<string> | undefined,
	onSwitchChat: (id: string, addHistory?: boolean, scrollToDbId?: number) => void,
	onSearchMessages?: ((query: string, folders?: string[], tags?: string[], excludeTags?: string[]) => Promise<MessageSearchResult[]>) | undefined,
	onCreateChat: () => void,
	onCreateChatInFolder: ((folder: string) => void),
	onDeleteChat: (id: string) => void,
	onRenameChat: (id: string, name: string) => void,
	onDuplicateChat: (id: string) => void,
	onGenerateTitle?: ((id: string) => Promise<boolean>) | undefined,
	onSetTags?: ((id: string, tags: string[]) => void) | undefined,
	onTagFolder?: ((folder: string, tag: string) => void) | undefined,
	onRenameTag?: ((from: string, to: string) => void) | undefined,
	onDeleteTag?: ((tag: string) => void) | undefined,
}) {
	// Capture once on mount — keeps sort order stable when switching between chats
	const pinnedFolder = props.currentChatFolder || NOFOLDER;	// Two-phase search: titles filter live (in-memory, free), message contents are
	// an explicit second step (hits SQLite FTS) so typing never queries the db.
	const [query, setQuery] = createSignal('');
	const [contentResults, setContentResults] = createSignal<MessageSearchResult[] | null>(null);
	const [searching, setSearching] = createSignal(false);

	// Leading facets scope the search: `folder:name`, `tag:name` (any number, all
	// required) and `-tag:name` (excluded). Blank values keep a facet "open" —
	// the options list shows while it stays ignored for scoping. `folder:name` on
	// its own lists folders, `tag:` on its own lists tags. Quote names with spaces
	// (the UI always does).
	//
	// `parsed` follows every keystroke (input, buttons, actions); `searched` trails it
	// on idle time and feeds the fuzzy searches, so typing never waits for them.
	const parsed = createMemo(() => parseFacets(query()));
	const searchQuery = createDeferred(query, { timeoutMs: 150 });
	const searched = createMemo(() => parseFacets(searchQuery()));
	const facetsActive = () => searched().folderTerm !== null || searched().excludeFolders.length > 0
		|| searched().tags.length > 0 || searched().excludeTags.length > 0;

	/** Folder paths the current scope covers: the `folder:` term resolved (all
	 *  folders when blank), minus every `-folder:` exclusion. Null when unscoped. */
	const folderScope = createMemo(() => {
		const excluded = new Set(excludedFolders());
		const { folderTerm } = searched();
		if (folderTerm === null && excluded.size === 0) return null;
		const base = folderTerm !== null ? folderMatches(folderTerm) : folderMatches('');
		return base.map(f => f.path).filter(path => !excluded.has(path));
	});

	/** Chats within the facet scope (folders ∩ required tags, minus excluded tags) — the whole list when unscoped. */
	const scopedChats = createMemo(() => {
		let list = props.chatList;
		const folders = folderScope();
		if (folders) {
			const set = new Set(folders);
			list = list.filter(c => set.has(c.chat_folder || NOFOLDER));
		}

		// Per-term: exact name hit, else fuzzy
		const tagSets = searched().tags
			.filter(t => t !== '')
			.map(t => new Set(tagMatches(t).map(o => o.tag.toLowerCase())));
		if (tagSets.length) list = list.filter(c => {
			const have = new Set((c.tags ?? []).map(t => t.toLowerCase()));
			return tagSets.every(s => Array.from(s).some(t => have.has(t)));
		});

		const banned = new Set(searched().excludeTags
			.filter(t => t !== '')
			.flatMap(t => tagMatches(t).map(o => o.tag.toLowerCase())));
		if (banned.size) list = list.filter(c => (c.tags ?? []).every(t => !banned.has(t.toLowerCase())));
		return list;
	});

	// Deliberately not FUSE_OPTIONS: its useExtendedSearch makes leading !, ^, $
	// and | operators, which is wrong for free-text titles.
	const titleFuse = createMemo(() => new Fuse(scopedChats(), {
		keys: ['name'], ignoreLocation: true, threshold: 0.4,
	}));

	const chatSearch = createMemo(() => {
		const q = searched().text;
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

	/** Folder paths the `-folder:` terms resolve to and drop (blank terms ignored). */
	function excludedFolders(): string[] {
		const out = new Set<string>();
		for (const term of searched().excludeFolders) {
			if (!term) continue;
			for (const f of folderMatches(term)) out.add(f.path);
		}
		return [...out];
	}

	// Tag options with counts, indexed for fuzzy matching — mirrors folderOptions.
	const tagOptions = createMemo(() => {
		const counts = new Map<string, number>();
		for (const c of props.chatList)
			for (const t of c.tags ?? []) counts.set(t, (counts.get(t) || 0) + 1);
		const options = Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }));
		return {
			options,
			fuse: new Fuse(options, { keys: ['tag'], ignoreLocation: true, threshold: 0.4 }),
		};
	});

	/** Tags matching `term`: all when blank, exact name hits when there are any, else fuzzy. */
	function tagMatches(term: string) {
		const { options, fuse } = tagOptions();
		const t = term.trim();
		if (!t) return options;
		const lt = t.toLowerCase();
		const exact = options.filter(o => o.tag.toLowerCase() === lt);
		if (exact.length) return exact;
		return fuse.search(t, { limit: 10 }).map(r => r.item);
	}

	// Folders match live alongside titles, and are the only results while a `folder:`
	// term is being narrowed down.
	const folderSearch = createMemo(() => {
		const { folderTerm, text } = searched();
		if (folderTerm !== null) return text ? [] : folderMatches(folderTerm);
		return text ? folderMatches(text) : [];
	});

	// Same for tags: options for the tag term being typed (or matching the free
	// text, as a discovery path while searching names).
	const tagSearch = createMemo(() => {
		const { tags, excludeTags, text } = searched();
		const facets = [...tags, ...excludeTags];
		if (facets.length) return text ? [] : tagMatches(facets[facets.length - 1]);
		return text ? tagMatches(text) : [];
	});

	/** Human echo of the active scope, e.g. `work · #story −#wip`. Empty while a
	 *  facet is being opened but not filled in. */
	const scopeSummary = createMemo(() => {
		const p = searched();
		const parts: string[] = [];
		if (p.folderTerm !== null) {
			const scope = folderScope()!;
			parts.push(scope.length === 1
				? folderLabel(scope[0] === NOFOLDER ? '' : scope[0])
				: `${scope.length} folders`);
		}
		const excluded = excludedFolders();
		if (excluded.length) parts.push(excluded.length === 1
			? `−${folderLabel(excluded[0] === NOFOLDER ? '' : excluded[0])}`
			: `−${excluded.length} folders`);
		for (const t of p.tags) if (t !== '') parts.push(`#${t}`);
		for (const t of p.excludeTags) if (t !== '') parts.push(`−#${t}`);
		return parts.join(' · ');
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

	/** `folder:` / `tag:` tokens for a term, quoted only when they need to be. */
	const folderToken = (term: string) => `folder:${/\s/.test(term) ? `"${term}"` : term}`;
	const excludeFolderToken = (term: string) => `-folder:${/\s/.test(term) ? `"${term}"` : term}`;
	const tagToken = (term: string) => `tag:${/\s/.test(term) ? `"${term}"` : term}`;
	const excludeToken = (term: string) => `-tag:${/\s/.test(term) ? `"${term}"` : term}`;

	let searchInput: HTMLInputElement | undefined;
	function scopeToFolder(f: { name: string, path: string }) {
		// Labels are just the leaf name, so fall back to the full path when two
		// folders share one — otherwise the term would resolve to both.
		const ambiguous = folderOptions().options.filter(o => o.name === f.name).length > 1;
		const term = ambiguous ? f.path : f.name;
		// Other tag facets and free text survive the re-scope
		const p = parsed();
		const parts = [folderToken(term),
			...p.excludeFolders.map(excludeFolderToken),
			...p.tags.map(tagToken), ...p.excludeTags.map(excludeToken)];
		if (p.text) parts.push(p.text);
		setQuery(parts.join(' ') + ' ');
		setContentResults(null);
		searchInput?.focus();
	}

	function scopeToTag(tag: string) {
		setQuery(tagToken(tag) + ' ');
		setContentResults(null);
		searchInput?.focus();
	}

	/** Toggle a facet prefix on/off, carrying the typed text across in both
	 *  directions. Other facets stay put. Closing a facet drops its exclusions
	 *  with it. */
	function toggleFacet(kind: 'folder' | 'tag') {
		const p = parsed();
		const hasFolder = p.folderTerm !== null || p.excludeFolders.length > 0;
		const hasTags = p.tags.length > 0 || p.excludeTags.length > 0;
		let text = p.text;
		const parts: string[] = [];
		// Opening a facet absorbs the free text as its first term, as folders always did
		if (kind === 'folder' && !hasFolder) { parts.push(folderToken(text)); text = ''; }
		if (kind === 'tag' && !hasTags) { parts.push(tagToken(text)); text = ''; }
		if (hasFolder && kind !== 'folder') {
			if (p.folderTerm !== null) parts.push(folderToken(p.folderTerm));
			parts.push(...p.excludeFolders.map(excludeFolderToken));
		}
		if (hasTags && kind !== 'tag') {
			parts.push(...p.tags.map(tagToken), ...p.excludeTags.map(excludeToken));
		}
		if (text) parts.push(text);
		setQuery(parts.join(' '));
		setContentResults(null);
		searchInput?.focus();
	}

	async function runContentSearch() {
		const q = parsed().text;
		if (!q || !props.onSearchMessages || searching()) return;
		const folders = folderScope();
		const tags = parsed().tags.filter(t => t !== '');
		const excludeTags = parsed().excludeTags.filter(t => t !== '');
		const queryAtStart = query();
		setSearching(true);
		try {
			// NOFOLDER is a display-only sentinel; the db knows unfoldered chats as ''
			const found = await props.onSearchMessages(q,
				folders?.map(f => f === NOFOLDER ? '' : f),
				tags.length ? tags : undefined,
				excludeTags.length ? excludeTags : undefined);
			// Ignore a result set the user has already typed past
			if (query() === queryAtStart) setContentResults(found);
		} finally {
			setSearching(false);
		}
	}

	// Arrow-key navigation: one action per rendered hit row, in section order —
	// folders, tags, chat titles, message hits. Rows carry data-hit indices
	// matching this list.
	const hits = createMemo(() => {
		const run: (() => void)[] = [];
		for (const f of folderSearch()) run.push(() => jumpToFolder(f.path));
		for (const t of tagSearch()) run.push(() => scopeToTag(t.tag));
		for (const m of chatSearch()) run.push(() => props.onSwitchChat(m.chat.id));
		for (const r of contentResults() ?? []) run.push(() => props.onSwitchChat(r.chatId, true, r.dbId));
		return run;
	});
	const hitOffsets = createMemo(() => {
		const folders = folderSearch().length;
		const tags = folders + tagSearch().length;
		return { tag: folders, chat: tags, message: tags + chatSearch().length };
	});
	const [selectedHit, setSelectedHit] = createSignal(-1);
	// Any edit, fresh search or chat-list change (tag renames/deletes move rows)
	// restarts navigation from nothing
	createEffect(on([query, contentResults, () => props.chatList], () => setSelectedHit(-1)));
	createEffect(() => {
		if (selectedHit() < 0) return;
		document.querySelector(`[data-hit="${selectedHit()}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	// Track expanded folders here so state survives ChatGroup remounts on chat switch
	const [expandedFolders, setExpandedFolders] = createSignal<Set<string>>(new Set());
	const toggleFolder = (folder: string) => setExpandedFolders(prev => {
		const next = new Set(prev);
		next.has(folder) ? next.delete(folder) : next.add(folder);
		return next;
	});

	// Chat tag editor, lifted here (like expandedFolders) so it survives the chat
	// list re-rendering after every applied change
	const [tagEditor, setTagEditor] = createSignal<{ chat: Chat, anchor: HTMLElement } | null>(null);

	// Chats per folder over the whole, unscoped list — "tag all chats in folder"
	// applies to the folder itself, not the current filtered view.
	const folderCounts = createMemo(() => {
		const counts: Record<string, number> = {};
		for (const c of props.chatList) {
			const f = c.chat_folder || NOFOLDER;
			counts[f] = (counts[f] || 0) + 1;
		}
		return counts;
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
		// Scoped chats form the tree; a fork still groups under its root even when
		// the root itself is out of scope (forks copy tags at fork time, so rare).
		for (const chat of scopedChats()) {
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
			<button class="dotted-button combined-button" onClick={() => props.onCreateChat()}>
				<TbOutlinePlus size={16} /> New Chat
			</button>
			<div class="chat-search">
				<TbOutlineSearch size={14} />
				<input
					ref={searchInput}
					type="text"
					placeholder="Search chats & folders..."
					title="Search chats & folders (Ctrl+O)"
					value={query()}
					onInput={e => { setQuery(e.currentTarget.value); setContentResults(null); }}
					onKeyDown={e => {
						if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
							const n = hits().length;
							if (!n) return;
							e.preventDefault();
							const dir = e.key === 'ArrowDown' ? 1 : -1;
							// Wraps both directions; from nothing, down starts at the top, up at the bottom
							setSelectedHit(i => i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n);
							return;
						}
						if (e.key === 'Enter') {
							e.preventDefault();
							const run = hits()[selectedHit()];
							// Enter on a selected row runs it; otherwise it searches message contents
							if (run) run(); else void runContentSearch();
						}
						if (e.key === 'Escape') { setQuery(''); setContentResults(null); }
					}}
				/>
				<Show when={query()}>
					<button class="slim-but" onClick={() => { setQuery(''); setContentResults(null); }} title="Clear">×</button>
				</Show>
			</div>
			<Show when={query().trim()}>
				<div style="display: flex; align-items: center; gap: 8px; padding: 8px 2px; border-bottom: 1px solid var(--border-subtle);">
					<button
						classList={{ 'combined-button': true, 'chat-search-filter-on': parsed().folderTerm !== null || parsed().excludeFolders.length > 0 }}
						style="padding: 5px 10px"
						onClick={() => toggleFacet('folder')}
						title="Restrict the search to folders (folder:name, -folder:name to exclude)"
					>
						<TbOutlineFolder size={12} /> Folder
					</button>
					<button
						classList={{ 'combined-button': true, 'chat-search-filter-on': parsed().tags.length > 0 || parsed().excludeTags.length > 0 }}
						style="padding: 5px 10px"
						onClick={() => toggleFacet('tag')}
						title="Restrict the search to tags (#name or tag:name, -#name to exclude)"
					>
						<TbOutlineTag size={12} /> Tag
					</button>
					{/* Echo what the facets actually resolved to — makes a mis-parse visible */}
					<Show when={facetsActive()}>
						<span class="chat-search-scope" title={scopeSummary()}>
							{scopeSummary() || 'pick a folder or tag, or add a query to search inside'}
						</span>
					</Show>
					<Show when={props.onSearchMessages && parsed().text}>
						<button class="combined-button" style="padding: 5px 10px" disabled={searching()} onClick={() => void runContentSearch()}>
							{searching() ? 'Searching…' : contentResults() ? 'Search again ↵' : 'Search contents ↵'}
						</button>
					</Show>
				</div>

				<div class="chat-search-results" classList={{ 'chat-search-results-solo': !!parsed().text }}>
					<Show when={folderSearch().length > 0}>
						<div class="chat-search-label">Folders</div>
						<For each={folderSearch()}>
							{(f, i) => (
								<div class="chat-search-hit-row" data-hit={i()}
									classList={{ 'chat-search-hit-active': selectedHit() === i() }}>
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
					<Show when={searched().folderTerm !== null && folderScope()?.length === 0}>
						<div class="chat-search-empty">No folders match “{searched().folderTerm}”</div>
					</Show>
					<Show when={tagSearch().length > 0}>
						<div class="chat-search-label">Tags</div>
						<For each={tagSearch()}>
							{(t, i) => (
								<TagSearchRow
									option={t}
									active={searched().tags.some(x => x.toLowerCase() === t.tag.toLowerCase())}
									hit={hitOffsets().tag + i()}
									selected={selectedHit() === hitOffsets().tag + i()}
									onScope={() => scopeToTag(t.tag)}
									onRename={props.onRenameTag}
									onDelete={props.onDeleteTag}
								/>
							)}
						</For>
					</Show>
					<Show when={searched().text}>
					<div class="chat-search-label">Chats</div>
				<For each={chatSearch()} fallback={<div class="chat-search-empty">No matching titles</div>}>
						{(m, i) => (
							<button class="chat-search-hit" data-hit={hitOffsets().chat + i()}
								classList={{ 'chat-search-hit-active': selectedHit() === hitOffsets().chat + i() }}
								onClick={() => props.onSwitchChat(m.chat.id)}>
								<div class="chat-search-hit-head">
									<span class="chat-search-hit-name">{m.chat.name}</span>
									<Show when={m.chat.id === props.currentChatId}>
										<span class="chat-search-hit-current">current</span>
									</Show>
									<span class="chat-search-hit-meta">{formatRelativeTime(m.chat.updated)}</span>
								</div>
								<div class="chat-search-hit-folder">
									<TbOutlineFolder size={11} /> {folderLabel(m.chat.chat_folder || '')}
									<Show when={(m.chat.tags ?? []).length}>
										<span class="chat-search-hit-meta">{(m.chat.tags ?? []).map(t => `#${t}`).join(' ')}</span>
									</Show>
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
							{(r, i) => (
								<button class="chat-search-hit" data-hit={hitOffsets().message + i()}
									classList={{ 'chat-search-hit-active': selectedHit() === hitOffsets().message + i() }}
									onClick={() => props.onSwitchChat(r.chatId, true, r.dbId)}>
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
											{r.copies ? ` · also in ${r.copies} fork${r.copies > 1 ? 's' : ''}` : ''}
										</span>
									</div>
									<div class="chat-search-snippet" innerHTML={r.snippet} />
								</button>
							)}
						</For>
					</Show>
				</div>
			</Show>
			<div class="chat-list" style={parsed().text ? 'display: none' : undefined}>
				<ChatListContext.Provider value={{
				get currentChatId() { return props.currentChatId; },
				get runningChatIds() { return props.runningChatIds || new Set(); },
				onSwitch: props.onSwitchChat,
				onDelete: props.onDeleteChat,
				onRename: props.onRenameChat,
				onDuplicate: props.onDuplicateChat,
				onGenerateTitle: props.onGenerateTitle,
				onSetTags: props.onSetTags,
				onTagFolder: props.onTagFolder,
				onTagSearch: tag => scopeToTag(tag),
				onSearchFolder: folder => {
					const option = folderOptions().options.find(o => o.path === (folder || NOFOLDER));
					if (option) scopeToFolder(option);
				},
				openTagEditor: (chat, anchor) => setTagEditor({ chat, anchor }),
				allTags: () => tagOptions().options.map(o => o.tag),
				folderCounts: () => folderCounts(),
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
				<Show when={tagEditor()}>
					{te => (
						<TagEditor
							anchor={te().anchor}
							tags={te().chat.tags ?? []}
							allTags={() => tagOptions().options.map(o => o.tag)}
							onSetTags={tags => props.onSetTags?.(te().chat.id, tags)}
							onClose={() => setTagEditor(null)}
						/>
					)}
				</Show>
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
	const [newApi, setNewApi] = createSignal<ApiType>('completions');

	function addProvider() {
		const name = newName().trim();
		if (!name) return;
		const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
		if (props.providers[key]) return; // already exists
		props.setProviders(prev => ({
			...prev,
			[key]: { url: newUrl().trim(), apiKey: newKey().trim(), enabled: true, name, apiType: newApi() }
		}));
		setNewName(''); setNewUrl(''); setNewKey('');
	}

	const addOnBlur = (e: FocusEvent) => {
		const to = e.relatedTarget;
		if (to instanceof HTMLElement && to.closest('.provider-add')) return;
		addProvider();
	}

	const [kagiKey, setKagiKey] = createSignal(localStorage.getItem('kagiKey') ?? '');
	const [parallelKey, setParallelKey] = createSignal(localStorage.getItem('parallelKey') ?? '');
	const [extractProvider, setExtractProvider] = createSignal(localStorage.getItem('extractProvider') ?? 'kagi');
	const [searchProvider, setSearchProvider] = createSignal(localStorage.getItem('searchProvider') ?? 'kagi');
	const [parallelSearchMode, setParallelSearchMode] = createSignal(localStorage.getItem('parallelSearchMode') ?? 'basic');

	return (
		<details class="sidebar-section api-key-manager" open={false}>
			<summary>
				<span class='sidebar-section-title'>Providers</span>
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
								onBlur={e => update(key, { apiKey: e.target.value })}
								style="margin-top: 4px;"
							/>
							<div style="display: flex; align-items: center; gap: 4px; margin-top: 2px;">
								<input
									type='text'
									placeholder='API URL'
									value={cfg()?.url ?? ''}
									onBlur={e => update(key, { url: e.target.value })}
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
								onBlur={e => update(key, { apiKey: e.target.value })}
								style="margin-top: 4px;"
							/>
							<input
								type='text'
								placeholder='API URL'
								value={cfg()?.url ?? ''}
								onBlur={e => update(key, { url: e.target.value })}
								style="margin-top: 2px; font-size: 0.8em; opacity: 0.7;"
							/>
							<select
								value={cfg()?.apiType ?? 'completions'}
								onInput={e => update(key, { apiType: e.target.value as ApiType })}
								style="margin-top: 2px; font-size: 0.8em; opacity: 0.7;"
							>
								<option value='completions'>Chat Completions</option>
								<option value='responses'>Responses</option>
							</select>
						</Show>
					</div>
				)}}
			</For>

			<div class="provider-add" style="margin: 8px 0 0 10px; display: flex; flex-direction: column; gap: 4px;">
				<div style="display: flex; gap: 4px; align-items: center;">
					<input type='text' placeholder='Name' value={newName()} onInput={e => setNewName(e.target.value)} style="flex: 1; font-size: 0.85em;" onKeyDown={e => e.key === 'Enter' && addProvider()} onBlur={addOnBlur} />
					<button class='slim-but' onClick={addProvider} title='Add provider'><TbOutlinePlus size={14} /></button>
				</div>
				<select value={newApi()} onInput={e => setNewApi(e.target.value as ApiType)} style="font-size: 0.8em; opacity: 0.7;">
					<option value='completions'>Chat Completions</option>
					<option value='responses'>Responses</option>
				</select>
				<input type='text' placeholder='URL (optional)' value={newUrl()} onInput={e => setNewUrl(e.target.value)} style="font-size: 0.8em; opacity: 0.7;" onKeyDown={e => e.key === 'Enter' && addProvider()} onBlur={addOnBlur} />
				<input type='text' placeholder='API key (optional)' value={newKey()} onInput={e => setNewKey(e.target.value)} style="font-size: 0.8em; opacity: 0.7;" onKeyDown={e => e.key === 'Enter' && addProvider()} onBlur={addOnBlur} />
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
	chat: ChatState,
	setChat: SetStoreFunction<ChatState>,
	skillDirs: SkillDirs,
	setSkillDirs: Setter<SkillDirs>
}) {
	const [newKey, setNewKey] = createSignal('');
	const [newVal, setNewVal] = createSignal('');

	// Use keys() instead of entries() - strings are compared by value,
	// so For's keyed reconciliation preserves DOM elements across updates
	const keys = () => Object.keys(props.chat.macros).filter(key => !DERIVED_MACROS.includes(key.trim()));

	function setDirs(scope: keyof SkillDirs, raw: string) {
		const dirs = raw.split('\n').map(d => d.trim()).filter(Boolean);
		props.setSkillDirs(prev => ({ ...prev, [scope]: dirs }));
	}

	function addMacro() {
		const k = newKey().trim();
		if (!k) return;
		props.setChat('macros', k, newVal());
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
		props.setChat('macros', produce(macros => { delete macros[key]; }));
	}

	function updateMacro(key: string, field: 'key' | 'value', raw: string) {
		if (field === 'value') {
			props.setChat('macros', key, raw);
		} else {
			const trimmed = raw.trim();
			if (!trimmed || trimmed === key) return;
			props.setChat('macros', produce(macros => {
				macros[trimmed] = macros[key]!;
				delete macros[key];
			}));
		}
	}

	return (
		<details class='sidebar-section' style='margin-top: 15px;'>
			<summary>
				<span class='sidebar-section-title'>Macros</span>
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
								value={props.chat.macros[key]}
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
					Use @@key in prompts or messages. Built-in: @@time, @@date, @@model, @@folder, @@id, @@topic(:prefix), @@word.<br/>
					Scanned from disk: @@agents (agents.md), @@local_skills, @@global_skills.<br/>
					ST macros ({"{{char}}"}, {"{{user}}"}, etc.) are auto-converted on import.
				</div>
				<Show when={isTauri}>
					<details style='margin-top: 6px;'>
						<summary style='font-size: 0.85em; opacity: 0.7; cursor: pointer;'>Skill folders</summary>
						<div style='font-size: 0.8em; opacity: 0.5; margin: 4px 0;'>
							Extra folders holding &lt;name&gt;/SKILL.md, one per line — absolute, or relative to the
							chat folder / your home folder. The usual agent locations (.agents/skills,
							.claude/skills, …) are always scanned.
						</div>
						<label style='font-size: 0.85em; opacity: 0.7;'>Project (@@local_skills)</label>
						<textarea
							rows={2}
							style='width: 100%; font-family: var(--font-mono, monospace); font-size: 0.85em;'
							value={props.skillDirs.local.join('\n')}
							onChange={e => setDirs('local', e.currentTarget.value)}
						/>
						<label style='font-size: 0.85em; opacity: 0.7;'>Global (@@global_skills)</label>
						<textarea
							rows={2}
							style='width: 100%; font-family: var(--font-mono, monospace); font-size: 0.85em;'
							value={props.skillDirs.global.join('\n')}
							onChange={e => setDirs('global', e.currentTarget.value)}
						/>
					</details>
				</Show>
			</div>
		</details>
	);
}

// ── Skills & widgets ───────────────────────────────────────────────────────────

/** Skills attach as files; widgets append their descriptions to the draft. */
function AttachableLists(props: {
	chat: ChatState,
	setChat: SetStoreFunction<ChatState>,
	skills: { project: SkillEntry[]; global: SkillEntry[] },
	setError: Setter<string | null> | undefined,
}) {
	async function attach(path: string, read: () => Promise<FileAttachment>) {
		if (props.chat.draft.files.some(file => file.path === path)) return;
		try {
			const file = await read();
			props.setChat('draft', produce(draft => {
				if (draft.files.some(f => f.path === path)) return;
				draft.files.push(file);
				const gap = draft.text && !/\s$/.test(draft.text) ? ' ' : '';
				draft.text += `${gap}@[${path}] `;
			}));
		} catch (err) {
			props.setError?.('Failed to attach: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	const attachSkill = (skill: SkillEntry) => attach(skill.path, async () => {
		const attached = await attachFile(skill.path, props.chat.chatFolder || '', skill.backend);
		if (!('file' in attached)) throw new Error(`${skill.path} is not a text file`);
		return attached.file;
	});

	const attachWidget = (widget: Widget) => props.setChat('draft', 'text', text => {
		const gap = text && !text.endsWith('\n') ? '\n' : '';
		return `${text}${gap}${widget.name}: ${widget.description || '(no description)'}\n`;
	});

	function Group<T extends { name: string; description: string }>(group: { title: string; items: T[]; pick: (item: T) => void }) {
		return (
			<Show when={group.items.length}>
				<div class='attachGroupTitle'>{group.title}</div>
				<For each={group.items}>
					{item => (
						<button class='attachItem' title={item.description || item.name} onClick={() => group.pick(item)}>
							<span class='attachItemName'>{item.name}</span>
							<span class='attachItemDesc'>{item.description}</span>
						</button>
					)}
				</For>
			</Show>
		);
	}

	const empty = () => !props.skills.project.length && !props.skills.global.length && !widgetRegistry().widgets.length;

	return (
		<details class='sidebar-section'>
			<summary>
				<span class='sidebar-section-title'>Skills &amp; widgets</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					click to add
				</span>
			</summary>
			<div class='promptManager attachLists'>
				<Group title='Project skills (SKILL.md)' items={props.skills.project} pick={attachSkill} />
				<Group title='Global skills (SKILL.md)' items={props.skills.global} pick={attachSkill} />
				<Group title='Widgets (description only)' items={widgetRegistry().widgets} pick={attachWidget} />
				<Show when={empty()}>
					<div style='font-size: 0.8em; opacity: 0.5;'>None found in this chat's folder or your home folder.</div>
				</Show>
			</div>
		</details>
	);
}

//# Remote tool hosts (SSH)
function RemoteBackendManager(props: { backends: SshBackendConfig[], setBackends: SetStoreFunction<SshBackendConfig[]> }) {
	// Which editor is expanded; new entries start open so their fields are visible
	const [openIds, setOpenIds] = createSignal<Set<string>>(new Set());
	function toggleOpen(id: string, open: boolean) {
		setOpenIds(prev => {
			const next = new Set(prev);
			if (open) next.add(id); else next.delete(id);
			return next;
		});
	}
	function update(id: string, patch: Partial<SshBackendConfig>) {
		props.setBackends(b => b.id === id, patch);
	}
	function add() {
		const id = `ssh:${crypto.randomUUID().slice(0, 8)}`;
		props.setBackends(prev => [...prev, { id, label: '', host: '' }]);
		toggleOpen(id, true);
	}
	function remove(id: string) {
		props.setBackends(prev => prev.filter(b => b.id !== id));
	}
	const inputStyle = 'width: 100%; font-family: var(--font-mono, monospace); font-size: 0.85em;';
	// Concrete Host aliases from ~/.ssh/config, offered as one-click adds
	const [discovered, setDiscovered] = createSignal<DiscoveredHost[]>([]);
	onMount(() => { void listSshConfigHosts().then(setDiscovered).catch(() => {}); });
	const unadded = createMemo(() =>
		discovered().filter(d => !props.backends.some(b => b.host === d.alias || b.host.endsWith('@' + d.alias))));
	function addDiscovered(d: DiscoveredHost) {
		const id = `ssh:${crypto.randomUUID().slice(0, 8)}`;
		props.setBackends(prev => [...prev, { id, label: d.alias, host: d.alias }]);
		toggleOpen(id, true);
	}

	return (
		<details class='sidebar-section'>
			<summary>
				<span class='sidebar-section-title'>Remote Backends</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					SSH hosts for tools
				</span>
			</summary>
			<div class='promptManager'>
				<For each={props.backends}>
					{b => (
						<details style='margin-bottom: 6px;' open={openIds().has(b.id)}
							onToggle={e => toggleOpen(b.id, e.currentTarget.open)}>
							<summary style='font-size: 0.85em; cursor: pointer; display: flex; align-items: center; gap: 6px;'>
								<span style='flex: 1;'>{b.label || b.host || '(unnamed)'}</span>
								<button class='slim-but' title='Remove connection'
									onClick={e => { e.preventDefault(); remove(b.id); }}>
									<TbOutlineTrashX size={14} color='red' />
								</button>
							</summary>
							<input type='text' placeholder='label' value={b.label} style={inputStyle}
								onInput={e => update(b.id, { label: e.currentTarget.value })} />
							<input type='text' placeholder='user@host:port (host may be an ~/.ssh/config alias)' value={b.host} style={inputStyle}
								onInput={e => update(b.id, { host: e.currentTarget.value })} />
							<input type='text' placeholder='key path (optional; defaults to ~/.ssh/id_*)' value={b.keyPath || ''} style={inputStyle}
								onInput={e => update(b.id, { keyPath: e.currentTarget.value || undefined })} />
							<input type='password' placeholder='password (only if no key works)' value={b.password || ''} style={inputStyle}
								onInput={e => update(b.id, { password: e.currentTarget.value || undefined })} />
						</details>
					)}
				</For>
				<div style='display: flex; gap: 6px; align-items: center; margin-top: 4px;'>
					<button class='slim-but' onClick={add} title='Add connection'>
						<TbOutlinePlus size={14} />
					</button>
					<span style='font-size: 0.8em; opacity: 0.5;'>Posix (non-windows) hosts only</span>
				</div>
				<Show when={unadded().length > 0}>
					<div style='margin-top: 8px;'>
						<span style='font-size: 0.8em; opacity: 0.6;'>Found in ~/.ssh/config:</span>
						<For each={unadded()}>
							{d => (
								<div style='display: flex; gap: 6px; align-items: center; margin-top: 2px;'>
									<span style='font-family: var(--font-mono, monospace); font-size: 0.85em;'>{d.alias}</span>
									<span style='flex: 1; opacity: 0.5; font-size: 0.8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'>
										{d.user ? d.user + '@' : ''}{d.hostname || ''}{d.port ? ':' + d.port : ''}
									</span>
									<button class='slim-but' title='Add this host' onClick={() => addDiscovered(d)}>
										<TbOutlinePlus size={14} />
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>
		</details>
	);
}

function TitlerManager(props: {
	settings: TitlerSettings,
	setSettings: Setter<TitlerSettings>,
	providers: Record<Provider, ProviderConfig>,
}) {
	return (
		<details class='sidebar-section'>
			<summary>
				<span class='sidebar-section-title'>Auto-titler</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					model that names chats
				</span>
			</summary>
			<div class='promptManager'>
				<ModelPicker
					compact
					provider={props.settings.provider}
					model={props.settings.model}
					onChange={(p, m) => props.setSettings(prev => ({ ...prev, provider: p, model: m }))}
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
	const [directory, setDirectory] = createSignal('');
	const [files, setFiles] = createSignal<BackupFile[]>([]);
	const [others, setOthers] = createSignal(0);
	const [pending, setPending] = createSignal<BackupFile | null>(null);
	const [restoreDb, setRestoreDb] = createSignal(true);
	const [restoreSettings, setRestoreSettings] = createSignal(false);
	const [backupFirst, setBackupFirst] = createSignal(true);
	const [restoreError, setRestoreError] = createSignal('');
	const [busy, setBusy] = createSignal('');

	const update = (patch: Partial<BackupSettings>) => {
		const next = { ...loadBackupSettings(), ...patch };
		saveBackupSettings(next);
		setSettings(next);
	};

	let presenceTimer: ReturnType<typeof setInterval> | undefined;
	let presenceCheck: Promise<void> | undefined;
	let sectionOpen = false;
	const checkPresence = (): Promise<void> => {
		if (!presenceCheck) presenceCheck = otherInstances()
			.then(count => {
				setOthers(count);
				if (count > 0) setRestoreDb(false);
			})
			.finally(() => { presenceCheck = undefined; });
		return presenceCheck;
	};
	const startPresencePolling = () => {
		presenceTimer = setInterval(() => { if (!busy()) void checkPresence(); }, 5_000);
	};

	let refreshVersion = 0;
	const refresh = async () => {
		const version = ++refreshVersion;
		await checkPresence();
		if (version !== refreshVersion) return;
		setSettings(loadBackupSettings());
		try {
			const dir = await backupsDir();
			const listed = await listBackups();
			if (version !== refreshVersion || dir !== await backupsDir()) return;
			setDirectory(dir);
			setFiles(current => {
				const byPath = new Map(current.map(file => [file.path, file]));
				const next = listed.map(file => {
					const previous = byPath.get(file.path);
					return previous && previous.name === file.name && previous.time === file.time
						&& previous.size === file.size && previous.settings === file.settings ? previous : file;
				});
				return next.length === current.length && next.every((file, i) => file === current[i]) ? current : next;
			});
		} catch (e) { props.setError?.('Failed to list backups: ' + errMsg(e)); }
	};

	async function changeDirectory(useDefault = false) {
		setBusy('Changing folder…');
		try {
			const selected = useDefault ? undefined : await selectFolder();
			if (selected === null) return;
			const next = { ...loadBackupSettings(), directory: selected };
			await validateBackupDirectory(next);
			if (!await confirmDialog(`Save backups here?\n${await backupsDir(next)}\n\nUse a folder just for this app. Older backups here may be removed based on your “Keep” setting.`)) return;
			update({ directory: selected });
			setPending(null);
			await refresh();
		} catch (e) {
			props.setError?.('Could not change backup folder: ' + errMsg(e));
		} finally { setBusy(''); }
	}

	const total = createMemo(() => files().reduce((n, f) => n + f.size, 0));
	const policy = createMemo(() => PROFILES[settings().profile].rules
		.map(r => `${fmtInterval(r.every)}×${r.keep}`).join(', '));
	const openRestore = (file: BackupFile) => {
		setRestoreDb(others() === 0);
		setRestoreSettings(others() > 0 && file.settings);
		setRestoreError('');
		setPending(file);
	};

	onCleanup(() => {
		sectionOpen = false;
		clearInterval(presenceTimer);
	});

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
		const file = pending();
		if (!file || (!restoreDb() && !restoreSettings()) || (restoreDb() && others() > 0)) return;
		setBusy('Restoring…');
		setRestoreError('');
		const withDb = restoreDb();
		const withSettings = restoreSettings();
		let dbRestored = false;
		try {
			if (withDb) {
				clearInterval(presenceTimer);
				presenceTimer = undefined;
				if (presenceCheck) await presenceCheck;
				if (others() > 0) throw new Error('Another app window has this database open.');
				await restoreBackup(file, { backupFirst: backupFirst() });
				dbRestored = true;
			}
			if (withSettings) await applySettings(file);
			location.reload();
		} catch (e) {
			if (dbRestored) {
				window.alert('Database restored, but settings could not be applied: ' + errMsg(e));
				location.reload();
				return;
			}
			setRestoreError(errMsg(e));
			setBusy('');
			if (sectionOpen && !presenceTimer) startPresencePolling();
			void checkPresence();
		}
	}

	return (
		<details class='sidebar-section' style='margin-bottom: 10px;' onToggle={e => {
			sectionOpen = e.currentTarget.open;
			clearInterval(presenceTimer);
			presenceTimer = undefined;
			if (sectionOpen) {
				if (!busy()) void refresh();
				startPresencePolling();
			}
		}}>
			<summary>
				<span class='sidebar-section-title'>Backups</span>
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
					<span style='font-size: 0.8em; opacity: 0.5; margin-left: 1em'>{policy()}</span>
				</label>

				<button
					class='backup-folder'
					type='button'
					disabled={!!busy() || !directory()}
					title='Open backup folder'
					aria-label={`Open backup folder: ${directory()}`}
					onClick={() => openBackupsFolder().catch(e => props.setError?.('Could not open backup folder: ' + errMsg(e)))}
				>
					<TbOutlineFolder size={14} aria-hidden='true' />
					<span>{directory()}</span>
					<TbOutlineArrowUpRight size={14} aria-hidden='true' />
				</button>
				<div class='backup-actions'>
					<button class='messageMenuButton' disabled={!!busy()} onClick={() => changeDirectory()}>Change folder</button>
					<button class='messageMenuButton' disabled={!!busy()} onClick={backupNow}>+ Back up now</button>
					<Show when={settings().directory}>
						<button class='messageMenuButton' disabled={!!busy()} onClick={() => changeDirectory(true)}>Use default</button>
					</Show>
				</div>
				<Show when={!settings().directory}>
					<div class='backup-note'>
						<TbOutlineInfoCircle size={14} aria-hidden='true' />
						<span>Pick a different folder or drive to keep backups safe if app data is deleted or damaged.</span>
					</div>
				</Show>
				<div class='backup-note' style='margin-bottom: 1.5em;'>
					<TbOutlineInfoCircle size={14} aria-hidden='true' />
					<span>Existing backups stay where they are. Choose a previous backup folder to restore them.</span>
				</div>

				<div style='font-size: 0.8em; opacity: 0.6;'>
					{busy() || (files().length ? `${files().length} backups · ${fmtSize(total())}` : 'none yet')}
				</div>

				<For each={files()}>
					{file => (
						<div class='backup-row'>
							<span>{new Date(file.time).toLocaleString()}</span>
							<span style='opacity: 0.5;'>{fmtSize(file.size)}</span>
							<span style='flex: 1;' />
							<button
								class='messageMenuButton'
								disabled={!!busy()}
								onClick={() => openRestore(file)}
							>Restore</button>
						</div>
					)}
				</For>
				<Show when={pending()}>{file => (
					<Modal title='Restore backup' classes='backup-restore-modal' onClose={() => setPending(null)} canClose={!busy()}>
						<div class='backup-restore-layout'>
							<div style="color: color-mix(in srgb, var(--text) 70%, transparent);	font-size: 0.9em;">
								Snapshot from {new Date(file().time).toLocaleString()}</div>
							<div class='backup-restore-options'>
								<label class='backup-restore-option' classList={{ 'backup-restore-unavailable': others() > 0 }}>
									<input type='checkbox' checked={restoreDb()} disabled={others() > 0 || !!busy()}
										onInput={e => setRestoreDb(e.currentTarget.checked)} />
									<strong>Chats and messages</strong>
								</label>
									<Show when={restoreDb()}>
										<label style='margin: 0 0 1em 2em; font-size: 0.9em;'>
											<input type='checkbox' checked={backupFirst()} disabled={!!busy()}
												onInput={e => setBackupFirst(e.currentTarget.checked)} />
											<span>Snapshot the current database first</span>
										</label>
									</Show>

								<Show when={others() > 0}>
									<div class='backup-restore-hint' role='alert'>
										<TbOutlineAlertTriangle size={16} aria-hidden='true' />
										<span>Close other windows to restore chats and messages.</span>
									</div>
								</Show>

								<Show when={file().settings}>
									<label class='backup-restore-option'>
										<input type='checkbox' checked={restoreSettings()} disabled={!!busy()}
											onInput={e => setRestoreSettings(e.currentTarget.checked)} />
											<strong>Settings</strong>
											<small>Prompts, configs, lore, macros and provider keys</small>
									</label>
								</Show>
							</div>
							<Show when={restoreError()}>
								<div class='backup-confirm' role='alert'>{restoreError()}</div>
							</Show>
							<div class='backup-restore-footer'>
								<span style='margin-right: auto; align-content: center; opacity: 0.6;'>The app will reload afterwards.</span>
								<button class='messageMenuButton' disabled={!!busy()} onClick={() => setPending(null)}>Cancel</button>
								<button class='messageMenuButton' style='background-color: color-mix(in srgb, red 60%, var(--back))' disabled={!!busy() || (!restoreDb() && !restoreSettings()) || (restoreDb() && others() > 0)} onClick={confirmPending}>
									{busy() || 'Restore selected'}
								</button>
							</div>
						</div>
					</Modal>
				)}</Show>
				<Show when={settings().enabled && lastBackupTime() > 0 && !files().length}>
					<div style='font-size: 0.8em; opacity: 0.5;'>Last attempt {new Date(lastBackupTime()).toLocaleString()}</div>
				</Show>
			</div>
		</details>
	);
}

// ── Image Folder Selector ───────────────────────────────────────────────

function ImageFolderSelector(props: { setError?: Setter<string | null> | undefined }) {
	async function handleFolderSelect() {
		try {
			await pickImageFolder();
		} catch (err) {
			console.error('Error selecting image folder:', err);
			props.setError?.('Failed to select image folder: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	return (
		<div title="Images here can be referenced by name from any message: ![](pic.png)">
			<label>
				<span>Image Folder</span>
				<button class='messageMenuButton' onClick={handleFolderSelect} style="margin-right: 8px;">
					{imageFolderLabel() ? 'Change Folder' : 'Open Folder'}
				</button>
				<Show when={imageFolderLabel()}>
					<button class='messageMenuButton' onClick={() => clearImageFolder()}>Clear</button>
				</Show>
			</label>
			<Show when={imageFolderLabel()}>{name => (
				<div class='sidebar-note path' style="direction: rtl; text-align: left;"
					title={name()}>{name()}</div>
			)}</Show>
		</div>
	);
}
