import { For, Show, Setter, createSignal, createEffect } from 'solid-js';
import { SetStoreFunction } from 'solid-js/store';
import { TbOutlinePencil, TbOutlineArrowBack, TbOutlineTrashX, TbOutlinePlus, TbOutlineClearAll, TbOutlineDownload, TbOutlineUpload } from 'solid-icons/tb';
import { d_txt } from './Extras'
import { LoreEntry, exportLore, importLore, revertLoreEntry, deleteLoreEntry } from './lore'
import { confirmDialog } from './platform'

interface LoreEntryItemProps {
	entry: LoreEntry;
	group: string;
	expanded: string | null;
	setExpanded: Setter<string | null>;
	editingName: string | null;
	setEditingName: Setter<string | null>;
	onDelete: (name: string) => void;
	onRevert: (name: string) => void;
	onUpdateEntry: (name: string, field: keyof LoreEntry, value: string) => void;
}

function LoreEntryItem(props: LoreEntryItemProps) {
	const displayName = () => props.group ? props.entry.name.slice(props.group.length + 1) : props.entry.name;
	const isExpanded = () => props.expanded === props.entry.name;
	const isEditingName = () => props.editingName === props.entry.name;
	const [editName, setEditName] = createSignal(props.entry.name);
	let textareaRef!: HTMLTextAreaElement;

	createEffect(() => {
		if (isEditingName()) setEditName(props.entry.name);
	});

	createEffect(() => {
		if (isExpanded() && textareaRef) {
			setTimeout(() => {
				textareaRef.style.height = 'auto';
				textareaRef.style.height = textareaRef.scrollHeight + 'px';
			}, 0);
		}
	});

	return (
		<div class='loreEntry'>
			<div class='loreEntryHeader'
				onClick={() => props.setExpanded(isExpanded() ? null : props.entry.name)}>
				<span>
					<Show when={isEditingName()} fallback={<span>{displayName()}</span>}>
						<input
							type="text"
							value={editName()}
							onInput={e => setEditName(e.target.value)}
							onBlur={() => {
								const newName = editName().trim();
								if (newName && newName !== props.entry.name) {
									props.onUpdateEntry(props.entry.name, 'name', newName);
								}
								props.setEditingName(null);
							}}
							onClick={e => e.stopPropagation()}
							onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
							placeholder="Name"
							class='editingNameInput'
							autofocus
						/>
					</Show>
					<Show when={props.entry.description && !isExpanded()}>
						<span class='entryDescription'>{props.entry.description}</span>
					</Show>
				</span>
				<span>
					<button class='mbutton' onClick={(e) => { e.stopPropagation(); props.setEditingName(isEditingName() ? null : props.entry.name); }} title="Edit name">
						<TbOutlinePencil size={14} />
					</button>
					<button class='mbutton'
						onMouseDown={(e) => {
							e.stopPropagation();
							if (e.detail === 2) { props.onDelete(props.entry.name); return; }
							if (!e.shiftKey) {
								const btn = e.currentTarget;
								btn.classList.add('shake');
								setTimeout(() => btn.classList.remove('shake'), 300);
								return;
							}
							props.onDelete(props.entry.name);
						}}
						title="Shift+Click or Double-Click to delete">
						<TbOutlineTrashX size={14} />
					</button>
					<Show when={props.entry.previousContent}>
						<button class='mbutton' onClick={(e) => { e.stopPropagation(); props.onRevert(props.entry.name); }} title="Revert to previous">
							<TbOutlineArrowBack size={14} />
						</button>
					</Show>
				</span>
			</div>

			<Show when={isExpanded()}>
				<div style="margin-top: 4px;">
					<input
						type="text"
						value={props.entry.description}
						onInput={e => props.onUpdateEntry(props.entry.name, 'description', e.target.value)}
						placeholder="Description"
						style="width: 100%; margin-bottom: 4px;"
					/>
					<textarea
						ref={textareaRef}
						value={props.entry.content}
						onInput={e => props.onUpdateEntry(props.entry.name, 'content', e.target.value)}
						class='editingTextarea'
					/>
				</div>
			</Show>
		</div>
	);
}

