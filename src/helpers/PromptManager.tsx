import { For, Show, createSignal, Setter } from 'solid-js';
import { SetStoreFunction, produce } from 'solid-js/store';
import { Prompt, Config, Options, Role, Provider } from './types';
import { TbOutlineTrashX, TbOutlinePlus, TbOutlineDownload, TbOutlineUpload, TbOutlineEdit, TbOutlineCheck } from 'solid-icons/tb'
import { saveFileDialog, confirmDialog } from './platform';

/** Resolve samplers: global options + config model-sampler overrides for the current model. */
export function resolveModelSamplers(globalOptions: Options, config: Config | undefined, model: string): Options {
	if (!config?.modelSamplers?.length) return globalOptions;
	for (const entry of config.modelSamplers) {
		const { matches } = modelMatchesTrigger(entry.trigger, model);
		if (matches) return { ...globalOptions, ...entry.options };
	}
	return globalOptions;
}

/** Resolve final request options: base options + config reasoning/preservation + model samplers. */
export function resolveConfigOptions(globalOptions: Options, config: Config | undefined, model: string): Options {
	const resolved: Options = {
		...globalOptions,
		reasoning: config?.reasoning ?? { effort: 'none' },
		preserve_reasoning: config?.preserveReasoning ?? 'off',
	};
	return resolveModelSamplers(resolved, config, model);
}

export function modelMatchesTrigger(trigger: string | undefined, model: string): { matches: boolean; valid: boolean } {
	if (!trigger || trigger.trim() === '') return { matches: true, valid: true };
	try {
		const regex = new RegExp(trigger, 'i');
		return { matches: regex.test(model), valid: true };
	} catch (e) {
		return { matches: false, valid: false };
	}
}

interface STPromptEntry {
	identifier: string;
	name: string;
	system_prompt?: boolean;
	marker?: boolean;
	content?: string;
	role?: string;
	injection_position?: number; // 0 = before chat, 1 = relative to chat end
	injection_depth?: number;    // 0 = very last, N = N messages from end
	enabled?: boolean;
}

interface STPreset {
	prompts: STPromptEntry[];
	prompt_order?: { character_id: number; order: { identifier: string; enabled: boolean }[] }[];
}

/** Convert {{macro}} → @@macro for the app's substitution format */
function convertSTMacros(content: string): string {
	return content.replace(/\{\{(\w+)\}\}/g, '@@$1');
}

export function convertSTPreset(preset: STPreset): Prompt[] {
	// Build an order+enabled map from prompt_order (first entry, if present)
	const orderList = preset.prompt_order?.[0]?.order ?? [];
	const orderMap = new Map(orderList.map((o, idx) => [o.identifier, { enabled: o.enabled, idx }]));

	// Separate before-chat (injection_position=0) and after-chat (injection_position=1)
	// so we can sort before-chat by prompt_order rank and output them in that order.
	// The insertion algorithm processes equal-position prompts in reverse array order
	// (last in array → first to process → ends up pushed to back), so emitting them
	// in rank order means they arrive in rank order in the final prompt.
	const beforeChat: { prompt: STPromptEntry; rank: number; enabled: boolean }[] = [];
	const afterChat: { prompt: STPromptEntry; enabled: boolean }[] = [];

	for (const p of preset.prompts) {
		if (p.marker) continue;
		if (!p.content?.trim()) continue;
		const orderEntry = orderMap.get(p.identifier);
		const enabled = orderEntry?.enabled ?? p.enabled ?? true;
		if (p.injection_position === 1) {
			afterChat.push({ prompt: p, enabled });
		} else {
			// Use prompt_order rank to preserve logical ordering; fall back to
			// array position so prompts absent from prompt_order still get a rank.
			const rank = orderEntry?.idx ?? preset.prompts.indexOf(p);
			beforeChat.push({ prompt: p, rank, enabled });
		}
	}

	// Sort before-chat by rank so they appear in prompt_order sequence at position 0
	beforeChat.sort((a, b) => a.rank - b.rank);

	const results: Prompt[] = [];

	// Emit before-chat first (all position=0, in rank order)
	for (const { prompt: p, enabled } of beforeChat) {
		results.push({
			name: p.name,
			content: convertSTMacros(p.content!),
			role: (p.role ?? 'system') as Role,
			position: 0,
			enabled,
		});
	}

	// Emit after-chat (position relative to end): depth 0 = -1, depth N = -(N+1)
	for (const { prompt: p, enabled } of afterChat) {
		results.push({
			name: p.name,
			content: convertSTMacros(p.content!),
			role: (p.role ?? 'system') as Role,
			position: -((p.injection_depth ?? 0) + 1),
			enabled,
		});
	}

	return results;
}

