/**
 * Provider + model picker: a button showing the model's display name, opening a popover that
 * searches every enabled provider at once. Model lists and recents live in modelCatalog.ts.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { TbOutlineClock, TbOutlineSearch } from 'solid-icons/tb';
import type { Provider, ProviderConfig } from './types';
import {
	STATIC_PROVIDERS, ensureModels, entryLabel, mentionedProviders, modelLabel, modelLists, providerLabel, providerModels,
	pushRecent, recentModels, searchModels, type ModelEntry, type SearchHit,
} from './modelCatalog';

type Row = SearchHit & { section?: string; custom?: boolean };

function highlightParts(text: string, ranges: [number, number][] = []) {
	const marked = Array.from(text, () => false);
	for (const [start, end] of ranges) for (let i = start; i <= end && i < text.length; i++) marked[i] = true;
	const parts: { text: string; bold: boolean }[] = [];
	for (let i = 0; i < text.length; i++) {
		const last = parts.at(-1);
		if (last?.bold === marked[i]) last.text += text[i];
		else parts.push({ text: text[i]!, bold: marked[i]! });
	}
	return parts;
}

const BROWSE_LIMIT = 300;

export function ModelPicker(props: {
	provider: Provider;
	model: string;
	onChange: (provider: Provider, model: string) => void;
	providers: Record<Provider, ProviderConfig>;
	/** Fill the parent's width (sidebar / dialogs). */
	compact?: boolean;
	/** Open with Ctrl+M. Meant for the single top bar picker. */
	hotkey?: boolean;
}) {
	let buttonRef!: HTMLButtonElement;
	let popRef: HTMLDivElement | undefined;
	let listRef: HTMLDivElement | undefined;
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal('');
	const [scope, setScope] = createSignal<Provider | null>(null);
	const [selected, setSelected] = createSignal(0);
	const [position, setPosition] = createSignal<Record<string, string>>({});

	createEffect(() => ensureModels(props.providers));

	const enabled = createMemo(() => Object.entries(props.providers).filter(([, cfg]) => cfg.enabled).map(([key]) => key));
	const label = (p: Provider) => providerLabel(p, props.providers);

	const rows = createMemo<Row[]>(() => {
		if (!open()) return [];
		const q = query().trim();
		const s = scope();
		const inScope = s ? [s] : enabled();
		if (q) {
			const named = mentionedProviders(q).filter(p => enabled().includes(p) && !inScope.includes(p));
			const found: Row[] = searchModels(q, [...inScope, ...named]);
			const target = s ?? props.provider;
			if (!found.some(m => m.provider === target && m.id === q)) found.push({ provider: target, id: q, custom: true });
			return found;
		}

		const out: Row[] = [];
		const seen = new Set<string>();
		const add = (list: ModelEntry[], section: string) => {
			for (const m of list) {
				const key = `${m.provider}\n${m.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ ...m, section });
			}
		};

		const lists = modelLists();
		const active = s ?? props.provider;

		if (STATIC_PROVIDERS.includes(active) && inScope.includes(active)) add(lists[active] ?? [], label(active));

		add(recentModels().filter(m => inScope.includes(m.provider)), 'Recent');
		
		if (s) add(providerModels(s).slice(0, BROWSE_LIMIT), label(s));
		else for (const p of STATIC_PROVIDERS) if (inScope.includes(p)) add(lists[p] ?? [], label(p));
		return out;
	});

	createEffect(on([open, query, scope], () => setSelected(0)));
	createEffect(() => {
		if (!open()) return;
		listRef?.querySelector(`[data-index="${selected()}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	function openPicker() {
		const rect = buttonRef.getBoundingClientRect();
		const width = Math.min(Math.max(rect.width, 480), window.innerWidth - 16);
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
		const top = rect.bottom + 4;
		setPosition({
			top: `${top}px`,
			left: `${left}px`,
			width: `${width}px`,
			'max-height': `${Math.min(660, window.innerHeight - top - 8)}px`,
		});
		setQuery('');
		setScope(null);
		setOpen(true);
	}

	function close(refocus = false) {
		setOpen(false);
		if (refocus) buttonRef.focus();
	}

	function pick(row: Row) {
		props.onChange(row.provider, row.id);
		pushRecent({ provider: row.provider, id: row.id, name: row.name, description: row.description });
		close(true);
	}

	function cycleScope(dir: 1 | -1) {
		const scopes = [null, ...enabled()];
		const i = scopes.indexOf(scope());
		setScope(scopes[(i + dir + scopes.length) % scopes.length] ?? null);
	}

	/** Move the selection, wrapping around either end. */
	function move(dir: 1 | -1) {
		const count = rows().length;
		if (count) setSelected(i => (i + dir + count) % count);
	}

	function handleKeyDown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				move(1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				move(-1);
				break;
			case 'Tab':
				e.preventDefault();
				cycleScope(e.shiftKey ? -1 : 1);
				break;
			case 'Enter': {
				e.preventDefault();
				const row = rows()[selected()];
				if (row) pick(row);
				break;
			}
			case 'Escape':
				e.preventDefault();
				close(true);
				break;
		}
	}

	createEffect(() => {
		if (!open()) return;
		const onDocDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!popRef?.contains(target) && !buttonRef.contains(target)) close();
		};
		document.addEventListener('mousedown', onDocDown);
		onCleanup(() => document.removeEventListener('mousedown', onDocDown));
	});

	createEffect(() => {
		if (!props.hotkey) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
				e.preventDefault();
				open() ? close(true) : openPicker();
			}
		};
		document.addEventListener('keydown', onKey);
		onCleanup(() => document.removeEventListener('keydown', onKey));
	});

	return (
		<>
			<button
				ref={buttonRef}
				type='button'
				classList={{ modelPickerButton: true, compact: !!props.compact }}
				title={`${label(props.provider)} · ${props.model || 'no model'}${props.hotkey ? ' (Ctrl+M)' : ''}`}
				onClick={() => open() ? close() : openPicker()}
			>
				<span class='modelPickerName'>{props.model ? modelLabel(props.provider, props.model) : 'Select model'}</span>
				<span class='modelProviderTag'>{label(props.provider)}</span>
			</button>
			<Show when={open()}>
				<Portal mount={document.body}>
					<div
						class='modelDropdown modelPickerPopover'
						ref={popRef}
						style={position()}
						onMouseDown={e => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}
					>
						<div class='modelPickerSearchRow'>
							<TbOutlineSearch size={16} />
							<input
								ref={el => queueMicrotask(() => el.focus())}
								class='modelPickerSearch'
								placeholder='Search models… (prefix a provider: "or fable")'
								value={query()}
								onInput={e => setQuery(e.currentTarget.value)}
								onKeyDown={handleKeyDown}
							/>
						</div>
						<div class='modelScopes' title='Tab / Shift+Tab to switch'>
							<For each={[null, ...enabled()]}>
								{p => (
									<button
										type='button'
										classList={{ modelScope: true, active: scope() === p }}
										onMouseDown={e => { e.preventDefault(); setScope(p); }}
									>
										{p ? label(p) : 'All'}
									</button>
								)}
							</For>
						</div>
						<div class='modelList' ref={listRef}>
							<For each={rows()} fallback={<div class='modelEmpty'>No models</div>}>
								{(row, i) => (
									<>
										<Show when={row.section && row.section !== rows()[i() - 1]?.section}>
											<div class='dropHeader'>
												<Show when={row.section === 'Recent'}><TbOutlineClock size={14} /></Show>
												{row.section}
											</div>
										</Show>
										<div
											classList={{ modelDropdownItem: true, modelDropdownItemSelected: i() === selected(), modelPickerCustom: !!row.custom }}
											data-index={i()}
											onMouseDown={e => { e.preventDefault(); pick(row); }}
											onMouseMove={() => setSelected(i())}
										>
											<div class='modelRowTop'>
												<span classList={{ modelName: true, highlighted: !!row.highlight?.length }}>
													<Show
														when={!row.custom}
														fallback={<><span class='modelCustomTag'>custom</span>{`Use “${row.id}”`}</>}
													>
														<For each={highlightParts(entryLabel(row), row.highlight)}>
															{part => part.bold ? <b>{part.text}</b> : part.text}
														</For>
													</Show></span>
												<span class='modelProviderTag'>{label(row.provider)}</span>
											</div>
											<Show when={row.custom ? 'custom model id' : [row.id !== entryLabel(row) && row.id, row.description].filter(Boolean).join(' · ')}>
												{line => <div class='modelDescription'>{line()}</div>}
											</Show>
										</div>
									</>
								)}
							</For>
						</div>
					</div>
				</Portal>
			</Show>
		</>
	);
}
