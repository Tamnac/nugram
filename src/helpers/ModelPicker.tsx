/**
 * Reusable provider + model search picker.
 *
 * Powers the TopBar's main model selector and the agent-tier model selectors.
 * Holds the module-level model lists / fuse indices / recent-models cache
 * shared between instances; each instance owns its own dropdown state.
 */
import { For, Show, createEffect, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import type { Provider, ProviderConfig } from './types';
import { providerNames } from './types';
import Fuse from 'fuse.js';

// ── Static + lazily-fetched model lists (module-level, shared) ────────

const ZAI_MODELS = [
	{ id: 'glm-5.2' },
	{ id: 'glm-5.1' },
	{ id: 'glm-4.7' },
	{ id: 'glm-4.6' },
	{ id: 'glm-4.5' },
	{ id: 'glm-4.5-air' },
	{ id: 'glm-4.5-x' },
	{ id: 'glm-4.5-airx' },
	{ id: 'glm-4.5-flash' },
	{ id: 'glm-4-32b-0414-128k' },
];

const ANTH_LOCAL_MODELS = [
	{ id: 'claude-fable-5' },
	{ id: 'claude-opus-5' },
	{ id: 'claude-opus-4-8' },
	{ id: 'claude-opus-4-7' },
	{ id: 'claude-opus-4-6' },
	{ id: 'opus-4-5' },
	{ id: 'claude-sonnet-5' },
	{ id: 'claude-sonnet-4-6' },
	{ id: 'sonnet-4-5' },
	{ id: 'haiku-4-5' },
	{ id: 'opus-4-1' },
];

const FUSE_OPTIONS = {
	keys: ['name'],
	includeMatches: false,
	ignoreLocation: true,
	useExtendedSearch: true,
	threshold: 0.5,
};

let orFuse: Fuse<any> = new Fuse<any>([], FUSE_OPTIONS);
let nanoFuse: Fuse<any> = new Fuse<any>([], FUSE_OPTIONS);
let fireworksFuse: Fuse<any> = new Fuse<any>([], FUSE_OPTIONS);
let fireworksModels: any[] = [];
let neuralwattFuse: Fuse<any> = new Fuse<any>([], FUSE_OPTIONS);
let neuralwattModels: any[] = [];

async function fetchFireworksModels(apiKey: string) {
	if (!apiKey) return;
	try {
		const res = await fetch('https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue', {
		headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			const message = body?.error?.message || `HTTP ${res.status}`;
			console.warn(`Failed to fetch Fireworks models: ${message}`);
			return;
		}
		const data = await res.json();
		if (data.models) {
			const stripFwPrefix = (s: string) => s.replace(/^accounts\/fireworks\/\w+\//, '');
			fireworksModels = data.models.map((m: any) => ({
				id: m.name || m.id,
				name: m.displayName || stripFwPrefix(m.name || m.id),
				description: m.description || '',
			}));
			fireworksModels.push(
				{ id: 'accounts/fireworks/routers/kimi-k2p5-turbo', name: 'Kimi K2.5 Turbo', description: 'FirePass only, (supposedly) faster Kimi K2.5' },
				{ id: 'accounts/fireworks/routers/glm-5-fast', name: 'GLM 5.0 Fast', description: 'FirePass only, (supposedly) faster GLM 5' });
			fireworksFuse = new Fuse(fireworksModels, FUSE_OPTIONS);
		}
	} catch (e) { console.warn('Failed to fetch Fireworks models:', e); }
}

async function fetchNanoModels() {
	const models = await fetch('https://nano-gpt.com/api/v1/models?detailed=true').then(res => res.json());
	nanoFuse = new Fuse(models.data || [], FUSE_OPTIONS);
}
fetchNanoModels();

async function fetchORModels() {
	try {
		const res = await fetch('https://openrouter.ai/api/v1/models');
		if (!res.ok) { console.warn(`Failed to fetch OR models: ${res.status}`); return; }
		const models = await res.json();
		if (models.data) orFuse = new Fuse(models.data, FUSE_OPTIONS);
	} catch (e) { console.warn('Failed to fetch OR models:', e); }
}
fetchORModels();

async function fetchNeuralwattModels(apiKey?: string) {
	if (!apiKey) return;
	try {
		const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
		const res = await fetch('https://api.neuralwatt.com/v1/models', { headers });
		if (!res.ok) { console.warn(`Failed to fetch Neuralwatt models: ${res.status}`); return; }
		const data = await res.json();
		if (data.data) {
			neuralwattModels = data.data.map((m: any) => ({
				id: m.id,
				name: m.metadata?.display_name || m.id,
				description: m.metadata?.description || '',
			}));
			neuralwattFuse = new Fuse(neuralwattModels, FUSE_OPTIONS);
		}
	} catch (e) { console.warn('Failed to fetch Neuralwatt models:', e); }
}
fetchNeuralwattModels();

// ── Component ────────────────────────────────────────────────────────

export function ModelPicker(props: {
	provider: Provider;
	setProvider: (provider: Provider) => void;
	model: string;
	setModel: (model: string) => void;
	providers: Record<Provider, ProviderConfig>;
	setError?: (error: string | null) => void;
	/** On provider change, auto-pick a relevant model (recent / first hardcoded). Default true. */
	autoPickOnProviderChange?: boolean;
	/** Compact layout for sidebar / inline use (provider select narrows, model input fills). */
	compact?: boolean;
}) {
	let containerRef!: HTMLDivElement;
	const [dropdownPosition, setDropdownPosition] = createSignal<Record<string, string>>({});
	const [dropdownState, setDropdownState] = createStore({
		searchResults: [] as any[],
		showDropdown: false,
		selectedIndex: -1,
		recentModels: [] as any[],
		showingRecent: false,
	});

	const updateDropdownPosition = () => {
		if (!containerRef) return;
		const rect = containerRef.getBoundingClientRect();
		setDropdownPosition({ top: `${rect.bottom}px`, left: `${rect.left}px`, width: `${rect.width}px` });
	};

	createEffect(() => { if (dropdownState.showDropdown) updateDropdownPosition(); });

	const loadRecentModels = () => {
		try {
			const stored = localStorage.getItem('recentModels');
			if (stored) setDropdownState('recentModels', JSON.parse(stored));
		} catch (error) {
			const msg = 'Failed to load recent models from local storage: ' + (error instanceof Error ? error.message : String(error));
			console.error(msg, error);
			props.setError?.(msg);
		}
	};
	loadRecentModels();

	createEffect(() => { if (fireworksModels.length === 0) fetchFireworksModels(props.providers.fireworks?.apiKey); });
	createEffect(() => { if (props.providers.neuralwatt?.apiKey) fetchNeuralwattModels(props.providers.neuralwatt.apiKey); });

	const saveRecentModels = (models: any[]) => {
		try { localStorage.setItem('recentModels', JSON.stringify(models)); }
		catch (error) {
			const msg = 'Failed to save recent models to local storage: ' + (error instanceof Error ? error.message : String(error));
			console.error(msg, error);
			props.setError?.(msg);
		}
	};

	function handleModelInput(e: InputEvent) {
		const value = (e.target as HTMLInputElement).value;
		props.setModel(value);
		const isz = props.provider === 'zai';
		const isnano = props.provider === 'nano';
		const isanth_local = props.provider === 'anth_local';
		const isfireworks = props.provider === 'fireworks';
		const isneuralwatt = props.provider === 'neuralwatt';

		if (value) {
			const filtered = isz
				? ZAI_MODELS.filter(m => m.id.includes(value.toLowerCase()))
				: (isnano ? nanoFuse.search(value, { limit: 5 }).map(r => r.item)
					: (isanth_local ? ANTH_LOCAL_MODELS.filter(m => m.id.includes(value.toLowerCase()))
						: (isfireworks ? fireworksFuse.search(value, { limit: 5 }).map(r => r.item)
							: (isneuralwatt ? (neuralwattFuse?.search(value, { limit: 5 }).map(r => r.item) || [])
								: orFuse.search(value, { limit: 5 }).map(r => r.item)))));
			setDropdownState({ searchResults: filtered, showDropdown: true, showingRecent: false, selectedIndex: -1 });
		} else {
			const providerRecentModels = dropdownState.recentModels.filter(m => m.provider === props.provider);
			setDropdownState({
				searchResults: isz ? ZAI_MODELS : (isanth_local ? ANTH_LOCAL_MODELS : []),
				showDropdown: isz || isanth_local || providerRecentModels.length > 0,
				showingRecent: !isz && !isanth_local,
				selectedIndex: -1,
			});
		}
	}

	function selectModel(model: any) {
		props.setModel(model.id);
		setDropdownState({ showDropdown: false, searchResults: [], showingRecent: false });
		if (props.provider !== 'zai') {
			const modelWithProvider = { ...model, provider: props.provider };
			const updatedModels = (() => {
				const filtered = dropdownState.recentModels.filter(m => m.id !== model.id);
				return [modelWithProvider, ...filtered].slice(0, 20);
			})();
			setDropdownState('recentModels', updatedModels);
			saveRecentModels(updatedModels);
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (!dropdownState.showDropdown) return;
		const results = dropdownState.showingRecent
			? dropdownState.recentModels.filter(m => m.provider === props.provider)
			: dropdownState.searchResults;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				setDropdownState('selectedIndex', prev => prev < results.length - 1 ? prev + 1 : prev);
				break;
			case 'ArrowUp':
				e.preventDefault();
				setDropdownState('selectedIndex', prev => prev > 0 ? prev - 1 : -1);
				break;
			case 'Enter':
				e.preventDefault();
				if (dropdownState.selectedIndex >= 0 && results[dropdownState.selectedIndex]) {
					selectModel(results[dropdownState.selectedIndex]);
				} else if (props.model.trim()) {
					selectModel({ id: props.model.trim(), name: props.model.trim() });
				}
				break;
			case 'Escape':
				setDropdownState({ showDropdown: false, searchResults: [], selectedIndex: -1 });
				break;
		}
	}

	function handleBlur() {
		setTimeout(() => setDropdownState({ showDropdown: false, searchResults: [], showingRecent: false, selectedIndex: -1 }), 150);
	}

	function modelFocus(e: FocusEvent) {
		(e.target as HTMLInputElement).select();
		if (props.provider === 'zai') {
			setDropdownState({ searchResults: ZAI_MODELS, showDropdown: true, showingRecent: false, selectedIndex: -1 });
		} else if (props.provider === 'anth_local') {
			setDropdownState({ searchResults: ANTH_LOCAL_MODELS, showDropdown: true, showingRecent: false, selectedIndex: -1 });
		} else {
			const providerRecentModels = dropdownState.recentModels.filter(m => m.provider === props.provider);
			setDropdownState({ showingRecent: true, showDropdown: providerRecentModels.length > 0, selectedIndex: -1 });
		}
	}

	function handleProviderChange(e: Event) {
		const newProvider = (e.target as HTMLSelectElement).value as Provider;
		props.setProvider(newProvider);
		if (props.autoPickOnProviderChange === false) return;
		const providerRecentModels = dropdownState.recentModels.filter(m => m.provider === newProvider);
		if (providerRecentModels.length > 0) props.setModel(providerRecentModels[0].id);
		else if (newProvider === 'zai' && ZAI_MODELS.length > 0) props.setModel(ZAI_MODELS[0].id);
		else if (newProvider === 'anth_local' && ANTH_LOCAL_MODELS.length > 0) props.setModel(ANTH_LOCAL_MODELS[0].id);
	}

	return (
		<>
			<select
				ref={el => createEffect(() => {
					void props.providers;
					const p = props.provider;
					queueMicrotask(() => (el.value = p));
				})}
				onInput={handleProviderChange}
				title='Select API provider'
				style={props.compact ? 'width: 110px;' : undefined}
			>
				<For each={Object.entries(props.providers).filter(([, cfg]) => cfg.enabled)}>
					{([key, cfg]) => <option value={key}>{cfg.name || (providerNames as Record<string, string>)[key] || key}</option>}
				</For>
			</select>
			<div class='modelSearchContainer' ref={containerRef} style={props.compact ? 'flex: 1;' : undefined}>
				<input
					onInput={handleModelInput}
					onKeyDown={handleKeyDown}
					onBlur={handleBlur}
					onFocus={modelFocus}
					value={props.model}
					class='model-picker'
					placeholder='Search for a model...'
					style={props.compact ? 'width: auto;' : undefined}
				/>
				<Show when={dropdownState.showDropdown}>
					<Portal mount={document.body}>
						<div class='modelDropdown' style={dropdownPosition()}>
							<div class='dropHeader'>
								{dropdownState.showingRecent ? 'Recent Models' : 'Search Results'}
							</div>
							<For each={dropdownState.showingRecent ? dropdownState.recentModels.filter(m => m.provider === props.provider) : dropdownState.searchResults}>
								{(model, index) => (
									<div classList={{ modelDropdownItem: true, modelDropdownItemSelected: index() === dropdownState.selectedIndex }}
										onMouseDown={() => selectModel(model)}
										onMouseEnter={() => setDropdownState('selectedIndex', index())}
									>
										<div class='modelName'>{model.name || model.id}</div>
										<div class='modelDescription'>{model.description}</div>
									</div>
								)}
							</For>
						</div>
					</Portal>
				</Show>
			</div>
		</>
		);
	}