// ── Config Selector ─────────────────────────────────────────────────────────

export function ConfigSelector(props: {
	configs: Config[],
	setConfigs: SetStoreFunction<Config[]>,
	activeConfigName: string,
	setActiveConfigName: Setter<string>,
	setError?: Setter<string | null> | undefined,
	setInfo?: Setter<string | null> | undefined,
	model: string
}) {
	const [renamingConfig, setRenamingConfig] = createSignal(false);
	const [renameValue, setRenameValue] = createSignal('');

	function createConfig() {
		const baseName = 'New Config';
		let name = baseName;
		let i = 1;
		while (props.configs.some(c => c.name === name)) {
			name = `${baseName} ${i++}`;
		}
		const newConfig: Config = { name, prompts: [] };
		props.setConfigs(props.configs.length, newConfig);
		props.setActiveConfigName(name);
	}

	async function deleteConfig() {
		if (props.configs.length <= 1) return; // always keep at least one
		if (!await confirmDialog(`Delete config "${props.activeConfigName}"? This cannot be undone. Please export before proceeding.`)) return;
		const idx = props.configs.findIndex(c => c.name === props.activeConfigName);
		if (idx < 0) return;
		props.setConfigs(prev => prev.filter((_, i) => i !== idx));
		// Switch to first remaining config
		const remaining = props.configs.filter(c => c.name !== props.activeConfigName);
		props.setActiveConfigName(remaining[0]?.name ?? 'Default');
	}

	function startRename() {
		setRenameValue(props.activeConfigName);
		setRenamingConfig(true);
	}

	function commitRename() {
		const newName = renameValue().trim();
		if (!newName || newName === props.activeConfigName) {
			setRenamingConfig(false);
			return;
		}
		if (props.configs.some(c => c.name === newName)) {
			props.setError?.(`Config "${newName}" already exists.`);
			setRenamingConfig(false);
			return;
		}
		const idx = props.configs.findIndex(c => c.name === props.activeConfigName);
		if (idx >= 0) {
			props.setConfigs(idx, 'name', newName);
			props.setActiveConfigName(newName);
		}
		setRenamingConfig(false);
	}

	async function exportConfig() {
		const activeIdx = props.configs.findIndex(c => c.name === props.activeConfigName);
		if (activeIdx < 0) return;
		const config = props.configs[activeIdx];
		await saveFileDialog(JSON.stringify(config, null, 2), `${config.name}.json`, [
			{ description: 'JSON files', extensions: ['.json'] },
		]);
	}

	// ── Import (native config format, native prompts array, or ST preset) ──

	function handleImportFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (ev) => {
			try {
				const parsed = JSON.parse(ev.target!.result as string);
				let incoming: Prompt[];
				let configName: string | undefined;
				let importedSamplers: Config['modelSamplers'] | undefined;

				if (parsed.name && Array.isArray(parsed.prompts) && parsed.prompts[0]?.content !== undefined) {
					// Native Config format — has name + prompts array with Prompt objects
					incoming = parsed.prompts as Prompt[];
					configName = parsed.name;
					if (Array.isArray(parsed.modelSamplers)) importedSamplers = parsed.modelSamplers;
				} else if (Array.isArray(parsed)) {
					// Native format — array of Prompt
					incoming = parsed as Prompt[];
				} else if (parsed.prompts && Array.isArray(parsed.prompts)) {
					// SillyTavern preset
					incoming = convertSTPreset(parsed as STPreset);
					configName = file.name.replace(/\.json$/i, '');
				} else {
					throw new Error('Unrecognised format: expected a Config object, an array of prompts, or a SillyTavern preset.');
				}

				// Validate minimally
				if (!incoming.every(p => typeof p.name === 'string' && typeof p.content === 'string')) {
					throw new Error('Invalid prompt data: each entry must have name and content strings.');
				}

				// Create a new config from imported data
				let name = configName ?? file.name.replace(/\.json$/i, '');
				let i = 1;
				const baseName = name;
				while (props.configs.some(c => c.name === name)) {
					name = `${baseName} (${i++})`;
				}

				const ng = (n: number) => n < 0 ? 10000 + n : n;
				incoming.sort((a, b) => ng(a.position) - ng(b.position));
				const newConfig: Config = { name, prompts: incoming, ...(importedSamplers?.length ? { modelSamplers: importedSamplers } : {}) };
				props.setConfigs(props.configs.length, newConfig);
				props.setActiveConfigName(name);
				props.setInfo?.(`Imported config "${name}" with ${incoming.length} prompts.`);
			} catch (err) {
				const msg = 'Import failed: ' + (err instanceof Error ? err.message : String(err));
				console.error(msg, err);
				props.setError?.(msg);
			}
			// Reset so the same file can be re-imported
			(e.target as HTMLInputElement).value = '';
		};
		reader.readAsText(file);
	}

	return (
		<div class='config-selector'>
			<div style='display: inline-flex; align-items: center; gap: 8px; width: 100%;'>
				<span style='font-family: var(--font-ui); font-weight: bold'>Config</span>
				<Show when={!renamingConfig()}>
					<select
						style='flex: 1; min-width: 80px;'
						value={props.activeConfigName}
						onChange={(e) => props.setActiveConfigName(e.target.value)}
					>
						<For each={props.configs}>
							{(config) => (
								<option value={config.name}>{config.name}</option>
							)}
						</For>
					</select>
				</Show>
				<Show when={renamingConfig()}>
					<input
						type='text'
						value={renameValue()}
						onInput={(e) => setRenameValue(e.target.value)}
						onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingConfig(false); }}
						style='flex: 1; min-width: 80px; font-size: 0.9em;'
						autofocus
					/>
					<button class='slim-but' onClick={() => commitRename()} title='Confirm rename'>
						<TbOutlineCheck size={14} />
					</button>
				</Show>
				<Show when={!renamingConfig()}>
					<button class='slim-but' onClick={() => startRename()} title='Rename config'>
						<TbOutlineEdit size={14} />
					</button>
					<button class='slim-but' onClick={() => createConfig()} title='New config'>
						<TbOutlinePlus size={14} />
					</button>
					<button class='slim-but red' disabled={props.configs.length <= 1}
						style={{ opacity: props.configs.length <= 1 ? 0.3 : 1, cursor: props.configs.length <= 1 ? 'not-allowed' : 'pointer' }}
						onClick={() => deleteConfig()}
						title='Delete config (keep at least one)'>
						<TbOutlineTrashX size={14} color='red' />
					</button>
				</Show>
			</div>
			<div class='config-selector-actions'>
				<button class='slim-but' onClick={exportConfig} title='Export active config as JSON'>
					<TbOutlineDownload size={14} /> Export
				</button>
				<label class='fake-but' title='Import config (native JSON, Config, or SillyTavern preset)' style='cursor: pointer;'>
					<TbOutlineUpload size={14} /> Import
					<input
						type='file'
						accept='.json'
						style='display: none;'
						onInput={handleImportFile}
					/>
				</label>
			</div>
		</div>
	);
}

