import { Setter, For, Show, createEffect, createSignal, createMemo, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { SetStoreFunction, reconcile, unwrap } from 'solid-js/store';
import type { ChatMessage, ChatMeta, Provider, ProviderConfig } from './helpers/types';
import { computeChatStats } from './helpers/messages';
import { messagesToMarkdown } from './helpers/transcript';
import { createAutosave, normalizeMessage, migrateToolResults, stagedSetMessages, saveMessages } from './helpers/storage';
import { confirmDialog, isTauri, saveFileDialog } from './helpers/platform';
import { ModelPicker } from './helpers/ModelPicker';
import { TSeg } from './helpers/Comps';
import { inlineAttachments, ingestAttachments } from './helpers/attachments';
import { TbOutlineLayoutSidebar, TbOutlineUpload, TbOutlineClearAll, TbOutlineDeviceFloppy, TbOutlineFileOff, TbOutlineCoins, TbOutlineDownload, TbOutlineSearch } from 'solid-icons/tb';

interface TopBarProps {
	model: string;
	setModel: Setter<string>;
	setMessages: SetStoreFunction<ChatMessage[]>;
	messages: ChatMessage[];
	provider: Provider;
	setProvider: Setter<Provider>;
	setError: Setter<string | null>;
	cut: number;
	providers: Record<Provider, ProviderConfig>;
	sidebarOpen: boolean;
	setSidebarOpen: Setter<boolean>;
	getChatMeta: () => ChatMeta;
	applyChatMeta: (meta: Partial<ChatMeta>) => void;
	createChat?: ((folder?: string) => Promise<void>) | undefined;
	onOpenSearch: () => void;
	/** While true the search bar (passed as children) takes over the row. */
	searchOpen: boolean;
	children?: JSX.Element;
}


export function TopBar(props: TopBarProps) {
	const [showStats, setShowStats] = createSignal(false);
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
		if (showStats()) updateStatsPosition();
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

	const stats = createMemo(() => computeChatStats(props.messages as ChatMessage[]));

	function omitRuntimeMessageFields(key: string, value: unknown) {
		return key === '_dbId' ? undefined : value;
	}

	/** Exports are self-contained: attachment ids become inline data URLs. */
	async function serializeChat(messages: ChatMessage[], meta?: ChatMeta) {
		messages = structuredClone(unwrap(messages));
		await inlineAttachments(messages);
		try {
			const envelope = meta ? { ...meta, messages } : messages;
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

			const envelope = meta ? { ...meta, messages: cleanMessages } : cleanMessages;
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
		const cutIndex = props.cut;
		const messagesToExport = range === 'fromCut' && cutIndex >= 0 && cutIndex < props.messages.length
			? props.messages.slice(cutIndex + 1) // summarization -- first message is always background
			: props.messages;

		if (format === 'markdown') {
			const messages = structuredClone(unwrap(messagesToExport));
			await inlineAttachments(messages);
			const content = messagesToMarkdown(messages, toolCalls);
			saveFileDialog(content, "conv_md.md", [
				{ description: 'Markdown files', extensions: ['.md'] },
			]);
		} else {
			const meta = props.getChatMeta();
			if (range === 'fromCut') meta.cut = -1;
			saveFileDialog(await serializeChat(messagesToExport, meta), "conv_json.json", [
				{ description: 'JSON files', extensions: ['.json'] },
			]);
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
				provider={props.provider}
				setProvider={props.setProvider}
				model={props.model}
				setModel={props.setModel}
				providers={props.providers}
				setError={props.setError}
			/>
			<span class='expand' style='margin-left: auto;'>
				<button class='searchMorph' title='Search chat (Ctrl+F)' onClick={props.onOpenSearch}><TbOutlineSearch size={18} /></button>
				<Show when={!isTauri}>
					<button title='Clear all messages' class='danger' onClick={clearChat}><TbOutlineClearAll size={20} /></button>
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
					<TbOutlineCoins size={18} />
					<span>${stats().all.totalCost.toFixed(4)}</span>
				</button>

				<Show when={showStats()}>
					<Portal mount={document.body}>
						<div class="chatStatsDropdown" style={statsPosition()}>
							<div class="chatStatsSection">
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
							</div>
							<div class="chatStatsSection">
								<div class="chatStatsRow">
									<span>Messages</span>
									<strong>{stats().totalMessages}</strong>
								</div>
								<div class="chatStatsSub">{stats().totalVersions} total versions</div>
							</div>
							<div class="chatStatsSection">
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
							</div>
							<Show when={stats().models.length > 0}>
								<div class="chatStatsDivider" />
								<div class="chatStatsSection">
									<div class="chatStatsSub" style={{ 'margin-bottom': '6px' }}>Models used</div>
									<div class="chatStatsPills">
										<For each={stats().models}>
											{m => <span class="chatStatsPill">{m}</span>}
										</For>
									</div>
								</div>
							</Show>
						</div>
					</Portal>
				</Show>
				<ImportMessages setMessages={props.setMessages} setError={props.setError} applyChatMeta={props.applyChatMeta} createChat={props.createChat} messages={props.messages}/>
			</span>
			</Show>
		</div>
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
			<button ref={buttonRef} title='Export chat' onClick={() => setOpen(v => !v)}><TbOutlineDownload size={20} /></button>
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
						<button class="exportMenuAction" onClick={() => {
							props.exportMessages(format(), range(), format() === 'markdown' && tools() !== 'none' ? tools() as 'preview' | 'full' : undefined);
							setOpen(false);
						}}>Export</button>
					</div>
				</Portal>
			</Show>
		</>
	);
}

function ImportMessages(props: { messages: ChatMessage[], setMessages: SetStoreFunction<ChatMessage[]>, setError: Setter<string | null>, applyChatMeta: (meta: Partial<ChatMeta>) => void, createChat?: ((folder?: string) => Promise<void>) | undefined }) {
	async function handleFileSelect(e: Event) {
		try {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file) throw new Error("Failed to select file");

			const text = await file.text();

			const parsed = JSON.parse(text);

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

			// In Tauri mode, create a new chat for the import
			if (isTauri && props.createChat && props.messages.length > 0)
				await props.createChat();

			stagedSetMessages(convertedMessages, props.setMessages, () => saveMessages(convertedMessages));

			if (chatMeta) props.applyChatMeta(chatMeta);

			// Reset the input value to allow selecting the same file again
			(e.target as HTMLInputElement).value = '';

		} catch (error) {
			props.setError(`Failed import: ` + (error instanceof Error ? error.message : String(error)));
			console.error("Failed to import messages:", error);
		}
	}

	return (
		<label class="fake-but" title="Import messages" style='cursor: pointer;'>
			<TbOutlineUpload size={20} />
			<input
				type="file" accept=".json"
				onchange={handleFileSelect}
				style='display: none;'
			/>
		</label>
	);
}


