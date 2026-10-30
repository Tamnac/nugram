import { Setter, For, Show, createEffect, createSignal, createMemo, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { SetStoreFunction, reconcile, unwrap } from 'solid-js/store';
import type { ChatMessage, ChatMeta, Provider, ProviderConfig } from './helpers/types';
import type { ChatState } from './helpers/chatState';
import { computeChatStats } from './helpers/messages';
import { messagesToMarkdown } from './helpers/transcript';
import { createAutosave, normalizeMessage, migrateToolResults, saveMessages } from './helpers/storage';
import { confirmDialog, isTauri, saveFileDialog } from './helpers/platform';
import { ModelPicker } from './helpers/ModelPicker';
import { TSeg } from './helpers/Comps';
import { latestCheck, checkHistory, type CacheCheck, type CacheVerdict } from './helpers/cacheGuard';
import { inlineAttachments, ingestAttachments } from './helpers/attachments';
import { cardFromPng, isSTCard, parseSTCard, parseSTChat, type STCard } from './helpers/stImport';
import { TbOutlineLayoutSidebar, TbOutlineUpload, TbOutlineClearAll, TbOutlineDeviceFloppy, TbOutlineFileOff, TbOutlineCoins, TbOutlineDownload, TbOutlineSearch } from 'solid-icons/tb';

interface TopBarProps {
	chat: ChatState;
	setChat: SetStoreFunction<ChatState>;
	chatId: string;
	setMessages: SetStoreFunction<ChatMessage[]>;
	messages: ChatMessage[];
	setError: Setter<string | null>;
	setInfo: Setter<string | null>;
	providers: Record<Provider, ProviderConfig>;
	sidebarOpen: boolean;
	setSidebarOpen: Setter<boolean>;
	getChatMeta: () => ChatMeta;
	applyChatMeta: (meta: Partial<ChatMeta>) => void;
	importChat: (messages: ChatMessage[], meta?: Partial<ChatMeta>) => Promise<boolean>;
	importCard: (card: STCard) => Promise<void>;
	onOpenSearch: () => void;
	onMessagesLoaded: () => void;
	/** While true the search bar (passed as children) takes over the row. */
	searchOpen: boolean;
	children?: JSX.Element;
}


export function TopBar(props: TopBarProps) {
	const [showStats, setShowStats] = createSignal(false);
	/** Opening the dropdown forces a recompute: the tracking below misses edits to older messages. */
	const [statsNonce, setStatsNonce] = createSignal(0);
	const [statsPosition, setStatsPosition] = createSignal<Record<string, string>>({});
	let statsBadgeRef!: HTMLButtonElement;

	function updateStatsPosition() {
		const badge = statsBadgeRef;
		if (!badge) return;
		const rect = badge.getBoundingClientRect();
		setStatsPosition({
			top: `${rect.bottom + 6}px`,
			right: `${window.innerWidth - rect.right}px`,
			'min-width': '220px',
		});
	}

	createEffect(() => {
		if (showStats()) {
			setStatsNonce(n => n + 1);
			updateStatsPosition();
		}
	});

	createEffect(() => {
		if (!showStats()) return;
		function handleDocClick(e: MouseEvent) {
			const target = e.target as Node;
			const dropdown = document.querySelector('.chatStatsDropdown');
			if (!statsBadgeRef?.contains(target) && !dropdown?.contains(target)) {
				setShowStats(false);
			}
		}
		document.addEventListener('mousedown', handleDocClick);
		onCleanup(() => document.removeEventListener('mousedown', handleDocClick));
	});

	// Scanning the store proxy would create a signal node per property of every message
	// (~25k on a 4k-message chat: ~60ms a run, plus a rerun on every usage write during
	// streaming). Track only the array's shape and the streaming tail, then scan raw data.
	const stats = createMemo(() => {
		statsNonce();
		const msgs = props.messages;
		void msgs[msgs.length - 1]?.usage;
		return computeChatStats(unwrap(msgs) as ChatMessage[]);
	});

	function omitRuntimeMessageFields(key: string, value: unknown) {
		return key === '_dbId' ? undefined : value;
	}

	/** Exports are self-contained: attachment ids become inline data URLs. The draft stays behind, its attachments aren't inlined. */
	async function serializeChat(messages: ChatMessage[], fullMeta?: ChatMeta) {
		const { draft: _draft, ...meta } = fullMeta ?? {};
		messages = structuredClone(unwrap(messages));
		await inlineAttachments(messages);
		try {
			const envelope = fullMeta ? { ...meta, messages } : messages;
			return JSON.stringify(envelope, omitRuntimeMessageFields, 2);
		} catch (err) {
			console.error('Failed to serialize, attempting clean copy:', err);

			const cleanMessages = unwrap(messages).map((msg: any) => {
				const cleanMsg: any = {};

				for (const key in msg)
					if (key !== '_dbId' && Object.prototype.hasOwnProperty.call(msg, key))
						cleanMsg[key] = msg[key];

				return cleanMsg;
			});

			const envelope = fullMeta ? { ...meta, messages: cleanMessages } : cleanMessages;
			return JSON.stringify(envelope, omitRuntimeMessageFields, 2)
		}
	}

	async function clearChat() {
		if (await confirmDialog("Are you sure you want to clear the chat? This will delete all messages and cannot be undone. Please export before proceeding.")) {
			props.setMessages(reconcile([]));
			saveMessages([]);
			props.applyChatMeta({}); // reset per-chat state (loreId, etc.)
		}
	}

	// NOTE: export logic is mirrored in export_chat.ts (CLI). Keep in sync when changing formats or slice behaviour.
	async function exportMessages(format: 'json' | 'markdown', range: 'full' | 'fromCut', toolCalls?: 'preview' | 'full') {
		const cutIndex = props.chat.cut;
		const messagesToExport = range === 'fromCut' && cutIndex >= 0 && cutIndex < props.messages.length
			? props.messages.slice(cutIndex + 1) // summarization -- first message is always background
			: props.messages;

		if (format === 'markdown') {
			const messages = structuredClone(unwrap(messagesToExport));
			await inlineAttachments(messages);
			const content = messagesToMarkdown(messages, toolCalls);
			saveFileDialog(content, "conv_md.md", [
				{ description: 'Markdown files', extensions: ['.md'] },
			], true);
		} else {
			const meta = props.getChatMeta();
			if (range === 'fromCut') meta.cut = -1;
			saveFileDialog(await serializeChat(messagesToExport, meta), "conv_json.json", [
				{ description: 'JSON files', extensions: ['.json'] },
			], true);
		}
	}

	const chatAutosave = createAutosave<{ messages: ChatMessage[], meta?: ChatMeta }>(
		() => ({ messages: props.messages as ChatMessage[], meta: props.getChatMeta() }),
		'chat_autosave.json',
		'JSON files',
		'application/json',
		'.json',
		25000,
		(data) => serializeChat(data.messages, data.meta),
		(content) => {
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) return { messages: parsed };
			const { messages, ...meta } = parsed;
			return { messages, meta };
		},
		error => console.error('Failed to autosave messages:', error)
	);

	async function setupAutoSave() {
		try {
			await chatAutosave.setup();

			// Load from file if messages are empty
			if (props.messages.length === 0) {
				const loaded = await chatAutosave.load();
				if (loaded?.messages?.length) {
					await ingestAttachments(loaded.messages);
					props.setMessages(loaded.messages.map(normalizeMessage));
					props.onMessagesLoaded();
					if (loaded.meta) props.applyChatMeta(loaded.meta);
				}
			}
		} catch (error) {
			if ((error as any).name !== 'AbortError') {
				console.error('Failed to setup autosave:', error);
				props.setError('Autosave setup failed: ' + (error instanceof Error ? error.message : String(error)));
			}
		}
	}

	function stopAutoSave() {
		chatAutosave.stop();
	}

	return (
		<div class='toprow'>
			<button class='slim-but' style="align-self:stretch;border-radius: 0; margin: 0"
				title={props.sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
				onClick={() => props.setSidebarOpen(!props.sidebarOpen)}
			>
				<TbOutlineLayoutSidebar size={20} />
			</button>
			<Show when={!props.searchOpen} fallback={props.children}>
			<ModelPicker
				hotkey
				provider={props.chat.provider}
				model={props.chat.model}
				onChange={(provider, model) => props.setChat({ provider, model })}
				providers={props.providers}
			/>
			<span class='expand' style='margin-left: auto;'>
				<button class='searchMorph' title='Search chat (Ctrl+F)' onClick={props.onOpenSearch}><TbOutlineSearch size={16} /></button>
				<Show when={!isTauri}>
					<button title='Clear all messages' class='danger' onClick={clearChat}><TbOutlineClearAll size={16} /></button>
				</Show>
				<ExportMenu exportMessages={exportMessages} />
				<Show when={!isTauri}>
					<button title={chatAutosave.isActive() ? 'Stop autosave' : 'Autosave chat to file'}
						onClick={() => chatAutosave.isActive() ? stopAutoSave() : setupAutoSave()}>
						{chatAutosave.isActive() ? <TbOutlineFileOff size={20}/> : <TbOutlineDeviceFloppy size={22}/>}
					</button>
				</Show>

				<button
					ref={statsBadgeRef}
					class="chatStatsBadge"
					title="Chat statistics"
					onClick={() => setShowStats(v => !v)}
				>
					<TbOutlineCoins size={16} />
					<span>${stats().all.totalCost.toFixed(4)}</span>
				</button>

				<Show when={showStats()}>
					<Portal mount={document.body}>
						<div class="chatStatsDropdown" style={statsPosition()}>

							<div class="chatStatsRow">
								<span>Cost (all versions)</span>
								<strong>${stats().all.totalCost.toFixed(4)}</strong>
							</div>
							<div class="chatStatsRow">
								<span>Cost (current)</span>
								<strong>${stats().current.totalCost.toFixed(4)}</strong>
							</div>
							<div class="chatStatsSub">
								{stats().current.pricedRequests} / {stats().totalRequests} responses priced
								({stats().totalRequests > 0 ? Math.round(stats().current.pricedRequests / stats().totalRequests * 100) : 0}%)
							</div>

							<div class="chatStatsRow">
								<span>Messages</span>
								<strong>{stats().totalMessages}</strong>
							</div>
							<div class="chatStatsSub">{stats().totalVersions} total versions</div>

							<div class="chatStatsRow">
								<span>Tokens (current)</span>
								<strong>{(stats().current.promptTokens + stats().current.messageTokens + stats().current.reasoningTokens).toLocaleString()}</strong>
							</div>
							<div class="chatStatsSub">
								P {stats().current.promptTokens.toLocaleString()} ·
								M {stats().current.messageTokens.toLocaleString()} ·
								R {stats().current.reasoningTokens.toLocaleString()}
							</div>
							<div class="chatStatsSub">
								from {stats().current.tokenRequests} / {stats().totalRequests} responses
							</div>

							<Show when={stats().all.cacheRequests > 0}>
								<div class="chatStatsRow">
									<span>Cache hit rate</span>
									<strong>{Math.round(stats().all.cachedTokens / (stats().all.cachePromptTokens || 1) * 100)}%</strong>
								</div>
								<div class="chatStatsSub">
									cached {stats().all.cachedTokens.toLocaleString()} of {stats().all.cachePromptTokens.toLocaleString()} prompt tokens (all versions)
								</div>
								<Show when={stats().current.cacheRequests > 0 && stats().current.cachePromptTokens < stats().all.cachePromptTokens}>
									<div class="chatStatsSub">
										current versions: {Math.round(stats().current.cachedTokens / (stats().current.cachePromptTokens || 1) * 100)}%
									</div>
								</Show>
								<div class="chatStatsSub">
									{stats().all.cacheRequests} / {stats().totalRequests} responses report caching
								</div>
							</Show>

							<Show when={stats().models.length > 0}>
								<div class="chatStatsDivider" />
									<div class="chatStatsSub" style={{ 'margin-bottom': '6px' }}>Models used</div>
									<div class="chatStatsPills">
										<For each={stats().models}>
											{m => <span class="chatStatsPill">{m}</span>}
										</For>
									</div>
							</Show>
						</div>
					</Portal>
				</Show>
				<CacheIndicator chatId={props.chatId} />
				<ImportMessages importChat={props.importChat} importCard={props.importCard} setError={props.setError} setInfo={props.setInfo} />
			</span>
			</Show>
		</div>
	);
}

const VERDICT_LABEL: Record<CacheVerdict, string> = {
	hit: 'hit',
	partial: 'cache hit',
	miss: 'miss',
	unknown: 'unreported',
	none: 'n/a',
};

function fmtAgo(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''} ago`;
}

function cachePercent(check: CacheCheck): number | null {
	if (check.cached === null || check.promptTokens === null || check.promptTokens <= 0) return null;
	return Math.round(check.cached / check.promptTokens * 100);
}

function expectedCachePercent(check: CacheCheck): number | null {
	if (check.expected === null || check.estPrompt <= 0) return null;
	return Math.round(check.expected / check.estPrompt * 100);
}

function recentCacheDetails(check: CacheCheck): string {
	if (check.cached === null) return '';
	const actual = cachePercent(check);
	const expected = expectedCachePercent(check);
	return `${check.cached.toLocaleString()} · ${actual === null ? '?' : `${actual}%`}${expected === null ? '' : ` / ${expected}%`}`;
}

function CacheIndicator(props: { chatId: string }) {
	const [open, setOpen] = createSignal(false);
	const [position, setPosition] = createSignal<Record<string, string>>({});
	const [now, setNow] = createSignal(Date.now());
	let dotRef!: HTMLButtonElement;

	const lastCheck = () => latestCheck(props.chatId);
	const history = () => checkHistory()[props.chatId] ?? [];

	createEffect(() => {
		if (!open()) return;
		setNow(Date.now());
		const rect = dotRef.getBoundingClientRect();
		setPosition({
			top: `${rect.bottom + 6}px`,
			right: `${window.innerWidth - rect.right}px`,
			'min-width': '240px',
		});
		const ticker = setInterval(() => setNow(Date.now()), 5000);

		function handleDocClick(e: MouseEvent) {
			const target = e.target as Node;
			const dropdown = document.querySelector('.cacheDropdown');
			if (!dotRef.contains(target) && !dropdown?.contains(target)) setOpen(false);
		}
		document.addEventListener('mousedown', handleDocClick);
		onCleanup(() => {
			document.removeEventListener('mousedown', handleDocClick);
			clearInterval(ticker);
		});
	});

	const Card = (props: { children: JSX.Element }) => (
		<>
			<button ref={dotRef} class={`cacheDot ${lastCheck()?.verdict ?? 'unknown'}`} title={lastCheck() ? `Prompt cache: ${VERDICT_LABEL[lastCheck()!.verdict]}` : 'Prompt cache: no data yet'} onClick={() => setOpen(v => !v)} />
			<Show when={open()}>
				<Portal mount={document.body}>
					{props.children}
				</Portal>
			</Show>
		</>
	);

	return (
		<Card>
			<div class="chatStatsDropdown cacheDropdown" style={position()}>
				<Show when={lastCheck()} fallback={<div class="chatStatsSub">no cache data for this chat yet</div>}>
					<div class="chatStatsSub">{fmtAgo(now() - lastCheck()!.time)} · {lastCheck()!.model}</div>
					<Show when={lastCheck()!.cached !== null} fallback={<div class="chatStatsSub">provider did not report cached tokens</div>}>
						<div class="chatStatsRow">
							<span>Cached</span>
							<span>
								{lastCheck()!.cached!.toLocaleString()} / {lastCheck()!.promptTokens?.toLocaleString() ?? '?'}
								{cachePercent(lastCheck()!) !== null ? ` · ${cachePercent(lastCheck()!)}%` : ''}
							</span>
						</div>
					</Show>

					<Show when={lastCheck()!.expected !== null && lastCheck()!.expected! > 0}>
						<div class="chatStatsRow">
							<span>Expected</span>
							<span>
								{expectedCachePercent(lastCheck()!) ?? '?'}%
								{lastCheck()!.ratio !== null ? ` · ${Math.round(lastCheck()!.ratio! * 100)}% met` : ''}
							</span>
						</div>
					</Show>

					<Show when={lastCheck()!.expectReason}>
						<div class="chatStatsSub">{lastCheck()!.expectReason}</div>
					</Show>
					<Show when={lastCheck()!.divergedAt !== null && lastCheck()!.divergedAt! > 0}>
						<div class="chatStatsRow">
							<span>Prefix</span>
							<span>first {lastCheck()!.divergedAt} request messages</span>
						</div>
					</Show>
					<Show when={lastCheck()!.ttlMs !== null}>
						<div class="chatStatsRow">
							<span>Expires</span>
							<span>
								{now() - lastCheck()!.time < lastCheck()!.ttlMs!
									? `~${Math.ceil((lastCheck()!.ttlMs! - (now() - lastCheck()!.time)) / 60000)}m`
									: 'expired'}
							</span>
						</div>
					</Show>
				</Show>
				<Show when={history().length > 0}>
					<div class="chatStatsDivider" />
					<div style={{ 'margin-bottom': '4px' }}>Recent</div>
					<For each={[...history()].reverse()}>
					{c => (
						<div class="cacheHistoryRow">
							<span>{fmtAgo(now() - c.time)} · {VERDICT_LABEL[c.verdict]}</span>
							<span>{recentCacheDetails(c)}</span>
						</div>
					)}
					</For>
				</Show>
			</div>
		</Card>
	);
}

function ExportMenu(props: { exportMessages: (format: 'json' | 'markdown', range: 'full' | 'fromCut', toolCalls?: 'preview' | 'full') => void }) {
	const [open, setOpen] = createSignal(false);
	const [position, setPosition] = createSignal<Record<string, string>>({});
	const [format, setFormat] = createSignal<'markdown' | 'json'>('markdown');
	const [range, setRange] = createSignal<'full' | 'fromCut'>('full');
	const [tools, setTools] = createSignal<'none' | 'preview' | 'full'>('none');
	let buttonRef!: HTMLButtonElement;

	createEffect(() => {
		if (!open()) return;
		const rect = buttonRef.getBoundingClientRect();
		setPosition({
			top: `${rect.bottom + 6}px`,
			right: `${window.innerWidth - rect.right}px`,
		});

		function handleDocClick(e: MouseEvent) {
			const target = e.target as Node;
			const dropdown = document.querySelector('.exportMenuDropdown');
			if (!buttonRef.contains(target) && !dropdown?.contains(target)) setOpen(false);
		}
		document.addEventListener('mousedown', handleDocClick);
		onCleanup(() => document.removeEventListener('mousedown', handleDocClick));
	});

	return (
		<>
			<button ref={buttonRef} title='Export chat' onClick={() => setOpen(v => !v)}><TbOutlineDownload size={18} /></button>
			<Show when={open()}>
				<Portal mount={document.body}>
					<div class="chatStatsDropdown exportMenuDropdown" style={position()}>
						<div class="exportMenuRow">
							<span>Format</span>
							<TSeg options={{ markdown: 'MD', json: 'JSON' }} selected={format()} setSelected={k => setFormat(k as any)} tooltips={{markdown: 'export to human-readable markdown', json: 'export to structured json with all metadata'}}/>
						</div>
						<div class="exportMenuRow">
							<span>Range</span>
							<TSeg options={{ full: 'Full', fromCut: 'From cut' }} selected={range()} setSelected={k => setRange(k as any)} tooltips={{full: 'Entire chat', fromCut: 'Only since the cut point'}}/>
						</div>
						<Show when={format() === 'markdown'}>
							<div class="exportMenuRow">
								<span>Tools</span>
								<TSeg options={{ none: 'None', preview: 'Preview', full: 'Full' }} selected={tools()} setSelected={k => setTools(k as any)} tooltips={{none: 'No tool calls/results', preview: 'Brief preview of tool calls/results', full: 'full tool calls/results'}}/>
							</div>
						</Show>
						<button class="dotted-button" style="margin-top: 8px" onClick={() => {
							props.exportMessages(format(), range(), format() === 'markdown' && tools() !== 'none' ? tools() as 'preview' | 'full' : undefined);
							setOpen(false);
						}}>Export</button>
					</div>
				</Portal>
			</Show>
		</>
	);
}

function ImportMessages(props: { importChat: (messages: ChatMessage[], meta?: Partial<ChatMeta>) => Promise<boolean>, importCard: (card: STCard) => Promise<void>, setError: Setter<string | null>, setInfo: Setter<string | null> }) {
	async function handleFileSelect(e: Event) {
		try {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file) throw new Error("Failed to select file");

			if (/\.png$/i.test(file.name)) {
				await props.importCard(parseSTCard(cardFromPng(new Uint8Array(await file.arrayBuffer()))));
				(e.target as HTMLInputElement).value = '';
				return;
			}

			const text = await file.text();

			if (/\.jsonl$/i.test(file.name)) {
				const { messages, meta } = parseSTChat(text);
				if (await props.importChat(messages, meta))
					props.setInfo('Imported a SillyTavern chat. This import is not fully tested yet, so please check the result.');
				(e.target as HTMLInputElement).value = '';
				return;
			}

			const parsed = JSON.parse(text);

			if (isSTCard(parsed)) {
				await props.importCard(parseSTCard(parsed));
				(e.target as HTMLInputElement).value = '';
				return;
			}

			let rawMessages: any[];
			let chatMeta: Partial<ChatMeta> | undefined;

			if (Array.isArray(parsed)) {
				rawMessages = parsed;
			} else if (parsed.messages && Array.isArray(parsed.messages)) {
				const { messages, ...meta } = parsed;
				rawMessages = messages;
				chatMeta = meta;
			} else {
				throw new Error("Invalid format: expected an array of messages or a chat envelope");
			}

			if (rawMessages.length === 0) throw new Error("File contains no messages");

			const validRoles = ['user', 'assistant', 'system', 'tool'];
			if (!rawMessages.every((m: any) => m && typeof m === 'object' && validRoles.includes(m.role) && (typeof m.content === 'string' || Array.isArray(m.content))))
				throw new Error("Invalid format: messages must have a valid role and content");
			const importedMessages = rawMessages as ChatMessage[];

			// Convert old format to new format and normalize
			const convertedMessages = migrateToolResults(importedMessages.map(msg => {
				const msgForImport = { ...msg };
				delete msgForImport._dbId;

				const converted = typeof msgForImport.content === 'string'
					? {
						...msgForImport,
						content: [msgForImport.content],
						thinking: msgForImport.thinking && typeof msgForImport.thinking === 'string' ? [msgForImport.thinking] : msgForImport.thinking,
					}
					: msgForImport;
				return normalizeMessage(converted);
			}));

			// Inlined images from the export go back into the attachment store
			await ingestAttachments(convertedMessages);

			await props.importChat(convertedMessages, chatMeta);

			// Reset the input value to allow selecting the same file again
			(e.target as HTMLInputElement).value = '';

		} catch (error) {
			props.setError(`Failed import: ` + (error instanceof Error ? error.message : String(error)));
			console.error("Failed to import messages:", error);
		}
	}

	return (
		<label class="fake-but" title="Import a chat (JSON, or a SillyTavern .jsonl) or a SillyTavern character card (.png, .json)" style='cursor: pointer;'>
			<TbOutlineUpload size={16} />
			<input
				type="file" accept=".json,.jsonl,.png"
				onchange={handleFileSelect}
				style='display: none;'
			/>
		</label>
	);
}