// ── Prompt List ─────────────────────────────────────────────────────────────

export function PromptManager(props: {
	prompts: Prompt[],
	setPrompts: SetStoreFunction<Prompt[]>,
	model: string
}) {
	const [expandedIndex, setExpandedIndex] = createSignal<number | null>(null);

	const matchTrigger = (trigger: string | undefined) => modelMatchesTrigger(trigger, props.model);

	function addNewPrompt() {
		const newPrompt: Prompt = {
			name: "New Prompt",
			content: "",
			role: 'system',
			position: 0,
			enabled: true
		};
		props.setPrompts(props.prompts.length, newPrompt);
		setExpandedIndex(props.prompts.length - 1);
	}

	function removePrompt(originalIndex: number) {
		props.setPrompts(prev => prev.filter((_, i) => i !== originalIndex));
		setExpandedIndex(null);
	}

	function updatePrompt(index: number, field: keyof Prompt, value: any) {
		props.setPrompts(index, field, value);
	}

	return (
		<div class='config-prompt-list'>
			<For each={props.prompts}>
				{(prompt, idx) => {
					const isExpanded = () => expandedIndex() === idx();
					const triggerResult = () => matchTrigger(prompt.modelTrigger);
					const isActive = () => prompt.enabled && triggerResult().matches;

					return (
						<div class='prompt-accordion-item' classList={{ expanded: isExpanded() }}>
							{/* Collapsed row */}
							<div class='prompt-row' onClick={() => setExpandedIndex(isExpanded() ? null : idx())}>
								<input
									type='checkbox'
									checked={prompt.enabled}
									onClick={(e) => e.stopPropagation()}
									onInput={(e) => updatePrompt(idx(), 'enabled', e.target.checked)}
								/>
								<span class='prompt-name' classList={{ inactive: !isActive() }}>
									{prompt.name}
								</span>
								<Show when={prompt.modelTrigger}>
									<span class='prompt-trigger-badge' title={`Model trigger: ${prompt.modelTrigger}`}>
										{prompt.modelTrigger}
									</span>
								</Show>
								<span class='prompt-meta'>{prompt.role.slice(0, 3)}</span>
								<span class='prompt-meta'>{prompt.position}</span>
								<span class='prompt-chevron'>{isExpanded() ? '▾' : '▸'}</span>
							</div>

							{/* Expanded editor */}
							<Show when={isExpanded()}>
								<div class='prompt-editor'>
									<label>Name:
										<input
											type='text'
											value={prompt.name}
											onInput={(e) => updatePrompt(idx(), 'name', e.target.value)}
										/>
									</label>
									<div style='display: flex; gap: 8px; flex-wrap: wrap;'>
										<label>Role:
											<select
												value={prompt.role}
												onChange={(e) => updatePrompt(idx(), 'role', e.target.value as Role)}
											>
												{['system', 'user', 'assistant'].map(r =>
													<option value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
												)}
											</select>
										</label>
										<label>Position:
											<input
												type='number' max={20000} min={-20000}
												value={prompt.position}
												onInput={(e) => updatePrompt(idx(), 'position', Number(e.target.value))}
												style='width: 70px;'
											/>
										</label>
									</div>
									<label style='display: flex; align-items: center; gap: 8px; flex-wrap: wrap;'>
										<span>Model trigger:</span>
										<input
											type='text'
											value={prompt.modelTrigger ?? ''}
											onInput={(e) => updatePrompt(idx(), 'modelTrigger', e.target.value)}
											placeholder='e.g. claude|anthropic'
											style='flex: 1; min-width: 120px;'
										/>
										<Show when={prompt.modelTrigger}>
											{(() => {
												const r = triggerResult();
												if (!r.valid) return <span style='font-size: 0.8em; opacity: 0.6;'>(invalid)</span>;
												if (r.matches) return <span style='font-size: 0.8em; opacity: 0.6;'>(matches)</span>;
												return <span style='font-size: 0.8em; opacity: 0.6;'>(no match)</span>;
											})()}
										</Show>
									</label>
									<textarea
										class='prompt'
										value={prompt.content}
										onInput={(e) => updatePrompt(idx(), 'content', e.target.value)}
										style='width: 100%; min-height: 150px; max-height: 400px;'
									/>
									<button class='slim-but red' style='margin-top: 4px;'
										onMouseDown={(e) => {
											if (e.detail === 2) { removePrompt(idx()); return; }
											if (!e.shiftKey) {
												const btn = e.currentTarget;
												btn.classList.add('shake');
												setTimeout(() => btn.classList.remove('shake'), 300);
												return;
											}
											removePrompt(idx());
										}}
										title='Shift+Click or Double-Click to delete'>
											<TbOutlineTrashX size={14} color='red' /> Delete
										</button>
									</div>
								</Show>
							</div>
						);
					}}
				</For>

			{/* Bottom action bar */}
			<div class='prompt-actions'>
				<button class='slim-but' onClick={addNewPrompt} title='New prompt'>
					<TbOutlinePlus size={16} /> Add
				</button>
			</div>
		</div>
	);
}