export function LoreManager(props: {
	lore: LoreEntry[],
	setLore: SetStoreFunction<LoreEntry[]>,
	loreId?: string,
	setError?: Setter<string | null> | undefined
}) {
	const [expanded, setExpanded] = createSignal<string | null>(null);
	const [editingName, setEditingName] = createSignal<string | null>(null);
	const [newEntryMode, setNewEntryMode] = createSignal(false);
	const [newName, setNewName] = createSignal('');
	const [newDescription, setNewDescription] = createSignal('');
	const [newContent, setNewContent] = createSignal('');
	let newContentRef!: HTMLTextAreaElement;

	createEffect(() => {
		if (newEntryMode() && newContentRef) {
			setTimeout(() => {
				newContentRef.style.height = 'auto';
				newContentRef.style.height = newContentRef.scrollHeight + 'px';
			}, 0);
		}
	});

	function handleImport(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		file.text().then(text => {
			const imported = importLore(text);
			props.setLore(imported);
		}).catch(error => {
			const msg = 'Failed to import lore: ' + (error instanceof Error ? error.message : String(error));
			console.error(msg, error);
			props.setError?.(msg);
		});
	}

	/** Use File System Access API with picker id when available, so the browser
	 *  remembers the last directory per loreId. Falls through to <input> on
	 *  unsupported browsers. */
	function handleImportClick(e: MouseEvent) {
		if (!('showOpenFilePicker' in window)) return; // fall through to <input> handler
		e.preventDefault();

		(async () => {
			try {
				const pickerOpts: any = {
					types: [{ description: 'JSON files', accept: { 'application/json': ['.json'] } }]
				};
				if (props.loreId) pickerOpts.id = `l-${props.loreId}`.slice(0, 32);

				const [handle] = await (window as any).showOpenFilePicker(pickerOpts);
				const file = await handle.getFile();
				const text = await file.text();
				const imported = importLore(text);
				props.setLore(imported);
			} catch (e: any) {
				if (e.name !== 'AbortError') {
					const msg = 'Failed to import lore: ' + (e instanceof Error ? e.message : String(e));
					console.error(msg, e);
					props.setError?.(msg);
				}
			}
		})();
	}

	function handleExport() {
		d_txt(exportLore(props.lore), 'lore.json', 'application/json');
	}

	function handleRevert(name: string) {
		props.setLore(revertLoreEntry(props.lore, name));
	}

	function handleDelete(name: string) {
		props.setLore(deleteLoreEntry(props.lore, name));
	}

	async function handleClearAll() {
		if (await confirmDialog('Clear all lore entries? Please export first')) {
			props.setLore([]);
		}
	}

	function handleAddEntry() {
		if (!newName().trim()) return;

		props.setLore(props.lore.length, {
			name: newName().trim(),
			description: newDescription().trim(),
			content: newContent(),
			previousContent: undefined
		});

		setNewName('');
		setNewDescription('');
		setNewContent('');
		setNewEntryMode(false);
	}

	function updateEntry(name: string, field: keyof LoreEntry, value: string) {
		if (field === 'name') {
			const idx = props.lore.findIndex(e => e.name === name);
			if (idx >= 0) props.setLore(idx, 'name', value);
		} else {
			props.setLore(e => e.name === name, field, value);
		}
	}



	// Group entries by hierarchy
	const groupedEntries = () => {
		const groups = new Map<string, LoreEntry[]>();
		for (const entry of props.lore) {
			const parts = entry.name.split('/');
			const group = parts.length > 1 ? parts[0] : '';
			if (!groups.has(group)) groups.set(group, []);
			groups.get(group)!.push(entry);
		}
		return groups;
	};

	return (
		<div style="font-family: var(--font-ui);">
			<details class='sidebar-section'>
				<summary>
					<h4 class='loreHeader'>Lore ({props.lore.length})</h4>
					<span style='display: inline-flex; float: right; align-items: center; gap: 0px; margin-top: -3px;'>
												<button class="slim-but" onClick={() => setNewEntryMode(true)} title="Add entry">
							<TbOutlinePlus size={16} />
						</button>
						<button class="slim-but" onClick={handleExport} title="Export lore">
							<TbOutlineDownload size={16} />
						</button>
						<label class="fake-but" title="Import lore" style='cursor: pointer;' onClick={handleImportClick}>
							<TbOutlineUpload size={16} />
							<input type="file" accept=".json" style='display: none;' onChange={handleImport} />
						</label>
							<button class="slim-but danger" onClick={handleClearAll} title="Clear all">
								<TbOutlineClearAll size={16} />
							</button>
					</span>
				</summary>

				<Show when={newEntryMode()}>
					<div class='newEntryForm'>
						<input
							type="text" placeholder="Name (e.g., Dwarves/culture)"
							value={newName()} onInput={e => setNewName(e.target.value)}
							style="width: 100%; margin-bottom: 4px;"
						/>
						<input
							type="text" placeholder="Description (1 sentence for AI context)"
							value={newDescription()} onInput={e => setNewDescription(e.target.value)}
							style="width: 100%; margin-bottom: 4px;"
						/>
						<textarea
							ref={newContentRef}
							placeholder="Content" value={newContent()}
							onInput={e => setNewContent(e.target.value)}
							class='newEntryTextarea'
						/>
						<div style="display: flex; gap: 4px;">
							<button onClick={handleAddEntry}>Add</button>
							<button onClick={() => setNewEntryMode(false)} style="margin-left: 4px;">Cancel</button>
						</div>
					</div>
				</Show>

				<For each={Array.from(groupedEntries().entries())}>
					{([group, entries]) => (
						<div classList={{groupIndent: !!group}}>
							<Show when={group}>
								<div class='groupHeader'>{group}/</div>
							</Show>
							<For each={entries}>
								{entry => (
									<LoreEntryItem
										entry={entry}
										group={group}
										expanded={expanded()}
										setExpanded={setExpanded}
										editingName={editingName()}
										setEditingName={setEditingName}
										onDelete={handleDelete}
										onRevert={handleRevert}
										onUpdateEntry={updateEntry}
									/>
								)}
							</For>
						</div>
					)}
				</For>
			</details>
		</div>
	);
}
