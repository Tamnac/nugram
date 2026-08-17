import {createEffect, createMemo, createSignal, onCleanup, Setter, Show, mapArray, For, onMount} from 'solid-js';
import {SetStoreFunction, createStore} from 'solid-js/store'
import type {ChatMessage, FileAttachment, Role, Prompt} from './helpers/types'
import {TSeg} from './helpers/Comps'
import { TbOutlineSend, TbOutlineSend2, TbOutlinePhotoPlus } from 'solid-icons/tb'
import { BsStopCircle } from 'solid-icons/bs'
import { LoreEntry } from './helpers/lore'
import { isTauri, listFolderFiles } from './helpers/platform'
import { tools as allTools, resolveContent } from './helpers/tools'
import { msgVars } from './helpers/Extras'
import { estTokens, estTokensFromLength, IMAGE_CHARS } from './helpers/tokens'
import { attachFromTransfer, attachImage } from './helpers/attachments'
import { ChatImage } from './helpers/Comps'
import { modelMatchesTrigger } from './helpers/PromptManager'
import type { StreamingResult } from './helpers/streaming'
import Fuse from 'fuse.js';




interface InputArgs {
	 inputValue: string;
	 setInputValue: Setter<string>;
	 sendMessage: (redo: number | undefined) => Promise<StreamingResult | undefined>;
	 images: string[];
	 setImages: Setter<string[]>;
	 files: FileAttachment[];
	 setFiles: Setter<FileAttachment[]>;
	 sendAsideMessage: (content: string) => void;
	 sendRewriteMessage: (content: string) => void;
	 isLoading: boolean;
	 abortAllStreams: () => void;
	 role: Role;
	 setRole: Setter<Role>;
	 setMessages: SetStoreFunction<ChatMessage[]>;
	 messages: ChatMessage[];
	cut: number;
	prompts: Prompt[];
	lore: LoreEntry[];
	chatFolder?: string;
	chatId?: string;
	setSendMode: Setter<'loop' | 'single'>;
	sendMode: 'loop' | 'single';
	macros: Record<string, string>;
	model: string;
	tools?: Record<string, boolean> | undefined;
	preserveReasoning?: 'off' | 'interleaved' | 'full' | undefined;
	setError: Setter<string | null>;
}
export function MInput(props : InputArgs) {
	// Autocomplete dropdown state (lore + files)
	interface DropdownItem {
		type: 'lore' | 'file';
		name: string;
		description?: string;
		loreEntry?: LoreEntry;
		filePath?: string;
	}

	const [dropdown, setDropdown] = createStore({
		show: false,
		items: [] as DropdownItem[],
		selectedIndex: -1,
		queryStart: -1,
		queryEnd: -1
	});

	const AT_RE = /(?<!@)@(?!@)(?:ref)?([^\s]*)$/;
	const FILES_STALE_MS = 10_000;
	const [folderFiles, setFolderFiles] = createSignal<string[] | null>(null);
	let folderFilesCachedPath: string | null = null;
	let folderFilesFetchedAt = 0;
	let folderFilesFetching = false;
	let fileFuse: Fuse<{ path: string; name: string }> | null = null;

	const loreFuse = createMemo(() => new Fuse(props.lore, {
		keys: [
			{ name: 'name', weight: 2 },
			{ name: 'description', weight: 0.5 }
		],
		ignoreLocation: true,
		threshold: 0.3
	}));

	function refreshFolderFiles() {
		if (folderFilesFetching || !isTauri || !props.chatFolder) return;
		folderFilesFetching = true;
		const path = props.chatFolder;
		listFolderFiles(path).then(files => {
			if (path !== props.chatFolder) return;
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
			refreshDropdownFromInput();
		}).finally(() => { folderFilesFetching = false; });
	}

	// Rebuild the dropdown from the current textarea state (after an async file load)
	function refreshDropdownFromInput() {
		const loc = msgbox.selectionStart;
		const before = props.inputValue.slice(0, loc);
		const atMatch = before.match(AT_RE);
		if (!atMatch) return;
		const items = buildDropdownItems(atMatch[1] || '');
		setDropdown({
			show: true,
			items,
			selectedIndex: items.length > 0 ? 0 : -1,
			queryStart: before.lastIndexOf('@'),
			queryEnd: loc
		});
	}

	// Reads in flight. Submitting awaits them, so a just-picked file is never left behind
	// and the send button never goes dead: its chip is already on screen.
	const [pending, setPending] = createSignal<{ path: string; task: Promise<void> }[]>([]);
	const knownFiles = createMemo(() => new Set(folderFiles() ?? []));

	/** Paths the message text names with @, limited to files that exist in the chat folder. */
	const mentions = createMemo(() => {
		const known = knownFiles();
		if (!known.size) return [];
		const found: string[] = [];
		for (const match of props.inputValue.matchAll(MENTION_RE)) {
			const path = match[1] || match[2];
			if (path && known.has(path) && !found.includes(path)) found.push(path);
		}
		return found;
	});

	/**
	 * One chip per mention. Attaching is a state of the mention, not a separate thing, so a
	 * chip can be sent with the file or without it — and deleting the @ref drops both.
	 */
	const fileChips = createMemo(() => {
		const attached = new Map(props.files.map(file => [file.path, file]));
		return mentions().map(path => ({
			path,
			file: attached.get(path),
			pending: pending().some(read => read.path === path),
		}));
	});

	// Guarded on a loaded listing: with no folder files every mention reads as unknown,
	// which would detach everything on a folder switch.
	createEffect(() => {
		if (!knownFiles().size) return;
		const named = new Set(mentions());
		if (props.files.some(file => !named.has(file.path)))
			props.setFiles(files => files.filter(file => named.has(file.path)));
	});

	function attachFilePath(path: string) {
		if (props.files.some(file => file.path === path) || pending().some(read => read.path === path)) return;
		const task = (async () => {
			const { attachFile } = await import('./helpers/attachments');
			const attached = await attachFile(path, props.chatFolder || '');
			if ('file' in attached) props.setFiles(files => [...files, attached.file]);
			else props.setImages(images => [...images, ...attached.images]);
		})()
			.catch(err => { props.setError('Failed to attach file: ' + (err instanceof Error ? err.message : String(err))); })
			.finally(() => setPending(prev => prev.filter(read => read.path !== path)));
		setPending(prev => [...prev, { path, task }]);
	}

	function toggleAttachment(path: string) {
		if (props.files.some(file => file.path === path))
			props.setFiles(files => files.filter(file => file.path !== path));
		else
			attachFilePath(path);
	}

	function chipMeta(chip: { file: FileAttachment | undefined; pending: boolean }): string {
		if (chip.pending) return 'reading\u2026';
		if (!chip.file) return 'not attached';
		const tokens = `~${estTokensFromLength(chip.file.chars, props.model)} tok`;
		return chip.file.truncated ? `${tokens} \u00b7 truncated` : tokens;
	}

	const [msgCharTotal, setMsgCharTotal] = createSignal(0);
	const msgLens: number[] = []; // plain array for cut calculation

	const _trackMsgLens = mapArray(() => props.messages, (msg, index) => {
		let prev = 0;
		createEffect(() => {
			const i = index();
			const vi = msg.currentVersionIndex;
			let len = msg.content[vi].length + 5;

			const toolCalls = msg.tool_calls?.[vi];
			if (toolCalls)
				for (const tc of toolCalls)
					len += tc.function.name.length + JSON.stringify(tc.function.arguments).length;

			const toolResults = msg.tool_results?.[vi];
			if (toolResults)
				for (const tr of toolResults)
					len += tr.name.length + resolveContent(tr).length + (tr.data?.images?.length ?? 0) * IMAGE_CHARS;

			// Preserved reasoning is a rough estimate: actual sent reasoning varies
			// by provider/model/mode (summaries+signatures, tool-call-only slices,
			// since-last-user windows). We count the full thinking text as an upper bound.
			const pr = props.preserveReasoning;
			if (pr && pr !== 'off')
				len += msg.thinking?.[vi]?.length ?? 0;

			len += (msg.images?.[vi]?.length ?? 0) * IMAGE_CHARS;
			for (const file of msg.files?.[vi] || []) len += file.chars;

			msgLens[i] = len;
			setMsgCharTotal(t => t - prev + len);
			prev = len;
		});
		onCleanup(() => setMsgCharTotal(t => t - prev));
		return null;
	});

	// Drive the lazy mapArray
	createEffect(() => { _trackMsgLens(); });

	const cutExcluded = createMemo(() => {
		msgCharTotal(); // re-run when any length changes
		const len = props.messages.length;
		const cut = props.cut < len ? Math.max(props.cut, 0) : 0;
		if (cut === 0) return 0;
		let sum = 0;
		for (let i = 0; i < cut; i++) sum += msgLens[i] || 0;
		return sum;
	});

	const promptsCharTotal = createMemo(() => {
		let sum = 0;
		for (const p of props.prompts)
			if (p.enabled && modelMatchesTrigger(p.modelTrigger, props.model).matches)
				sum += msgVars(p.content, props.macros, props.model, props.chatFolder, props.chatId).length;
		return sum;
	});

	// JSON length of the tool definitions actually sent (mirrors streaming.ts filtering).
	const toolsCharTotal = createMemo(() => {
		const selected = props.tools;
		if (!selected) return 0;
		const sent = allTools.filter(t => selected[t.function.name] === true);
		return sent.length > 0 ? JSON.stringify(sent).length : 0;
	});

	const tokens = () => {
		const inputLen = msgVars(props.inputValue, props.macros, props.model, props.chatFolder, props.chatId).length
			+ props.files.reduce((sum, file) => sum + file.chars, 0);
		return estTokensFromLength(msgCharTotal() - cutExcluded() + promptsCharTotal() + toolsCharTotal() + inputLen, props.model);
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
		if (isTauri && props.chatFolder) {
			// Update cache if path changed
			if (folderFilesCachedPath !== props.chatFolder) {
				setFolderFiles(null);
				fileFuse = null;
				folderFilesCachedPath = props.chatFolder;
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
		props.setInputValue(newValue);
		target.setSelectionRange(loc, loc);

		// Check for @ trigger for autocomplete (lore + files)
		const textBeforeCursor = newValue.slice(0, loc);
		// Only single @ triggers the lore/file search; @@ is a macro reference
		const atMatch = textBeforeCursor.match(AT_RE);

		if (atMatch) {
			const query = atMatch[1] || '';
			const items = buildDropdownItems(query);

			setDropdown({
				show: true,
				items,
				selectedIndex: items.length > 0 ? 0 : -1,
				queryStart: textBeforeCursor.lastIndexOf('@'),
				queryEnd: loc
			});

			// Load folder files if missing or stale (picks up files created mid-session)
			if (!folderFiles() || Date.now() - folderFilesFetchedAt > FILES_STALE_MS)
				refreshFolderFiles();
		} else {
			setDropdown('show', false);
		}
	};

	async function addImages(data: DataTransfer | null) {
		const ids = await attachFromTransfer(data);
		if (ids.length) props.setImages(prev => [...prev, ...ids]);
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
		if (ids.length) props.setImages(prev => [...prev, ...ids]);
		input.value = ''; // allow picking the same file again
	}

	/** Message the current input makes, attachments included. */
	function inputMessage(): ChatMessage {
		const msg: ChatMessage = { role: props.role, content: [props.inputValue], currentVersionIndex: 0 };
		if (props.images.length) msg.images = [props.images];
		if (props.files.length) msg.files = [props.files];
		return msg;
	}

	function clearInput() {
		props.setInputValue('');
		props.setImages([]);
		props.setFiles([]);
	}

	function addWithoutSending() {
		props.setMessages(props.messages.length, inputMessage());
		clearInput();
		props.setRole(prev => prev === 'user' ? 'assistant' : 'user');
	}

	let msgbox!: HTMLTextAreaElement;
	// createEffect(() => {if(!props.isLoading && document.activeElement?.tagName !== 'TEXTAREA') msgbox.focus();});
	onMount(() => { msgbox.focus(); });

	function messageKeybind(e: KeyboardEvent) {
		// Handle dropdown navigation
		if (dropdown.show && dropdown.items.length > 0) {
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
				case 'Escape':
					setDropdown('show', false);
					return;
			}
		}

		if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			const target = e.target as HTMLTextAreaElement
			const result = tabComplete(target.value, target.selectionStart)
			props.setInputValue(result.text)
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
		const text = props.inputValue;
		const before = text.slice(0, dropdown.queryStart);
		const after = text.slice(dropdown.queryEnd);

		// Use brackets if name contains spaces or special characters
		const ref = fileReference(item.name);

		props.setInputValue(before + ref + after);
		setDropdown('show', false);
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

		const input = props.inputValue.trim();
		if (input.startsWith('/aside')) {
			props.sendAsideMessage(input.slice(6).trim());
			clearInput();
		} else if (input.startsWith('/rewrite')) {
			props.sendRewriteMessage(input.slice(8).trim());
			clearInput();
		} else {
			props.sendMessage(-1);
		}
	}

	function sendMessage(e: MouseEvent) {
		if (props.isLoading) props.abortAllStreams();
		else submit(e.altKey);
	}

	return (
		<div class='inputArea'>
			<div class='inputContainer' style="position: relative;" onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
				<Show when={fileChips().length}>
					<div class='fileAttachmentList'>
						<For each={fileChips()}>
							{chip => (
								<button classList={{ fileAttachmentChip: true, unattached: !chip.file }}
									title={chip.file ? 'Attached — click to keep the mention without sending the file' : 'Mentioned only — click to attach the file'}
									onClick={() => toggleAttachment(chip.path)}>
									<span>{chip.path}</span>
									<span class='fileChipMeta'>{` ${chipMeta(chip)}`}</span>
								</button>
							)}
						</For>
					</div>
				</Show>
				<Show when={props.images.length}>
					<div class='imageStrip'>
						<For each={props.images}>
							{(id, i) => <ChatImage src={id} onRemove={() => props.setImages(prev => prev.filter((_, j) => j !== i()))} />}
						</For>
					</div>
				</Show>
				<textarea
					class='inputField' aria-label="Chat message input"
					aria-multiline="true" value={props.inputValue} onInput={handleInputChange} placeholder="Type your message..."
					onKeyDown={messageKeybind} onPaste={handlePaste} ref={msgbox} rows={1}
				/>
				<div class='tokenOverlay'>
					<span>{estTokens(props.inputValue, props.model)}</span>
					<span class='tokenSeparator'>/</span>
					<span>{tokens()}</span>
				</div>
				
				<Show when={dropdown.show && dropdown.items.length > 0}>
					<div class='loreDropdown'>
						<For each={dropdown.items}>
							{(item, index) => (
								<>
								<Show when={index() === 0 || dropdown.items[index() - 1].type !== item.type}>
									<div class='loreDropHeader'>{item.type === 'lore' ? 'Lore entries' : 'Files'}</div>
								</Show>
								<div
									classList={{
										'loreDropdownItem': true,
										'loreDropdownItemSelected': index() === dropdown.selectedIndex
									}}
									onMouseDown={() => insertDropdownItem(item)}
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
			</div>
			<div class='expand' style={{"padding": "5px"}}>
				<TSeg options={{ user: 'U', assistant: 'A' }} selected={props.role} setSelected={props.setRole} tooltips={{ user: 'Send as user message', assistant: 'Send as assistant message' }}></TSeg>
				<TSeg options={{ single: 'S', loop: 'L' }} selected={props.sendMode} setSelected={props.setSendMode} tooltips={{ single: 'Send once', loop: 'Loop: keep sending until stopped' }}></TSeg>

				<label class='attachButton' title="Attach images (or paste / drop them)">
					<TbOutlinePhotoPlus size={22} />
					<input type="file" accept="image/*" multiple onChange={pickImages} />
				</label>

				<button type="submit" class={props.isLoading ? 'cancelButton' : 'sendButton'}
					aria-label={props.isLoading ? "Cancel message" : "Send message"} onclick={sendMessage}
					style="padding: 4px 6px;">
					<Show when={props.isLoading} fallback={<TbOutlineSend size={25} />}>
						<BsStopCircle size={25} />
					</Show>
				</button>
			</div>
		</div>
	)
}

/** @path or @[path with spaces], as written by fileReference. */
const MENTION_RE = /(?<!@)@(?:\[([^\]\n]+)\]|([\w./\\-]+))/g;

function fileReference(name: string): string {
	return /[^\w\/\-.]/.test(name) ? `@[${name}]` : `@${name}`;
}

function iSpace(char: string): boolean {
	return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

export function typeHelper(text: string, loc: number) : string {
	if (loc <= 0 || loc > text.length) return text;
	const lastChar = text.charAt(loc-1);
	const nextChar = text.charAt(loc);
	const matches = ['(', '[', '{', '<'];
	const replace = [')', ']', '}', '>'];
	const matchI = matches.indexOf(lastChar);

	if (matchI !== -1 && (iSpace(nextChar) || loc === text.length))
			text =  text.slice(0, loc) + replace[matchI] + text.slice(loc);

	return text;
}

export function tabComplete(text: string, loc: number): {text: string, cursorPos?: number | undefined} {
	let newText = text;
	let newCursorPos: number | undefined;

	if (text.substring(loc - 2, loc) === '--'){
		text = text.slice(0, loc-2) + '—' + text.slice(loc);
		newCursorPos = loc - 1;
	}
	newText = text.replaceAll(/div.([\w-]+)/g, (m, p1, offset) => {
		if (offset + m.length === loc) {
			const replacement = `<div class="${p1}"></div>`;
			newCursorPos = offset + `<div class="${p1}">`.length;
			return replacement;
		}
		return m;
	});
	
	return { text: newText, cursorPos: newCursorPos };
}