// ── Sampling Parameters (global + per-model overrides) ─────────────────────

const SAMPLER_FIELDS: { key: keyof Options; label: string; step: string; min: string; max: string; title: string; global?: boolean }[] = [
	{ key: 'temperature', label: 'Temp', step: '0.05', min: '0', max: '2', title: 'Exaggerates the probability curve', global: true },
	{ key: 'top_p', label: 'Top P', step: '0.01', min: '0', max: '1', title: 'What %/1 of top tokens to consider', global: true },
	{ key: 'top_k', label: 'Top K', step: '1', min: '0', max: '1000', title: 'How many of the top tokens to consider', global: true },
	{ key: 'min_p', label: 'Min P', step: '0.01', min: '0', max: '1', title: 'Minimum probability threshold' },
	{ key: 'repetition_penalty', label: 'Rep Pen', step: '0.01', min: '0', max: '2', title: 'How much to penalize new tokens based on their existing frequency in the text', global: true },
];

export function SamplingParameters(props: {
	options: Options;
	setOptions: SetStoreFunction<Options>;
	provider: Provider;
	configs: Config[];
	setConfigs: SetStoreFunction<Config[]>;
	activeConfigName: string;
	model: string;
}) {
	function decimator(val: string): number | string {
		const num = Number(val);
		if (val.includes('.') && val.replaceAll('.', '') === num.toString()) return val;
		return num;
	}
	const configIdx = () => {
		const i = props.configs.findIndex(c => c.name === props.activeConfigName);
		return i >= 0 ? i : 0;
	};
	const samplers = () => props.configs[configIdx()]?.modelSamplers ?? [];

	function addSampler() {
		const idx = configIdx();
		const existing = props.configs[idx].modelSamplers ?? [];
		props.setConfigs(idx, 'modelSamplers', [...existing, { trigger: '', options: {} }]);
	}

	function removeSampler(i: number) {
		const idx = configIdx();
		props.setConfigs(idx, 'modelSamplers', prev => prev!.filter((_, j) => j !== i));
	}

	function updateTrigger(i: number, value: string) {
		props.setConfigs(configIdx(), 'modelSamplers', i, 'trigger', value);
	}

	function updateField(i: number, key: keyof Options, raw: string) {
		const num = Number(raw);
		if (raw === '' || isNaN(num)) {
			props.setConfigs(configIdx(), 'modelSamplers', i, 'options', prev => {
				const next = { ...prev };
				delete (next as any)[key];
				return next;
			});
		} else {
			props.setConfigs(configIdx(), 'modelSamplers', i, 'options', key as any, num as any);
		}
	}

	function updateGlobalOption(key: keyof Options, raw: string) {
		if (raw === '') {
			props.setOptions(produce(o => { delete o[key]; }));
		} else {
			const value = key === 'top_k' ? Number(raw) : decimator(raw);
			props.setOptions(key as any, value as any);
		}
	}

	const globalFields = () => SAMPLER_FIELDS.filter(f => {
		if (!f.global) return false;
		if (f.key === 'top_k' || f.key === 'repetition_penalty') return props.provider === 'or';
		return true;
	});

	return (
	<details class='sidebar-section'>
		<summary>
			<span class='sidebar-section-title'>Samplers</span>
			<Show when={samplers().length > 0}>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>{samplers().length} overrides</span>
			</Show>
		</summary>

		<div class='sampler-global-row'>
			<For each={globalFields()}>
			{(field) => (
				<label class='sampler-field' title={field.title}>
					<span>{field.label}</span>
					<input
						type='number'
						step={field.step}
						min={field.min}
						max={field.max}
						value={(props.options as any)[field.key] ?? ''}
						onInput={e => updateGlobalOption(field.key, e.target.value)}
						placeholder='–'
					/>
				</label>
			)}
			</For>
		</div>

		<Show when={samplers().length > 0}>	<div class='model-samplers-list'>
			<For each={samplers()}>
			{(entry, i) => {
				const triggerResult = () => modelMatchesTrigger(entry.trigger, props.model);
				const isMatch = () => entry.trigger.trim() !== '' && triggerResult().matches;
				return (
					<div class='model-sampler-entry' classList={{ 'sampler-active': isMatch() }}>
						<div class='sampler-header'><span>Model Trigger</span>
							<input
								type='text'
								class='sampler-trigger-input'
								value={entry.trigger}
								onInput={e => updateTrigger(i(), e.target.value)}
								placeholder='e.g. claude.*'
							/>
							<Show when={entry.trigger.trim()}>
								{(() => {
									const r = triggerResult();
									if (!r.valid) return <span class='sampler-match-badge invalid'>✕</span>;
									if (r.matches) return <span class='sampler-match-badge match'>✓</span>;
									return <span class='sampler-match-badge'>–</span>;
								})()}
							</Show>
							<button class='slim-but red' onClick={() => removeSampler(i())} title='Remove sampler override'>
								<TbOutlineTrashX size={13} color='red' />
							</button>
						</div>
						<div class='sampler-fields'>
							<For each={SAMPLER_FIELDS}>
							{(field) => (
								<label class='sampler-field'>
									<span>{field.label}</span>
									<input
										type='number'
										step={field.step}
										min={field.min}
										max={field.max}
										value={(entry.options as any)[field.key] ?? ''}
										onInput={e => updateField(i(), field.key, e.target.value)}
										placeholder='–'
									/>
								</label>
							)}
							</For>
						</div>
					</div>
				);
			}}
			</For>
		</div> </Show>

		<button class='slim-but' onClick={addSampler} style='margin-top: 4px;'>
			<TbOutlinePlus size={14} /> Add override
		</button>
	</details>
	);
}
