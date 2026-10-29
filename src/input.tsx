import {createEffect, createMemo, createSignal, onCleanup, Setter, Show, mapArray, For, onMount, on} from 'solid-js';
import {SetStoreFunction, createStore} from 'solid-js/store'
import type {ChatMessage, FileAttachment, PreserveReasoning, Role, Prompt, ToolMode} from './helpers/types'
import {TSeg} from './helpers/Comps'
import { TbOutlineSend, TbOutlinePlaylistAdd, TbOutlinePhotoPlus, TbOutlineToolsOff } from 'solid-icons/tb'
import { BsStopCircle } from 'solid-icons/bs'
import { LoreEntry } from './helpers/lore'
import { isTauri, listFolderFiles } from './helpers/platform'
import type { Backend } from './helpers/backend'
import { sentTools } from './helpers/tools'
import { msgVars } from './helpers/Extras'
import { messageChars } from './helpers/messages'
import { reasoningFromIndex } from './helpers/buildRequest'
import { estTokens, estTokensFromLength, estImageChars } from './helpers/tokens'
import { attachFromTransfer, attachImage, imageDims } from './helpers/attachments'
import { ChatImage } from './helpers/Comps'
import { modelMatchesTrigger } from './helpers/PromptManager'
import type { StreamingResult } from './helpers/streaming'
import type { QueuedSend } from './helpers/session'
import type { ChatState } from './helpers/chatState'
import Fuse from 'fuse.js';
import { completeImageReference, imageCompletionAt, handleLineClipboard, typeHelper, tabComplete } from './helpers/typing';
import { imageSource, listImagePaths } from './helpers/imageFolder';




interface InputArgs {
	chat: ChatState;
	setChat: SetStoreFunction<ChatState>;
	 sendMessage: (redo: number | undefined) => Promise<StreamingResult | undefined>;
	 sendAsideMessage: (content: string) => void;
	 compactChat: () => void;
	 sendRewriteMessage: (content: string) => void;
	 isLoading: boolean;
	 toolsRunning: boolean;
	 queuedSend: QueuedSend | null;
	 queueSend: (q: QueuedSend | null) => void;
	 abortAllStreams: () => void;
	 setMessages: SetStoreFunction<ChatMessage[]>;
	 /** Announce an appended user message so it can animate in and pull the list down. */
	 onUserAppend: (index: number) => void;
	 messages: ChatMessage[];
	prompts: Prompt[];
	lore: LoreEntry[];
	chatId?: string;
	/** Where @-mentioned files are listed from and read. Drag-and-drop stays local. */
	backend: Backend;
	tools?: Record<string, boolean> | undefined;
	toolMode: ToolMode;
	preserveReasoning?: PreserveReasoning | undefined;
	setError: Setter<string | null>;
}
export function MInput(props : InputArgs) {
	interface DropdownItem {
		type: 'lore' | 'file' | 'image';
		name: string;
		description?: string;
		loreEntry?: LoreEntry;
		filePath?: string;
	}

	const [dropdown, setDropdown] = createStore({
		show: false,
		mode: 'mention' as 'mention' | 'image',
		items: [] as DropdownItem[],
		selectedIndex: -1,
		queryStart: -1,
		queryEnd: -1
	});

	const AT_RE = /(?<!@)@(?!@)(?:ref)?([^\s]*)$/;
	const FILES_STALE_MS = 10_000;
	const [folderFiles, setFolderFiles] = createSignal<string[] | null>(null);
	const cacheKey = () => `${props.backend.id}:${props.chat.chatFolder}`;
	let folderFilesCachedKey: string | null = null;
	let folderFilesFetchedAt = 0;
	let folderFilesFetching = false;
	let fileFuse: Fuse<{ path: string; name: string }> | null = null;
	let dropdownRequest = 0;
	let dropdownText = '';
	let imageFiles: string[] | null = null;
	let imageFuse: Fuse<{ path: string; name: string }> | null = null;

	function closeDropdown() {
		dropdownRequest++;
		setDropdown('show', false);
	}

	createEffect(on(imageSource, () => {
		imageFiles = null;
		imageFuse = null;
		if (dropdown.mode === 'image') closeDropdown();
	}));

	createEffect(on(() => props.chat.draft.text, text => {
		if (text !== dropdownText) closeDropdown();
	}));

	const loreFuse = createMemo(() => new Fuse(props.lore, {
		keys: [
			{ name: 'name', weight: 2 },
			{ name: 'description', weight: 0.5 }
		],
		ignoreLocation: true,
		threshold: 0.3
	}));

	function refreshFolderFiles() {
		if (folderFilesFetching || !isTauri || !props.chat.chatFolder) return;
		folderFilesFetching = true;
		const key = cacheKey();
		listFolderFiles(props.chat.chatFolder, props.backend).then(files => {
			if (key !== cacheKey()) return;
			setFolderFiles(files);
			folderFilesFetchedAt = Date.now();
			fileFuse = new Fuse(files.map(path => ({
				path,
				name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
			})), {
				keys: [
					{ name: 'name', weight: 3 },
					{ name: 'path', weight: 1 }
				],
				threshold: 0.3,
				ignoreLocation: true
			});
			if (dropdown.show && dropdown.mode === 'mention') refreshDropdownFromInput();
		}).finally(() => { folderFilesFetching = false; });
	}

	function buildImageItems(query: string, files: string[]): DropdownItem[] {
		if (imageFiles !== files) {
			imageFiles = files;
			imageFuse = new Fuse(files.map(path => ({ path, name: path.slice(path.lastIndexOf('/') + 1) })), {
				keys: [{ name: 'name', weight: 3 }, { name: 'path', weight: 1 }],
				threshold: 0.3,
				ignoreLocation: true,
			});
		}
		const paths = query ? imageFuse!.search(query, { limit: 8 }).map(r => r.item.path) : files.slice(0, 8);
		return paths.map(name => ({ type: 'image', name }));
	}

	function refreshDropdownForCaret() {
		if (dropdown.show || imageCompletionAt(props.chat.draft.text, msgbox.selectionStart)) refreshDropdownFromInput();
	}

	function refreshDropdownFromInput() {
		const request = ++dropdownRequest;
		const loc = msgbox.selectionStart;
		if (loc !== msgbox.selectionEnd) return closeDropdown();
		const text = props.chat.draft.text;
		dropdownText = text;
		const image = imageCompletionAt(text, loc);
		if (image) {
			const source = imageSource();
			if (!source) return closeDropdown();
			const items = imageFiles ? buildImageItems(image.query, imageFiles) : [];
			setDropdown({ show: true, mode: 'image', items, selectedIndex: items.length ? 0 : -1 });
			listImagePaths().then(files => {
				if (request !== dropdownRequest || imageSource() !== source || props.chat.draft.text !== text
					|| msgbox.selectionStart !== loc || msgbox.selectionEnd !== loc || document.activeElement !== msgbox) return;
				const selected = dropdown.items[dropdown.selectedIndex]?.name;
				const items = buildImageItems(image.query, files);
				const selectedIndex = items.findIndex(item => item.name === selected);
				setDropdown({ items, selectedIndex: selectedIndex >= 0 ? selectedIndex : items.length ? 0 : -1 });
			});
			return;
		}

		const before = text.slice(0, loc);
		const atMatch = before.match(AT_RE);
		if (!atMatch) return closeDropdown();
		const items = buildDropdownItems(atMatch[1] || '');
		setDropdown({
			show: true,
			mode: 'mention',
			items,
			selectedIndex: items.length > 0 ? 0 : -1,
			queryStart: before.lastIndexOf('@'),
			queryEnd: loc
		});
		if (!folderFiles() || Date.now() - folderFilesFetchedAt > FILES_STALE_MS) refreshFolderFiles();
	}

	// Reads in flight. Submitting awaits them, so a just-picked file is never left behind
	// and the send button never goes dead: its chip is already on screen.
	const [pending, setPending] = createSignal<{ path: string; task: Promise<void> }[]>([]);
	const knownFiles = createMemo(() => new Set(folderFiles() ?? []));

	/** Paths the message text names with @, limited to files in the chat folder and files already attached (e.g. from the sidebar's skill list). */
	const mentions = createMemo(() => {
		const known = knownFiles();
		const attached = new Set(props.chat.draft.files.map(file => file.path));
		const found: string[] = [];
		for (const match of props.chat.draft.text.matchAll(MENTION_RE)) {
			const path = match[1] || match[2];
			if (path && (known.has(path) || attached.has(path)) && !found.includes(path)) found.push(path);
		}
		return found;
	});

	/**
	 * One chip per mention. Attaching is a state of the mention, not a separate thing, so a
	 * chip can be sent with the file or without it — and deleting the @ref drops both.
	 */
	const fileChips = createMemo(() => {
		const attached = new Map(props.chat.draft.files.map(file => [file.path, file]));
		return mentions().map(path => ({
			path,
			file: attached.get(path),
			// Files from outside the folder (the sidebar's skills) aren't mentions without their attachment
			toggleable: knownFiles().has(path),
			pending: pending().some(read => read.path === path),
		}));
	});

	createEffect(() => {
		const named = new Set(mentions());
		if (props.chat.draft.files.some(file => !named.has(file.path)))
			props.setChat('draft', 'files', files => files.filter(file => named.has(file.path)));
	});

	function attachFilePath(path: string) {
		if (props.chat.draft.files.some(file => file.path === path) || pending().some(read => read.path === path)) return;
		const task = (async () => {
			const { attachFile } = await import('./helpers/attachments');
			const attached = await attachFile(path, props.chat.chatFolder || '', props.backend);
			if ('file' in attached) props.setChat('draft', 'files', files => [...files, attached.file]);
			else props.setChat('draft', 'images', images => [...images, ...attached.images]);
		})()
			.catch(err => { props.setError('Failed to attach file: ' + (err instanceof Error ? err.message : String(err))); })
			.finally(() => setPending(prev => prev.filter(read => read.path !== path)));
		setPending(prev => [...prev, { path, task }]);
	}

	function toggleAttachment(path: string) {
		if (props.chat.draft.files.some(file => file.path === path))
			props.setChat('draft', 'files', files => files.filter(file => file.path !== path));
		else
			attachFilePath(path);
	}

	function chipMeta(chip: { file: FileAttachment | undefined; pending: boolean }): string {
		if (chip.pending) return 'reading\u2026';
		if (!chip.file) return 'not attached';
		const tokens = `~${estTokensFromLength(chip.file.chars, props.chat.model)} tok`;
		return chip.file.truncated ? `${tokens} \u00b7 truncated` : tokens;
	}

	// Dimension-aware image cost, falling back to IMAGE_CHARS while dims are unknown.
	const imageChars = (refs: string[] | undefined) =>
		(refs ?? []).reduce((sum, ref) => sum + estImageChars(imageDims(ref), props.chat.model), 0);

	// Reasoning is tracked apart from the rest: which messages carry it depends on
	// the preserve mode and the cut, so it can't be folded into a per-message total.
	const [msgCharTotal, setMsgCharTotal] = createSignal(0);
	const [thinkCharTotal, setThinkCharTotal] = createSignal(0);
	const msgLens: number[] = []; // plain arrays for cut calculation
	const thinkLens: number[] = [];

	const _trackMsgLens = mapArray(() => props.messages, (msg, index) => {
		let prev = 0, prevThink = 0;
		createEffect(() => {
			const i = index();
			const len = messageChars(msg, { imageChars });
			msgLens[i] = len;
			setMsgCharTotal(t => t - prev + len);
			prev = len;

			const think = msg.thinking?.[msg.currentVersionIndex || 0]?.length ?? 0;
			thinkLens[i] = think;
			setThinkCharTotal(t => t - prevThink + think);
			prevThink = think;
		});
		onCleanup(() => {
			setMsgCharTotal(t => t - prev);
			setThinkCharTotal(t => t - prevThink);
		});
		return null;
	});

	// Drive the lazy mapArray
	createEffect(() => { _trackMsgLens(); });

	const cutIndex = () => props.chat.cut < props.messages.length ? Math.max(props.chat.cut, 0) : 0;

	const cutExcluded = createMemo(() => {
		msgCharTotal(); // re-run when any length changes
		const cut = cutIndex();
		if (cut === 0) return 0;
		let sum = 0;
		for (let i = 0; i < cut; i++) sum += msgLens[i] || 0;
		return sum;
	});

	// Mirrors buildRequestMessages: reasoning goes out for post-cut messages, or
	// only the last few of them under 'clipped'.
	const reasoningCharTotal = createMemo(() => {
		const total = thinkCharTotal();
		const cut = cutIndex();
		const len = props.messages.length;
		const from = cut + reasoningFromIndex(props.preserveReasoning, len - cut);
		if (from >= len) return 0;
		if (from === 0) return total;
		let sum = 0;
		for (let i = from; i < len; i++) sum += thinkLens[i] || 0;
		return sum;
	});

	const promptsCharTotal = createMemo(() => {
		let sum = 0;
		for (const p of props.prompts)
			if (p.enabled && modelMatchesTrigger(p.modelTrigger, props.chat.model).matches)
				sum += msgVars(p.content, props.chat.macros, props.chat.model, props.chat.chatFolder, props.chatId).length;
		return sum;
	});

	// JSON length of the tool definitions actually sent (sentTools mirrors streaming.ts filtering).
	const toolsCharTotal = createMemo(() => {
		const sent = sentTools(props.tools, props.backend, props.chat.model, undefined, props.toolMode);
		return sent.length > 0 ? JSON.stringify(sent).length : 0;
	});

	const tokens = () => {
		const inputLen = msgVars(props.chat.draft.text, props.chat.macros, props.chat.model, props.chat.chatFolder, props.chatId).length
			+ props.chat.draft.files.reduce((sum, file) => sum + file.chars, 0);
		return estTokensFromLength(msgCharTotal() - cutExcluded() + reasoningCharTotal() + promptsCharTotal() + toolsCharTotal() + inputLen, props.chat.model);
	};

	function buildDropdownItems(query: string): DropdownItem[] {
		const items: DropdownItem[] = [];

		// Search lore
		if (props.lore.length > 0) {
			if (query) {
				const loreResults = loreFuse().search(query, { limit: 5 }).map(r => r.item);
				for (const entry of loreResults) {
					items.push({ type: 'lore', name: entry.name, description: entry.description, loreEntry: entry });
				}
			} else {
				for (const entry of props.lore.slice(0, 5)) {
					items.push({ type: 'lore', name: entry.name, description: entry.description, loreEntry: entry });
				}
			}
		}

		// Search files in chat folder
		if (isTauri && props.chat.chatFolder) {
			// Update cache if backend or folder changed
			if (folderFilesCachedKey !== cacheKey()) {
				setFolderFiles(null);
				fileFuse = null;
				folderFilesCachedKey = cacheKey();
			}
			const cached = folderFiles();
			if (cached && fileFuse) {
				const fileResults = query
					? fileFuse.search(query, { limit: 8 }).map(r => r.item.path)
					: cached.slice(0, 8);
				for (const filePath of fileResults) {
					// Skip if this file is also in lore results
					if (!items.some(i => i.name === filePath)) {
						items.push({ type: 'file', name: filePath, filePath });
					}
				}
			}
		}

		return items;
	}

	function handleInputChange(event: InputEvent) {
		const target = event.target as HTMLTextAreaElement;

		const loc = target.selectionStart;
		let newValue = target.value;
		if (event.inputType === "insertText")
				 newValue = typeHelper(target.value, loc);
		props.setChat('draft', 'text', newValue);
		target.setSelectionRange(loc, loc);

		refreshDropdownFromInput();
	};

	async function addImages(data: DataTransfer | null) {
		const ids = await attachFromTransfer(data);
		if (ids.length) props.setChat('draft', 'images', prev => [...prev, ...ids]);
	}

	function handlePaste(e: ClipboardEvent) {
		if (!e.clipboardData?.files.length) return;
		e.preventDefault();
		addImages(e.clipboardData);
	}

	function handleDrop(e: DragEvent) {
		if (!e.dataTransfer?.files.length) return;
		e.preventDefault();
		addImages(e.dataTransfer);
	}

	async function pickImages(e: Event) {
		const input = e.target as HTMLInputElement;
		const ids = await Promise.all(Array.from(input.files ?? []).map(attachImage));
		if (ids.length) props.setChat('draft', 'images', prev => [...prev, ...ids]);
		input.value = ''; // allow picking the same file again
	}

	/** Message the current input makes, attachments included. */
	function inputMessage(): ChatMessage {
		const msg: ChatMessage = { role: props.chat.draft.role, content: [msgVars(props.chat.draft.text, props.chat.macros, props.chat.model, props.chat.chatFolder, props.chatId)], currentVersionIndex: 0 };
		if (props.chat.draft.images.length) msg.images = [props.chat.draft.images];
		if (props.chat.draft.files.length) msg.files = [props.chat.draft.files];
		return msg;
	}

	function clearInput() {
		closeDropdown();
		props.setChat('draft', { text: '', images: [], files: [] });
	}

	function addWithoutSending() {
		props.onUserAppend(props.messages.length);
		props.setMessages(props.messages.length, inputMessage());
		clearInput();
		props.setChat('draft', 'role', role => role === 'user' ? 'assistant' : 'user');
	}

	let msgbox!: HTMLTextAreaElement;
	// createEffect(() => {if(!props.isLoading && document.activeElement?.tagName !== 'TEXTAREA') msgbox.focus();});
	onMount(() => { msgbox.focus(); });

	function messageKeybind(e: KeyboardEvent) {
		if (dropdown.show && e.key === 'Escape') {
			e.preventDefault();
			closeDropdown();
			return;
		}
		if (dropdown.show && dropdown.items.length > 0 && !e.ctrlKey && !e.altKey && !e.metaKey) {
			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					setDropdown('selectedIndex', prev =>
						prev < dropdown.items.length - 1 ? prev + 1 : prev
					);
					return;
				case 'ArrowUp':
					e.preventDefault();
					setDropdown('selectedIndex', prev => prev > 0 ? prev - 1 : 0);
					return;
				case 'Enter':
				case 'Tab':
					e.preventDefault();
					if (dropdown.selectedIndex >= 0) {
						insertDropdownItem(dropdown.items[dropdown.selectedIndex]);
					}
					return;
			}
		}

		if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			const target = e.target as HTMLTextAreaElement
			const result = tabComplete(target.value, target.selectionStart)
			props.setChat('draft', 'text', result.text)
			if (result.cursorPos !== undefined) {
				target.setSelectionRange(result.cursorPos, result.cursorPos)
			}
		}
		if (e.key === 'Enter' && (e.altKey || e.ctrlKey)) {
			e.preventDefault();
			submit(e.altKey);
		}
	}

	function insertDropdownItem(item: DropdownItem) {
		if (item.type === 'image') {
			const completion = imageCompletionAt(props.chat.draft.text, msgbox.selectionStart);
			if (!completion) return closeDropdown();
			const result = completeImageReference(props.chat.draft.text, completion, item.name);
			props.setChat('draft', 'text', result.text);
			closeDropdown();
			msgbox.setSelectionRange(result.cursorPos, result.cursorPos);
			msgbox.focus();
			return;
		}
		const text = props.chat.draft.text;
		const before = text.slice(0, dropdown.queryStart);
		const after = text.slice(dropdown.queryEnd);

		// Use brackets if name contains spaces or special characters
		const ref = fileReference(item.name);

		props.setChat('draft', 'text', before + ref + after);
		closeDropdown();
		if (item.type === 'file' && item.filePath) attachFilePath(item.filePath);

		// Set cursor after the inserted ref
		const newCursorPos = before.length + ref.length;
		msgbox.setSelectionRange(newCursorPos, newCursorPos);
		msgbox.focus();
	}

	/** Waits on in-flight attachment reads so a file picked a moment ago still makes it. */
	async function submit(addOnly: boolean) {
		const reads = pending();
		if (reads.length) await Promise.all(reads.map(read => read.task));
		if (addOnly) return addWithoutSending();

		const input = props.chat.draft.text.trim();
		
		// ux: sending on asst message usually an accident
		if (props.chat.draft.role === 'assistant' && !input.startsWith('/') && (input || props.chat.draft.images.length || props.chat.draft.files.length))
			return addWithoutSending();

		if (input.startsWith('/aside')) {
			props.sendAsideMessage(input.slice(6).trim());
			clearInput();
		} else if (input.startsWith('/compact') && !props.isLoading) {
			props.compactChat();
			clearInput();
		} else if (input.startsWith('/rewrite')) {
			props.sendRewriteMessage(input.slice(8).trim());
			clearInput();
		} else if (props.isLoading) {
			queueCurrent();
		} else {
			props.sendMessage(-1);
		}
	}

	function queueCurrent() {
		props.queueSend({ content: props.chat.draft.text, images: props.chat.draft.images, files: props.chat.draft.files, role: props.chat.draft.role });
	}

	function unqueue() {
		const q = props.queuedSend;
		props.queueSend(null);
		if (!q) return;
		props.setChat('draft', draft => ({
			text: draft.text ? q.content + '\n' + draft.text : q.content,
			images: [...q.images, ...draft.images],
			files: [...q.files, ...draft.files],
		}));
		msgbox.focus();
	}

	return (
		<div class='inputArea' onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
			<Show when={props.queuedSend}>
				{q => (
					<div class='queuedBar'>
						<span class='queuedLabel'>Queued:</span>
						<span class='queuedText'>{q().content.trim() || '(continue)'}</span>
						<Show when={q().images.length}>
							<span class='queuedMeta'>+{q().images.length} image{q().images.length > 1 ? 's' : ''}</span>
						</Show>
						<Show when={q().files.length}>
							<span class='queuedMeta'>+{q().files.length} file{q().files.length > 1 ? 's' : ''}</span>
						</Show>
						<button class='queuedCancel' title="Unqueue — put it back in the input" onClick={unqueue}>×</button>
					</div>
				)}
			</Show>
			<Show when={fileChips().length}>
				<div class='fileAttachmentList'>
					<For each={fileChips()}>
						{chip => (
							<button classList={{ fileAttachmentChip: true, unattached: !chip.file }}
								title={!chip.toggleable ? 'Attached — delete the @ mention to remove it'
									: chip.file ? 'Attached — click to keep the mention without sending the file' : 'Mentioned only — click to attach the file'}
								onClick={() => chip.toggleable && toggleAttachment(chip.path)}>
								<span>{chip.path}</span>
								<span class='fileChipMeta'>{` ${chipMeta(chip)}`}</span>
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={props.chat.draft.images.length}>
				<div class='imageStrip'>
					<For each={props.chat.draft.images}>
						{(id, i) => <ChatImage src={id} label={props.chat.draft.images.length > 1 ? `Image ${i() + 1}` : undefined} onRemove={() => props.setChat('draft', 'images', prev => prev.filter((_, j) => j !== i()))} />}
					</For>
				</div>
			</Show>
			<textarea
				class='inputField' aria-label="Chat message input"
				aria-multiline="true" value={props.chat.draft.text} onInput={handleInputChange} placeholder="Type your message..."
				onKeyDown={messageKeybind} onPaste={handlePaste} onCopy={handleLineClipboard} onCut={handleLineClipboard}
				onClick={refreshDropdownForCaret} onBlur={closeDropdown}
				onKeyUp={e => {
					if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refreshDropdownForCaret();
				}}
				ref={msgbox} rows={1}
			/>
			<Show when={dropdown.show && dropdown.items.length > 0}>
				<div class='loreDropdown'>
					<For each={dropdown.items}>
						{(item, index) => (
							<>
							<Show when={index() === 0 || dropdown.items[index() - 1].type !== item.type}>
								<div class='loreDropHeader'>{item.type === 'lore' ? 'Lore entries' : item.type === 'image' ? 'Image folder' : 'Files'}</div>
							</Show>
							<div
								classList={{
									'loreDropdownItem': true,
									'loreDropdownItemSelected': index() === dropdown.selectedIndex
								}}
								onMouseDown={e => { e.preventDefault(); insertDropdownItem(item); }}
								onMouseEnter={() => setDropdown('selectedIndex', index())}
							>
								<div class='loreDropName'>{item.name}</div>
								<Show when={item.description}>
									<div class='loreDropDesc'>{item.description}</div>
								</Show>
							</div>
							</>
						)}
					</For>
				</div>
			</Show>
			<div class='inputControls'>
				<TSeg options={{ user: 'User', assistant: 'Assistant' }} selected={props.chat.draft.role} setSelected={role => props.setChat('draft', 'role', role as Role)} tooltips={{ user: 'Send as user message', assistant: 'Send as assistant message' }}></TSeg>
				<TSeg options={{ single: 'Once', loop: 'Loop' }} selected={props.chat.sendMode} setSelected={mode => props.setChat('sendMode', mode as 'loop' | 'single')} tooltips={{ single: 'Send once', loop: 'Loop: keep sending until stopped' }}></TSeg>

				<label class='fake-but' title="Attach images (or paste / drop them)" style='cursor: pointer;'>
					<TbOutlinePhotoPlus size={17} />
					<input type="file" accept="image/*" multiple onChange={pickImages} style='display: none;' />
				</label>

				<div class='tokenCount'>
					<span>{estTokens(props.chat.draft.text, props.chat.model)}</span>
					<span class='tokenSeparator'>/</span>
					<span>{tokens()}</span>
				</div>

				<Show when={props.isLoading} fallback={
					<button type="submit" class='sendButton' aria-label="Send message" title="Send message" onclick={e => submit(e.altKey)}>
						<TbOutlineSend size={22} />
					</button>
				}>
					<button type="submit" classList={{ sendButton: true, queued: !!props.queuedSend }}
						aria-label={props.queuedSend ? "Unqueue next turn" : "Send next turn"}
						title={props.queuedSend
							? "Queued — sends when the current turn finishes (click to unqueue)"
							: "Queue this message to send when the current turn finishes"}
						onclick={() => props.queuedSend ? unqueue() : submit(false)}>
						<TbOutlinePlaylistAdd size={22} />
					</button>
					<button type="button" class='cancelButton' aria-label={props.toolsRunning ? "Cancel tools" : "Stop generating"}
						title={props.toolsRunning ? "Cancel running tools" : "Stop generating"} onclick={() => props.abortAllStreams()}>
						<Show when={props.toolsRunning} fallback={<BsStopCircle size={22} />}>
							<TbOutlineToolsOff size={22} />
						</Show>
					</button>
				</Show>
			</div>
		</div>
	)
}

/** @path or @[path with spaces], as written by fileReference. */
const MENTION_RE = /(?<!@)@(?:\[([^\]\n]+)\]|([\w./\\-]+))/g;

function fileReference(name: string): string {
	return /[^\w\/\-.]/.test(name) ? `@[${name}]` : `@${name}`;
}
