import { createEffect, createSignal, Index, For, on, Show, type Setter } from 'solid-js';
import { DEFAULT_AGENT_SETTINGS, type AgentModelRef, type AgentPreset, type AgentSelfSettings, type AgentSettings, type Options, type Provider, type ProviderConfig, type ToolMode } from './types';
import { tools } from './tools';
import { ModelPicker } from './ModelPicker';
import { Modal, ReasoningControls } from './Comps';
import { SamplerFieldsRow } from './PromptManager';
import { modelLabel, providerLabel } from './modelCatalog';
import { TbOutlineTrashX, TbOutlinePlus, TbOutlineSettings2 } from 'solid-icons/tb';

const AGENT_TIERS = ['lite', 'medium', 'ultra'] as const;
type AgentTier = typeof AGENT_TIERS[number];

type Editing = { tier: AgentTier } | { preset: number } | null;

export function AgentManager(props: {
	settings: AgentSettings,
	setSettings: Setter<AgentSettings>,
	configName: string,
	presets: AgentPreset[],
	setPresets: (presets: AgentPreset[]) => void,
	providers: Record<Provider, ProviderConfig>,
}) {
	// Preset tool selection excludes tools agents can't have
	const presetTools = tools.filter(t => t.function.name !== 'spawn_agent');

	const [editing, setEditing] = createSignal<Editing>(null);
	const [editingSelf, setEditingSelf] = createSignal(false);
	const self = (): AgentSelfSettings => props.settings.self ?? DEFAULT_AGENT_SETTINGS.self!;
	const updSelf = (patch: Partial<AgentSelfSettings>): void => {
		props.setSettings(prev => ({ ...prev, self: { ...self(), ...patch } }));
	};
	// A freshly picked custom source has no model yet, which is indistinguishable from 'self' in the preset itself
	const [pickingCustom, setPickingCustom] = createSignal<Record<number, boolean>>({});
	createEffect(on(() => props.configName, () => {
		setEditing(null);
		setPickingCustom({});
	}, { defer: true }));

	const updTier = (tier: AgentTier, patch: Partial<AgentModelRef>): void => {
		props.setSettings(prev => ({ ...prev, models: { ...prev.models, [tier]: { ...prev.models[tier], ...patch } } }));
	};
	const updPreset = (i: number, patch: Partial<AgentPreset>): void => {
		props.setPresets(props.presets.map((p, j) => j === i ? { ...p, ...patch } : p));
	};

	const isTier = (m: string) => AGENT_TIERS.includes(m as AgentTier);
	const modelSource = (i: number, preset: AgentPreset) => {
		const m = preset.model.trim();
		if (isTier(m)) return m;
		if (m && m !== 'self') return 'custom';
		return pickingCustom()[i] ? 'custom' : 'self';
	};
	const delPreset = (i: number): void => {
		props.setPresets(props.presets.filter((_, j) => j !== i));
		// Indices above the removed one shift down
		setPickingCustom(prev => Object.fromEntries(
			Object.entries(prev).filter(([k]) => Number(k) !== i).map(([k, v]) => [Number(k) > i ? Number(k) - 1 : Number(k), v])
		));
		const e = editing();
		if (e && 'preset' in e) {
			if (e.preset === i) setEditing(null);
			else if (e.preset > i) setEditing({ preset: e.preset - 1 });
		}
	};

	// ── Shared editor state (tier and preset edit the same override fields) ──

	const editorObj = (): Partial<AgentModelRef & AgentPreset> | undefined => {
		const e = editing();
		if (!e) return undefined;
		return 'preset' in e ? props.presets[e.preset] : props.settings.models[e.tier];
	};
	const patchObj = (patch: Partial<AgentModelRef & AgentPreset>): void => {
		const e = editing();
		if (!e) return;
		if ('preset' in e) updPreset(e.preset, patch);
		else updTier(e.tier, patch);
	};
	const setSamplerField = (key: keyof Options, raw: string): void => {
		const obj = editorObj();
		const num = Number(raw);
		const next = { ...(obj?.samplers ?? {}) } as Record<string, number>;
		if (raw === '' || isNaN(num)) delete next[key];
		else next[key] = num;
		const patch: Partial<AgentPreset> = {};
		if (Object.keys(next).length) patch.samplers = next;
		else delete patch.samplers;
		patchObj(patch);
	};

	const modelSummary = (provider: Provider, model: string) => model.trim()
		? <>{modelLabel(provider, model.trim())} <span class='modelProviderTag'>{providerLabel(provider, props.providers)}</span></>
		: 'not set';

	const presetSummary = (preset: AgentPreset) => {
		const m = preset.model.trim();
		if (!m || m === 'self') return 'self';
		if (isTier(m)) {
			const ref = props.settings.models[m as AgentTier];
			return ref?.model.trim() ? <>{m}: {modelSummary(ref.provider, ref.model)}</> : `${m} (not configured)`;
		}
		return modelSummary(preset.provider || 'or', m);
	};

	const rowStyle = 'display: flex; gap: 6px; align-items: center;';
	const nameStyle = 'opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
	const detailStyle = 'flex: 1; text-align: right; opacity: 0.55; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

	return (
		<details class='sidebar-section'>
			<summary>
				<span class='sidebar-section-title'>Agents</span>
				<span style='font-family: var(--font-ui); opacity: 0.5; font-size: 0.85em; margin-left: 8px;'>
					spawn_agent models &amp; presets
				</span>
			</summary>
			<div class='promptManager'>
				<div style={rowStyle}>
					<span style={nameStyle}>self</span>
					<span style={detailStyle}>same model as chat</span>
					<button class='slim-but' onClick={() => setEditingSelf(true)} title='Self settings'>
						<TbOutlineSettings2 size={14} />
					</button>
				</div>
				<For each={AGENT_TIERS}>
					{tier => (
						<div style={rowStyle}>
							<span style={nameStyle}>{tier}</span>
							<span style={detailStyle}>{modelSummary(props.settings.models[tier].provider, props.settings.models[tier].model)}</span>
							<button class='slim-but' onClick={() => setEditing({ tier })} title='Tier settings'>
								<TbOutlineSettings2 size={14} />
							</button>
						</div>
					)}
				</For>

				<strong style='opacity: 0.6; margin-top: 8px'>Presets</strong>
				<Index each={props.presets}>
					{(preset, i) => (
						<div style={rowStyle}>
							<span style={nameStyle} title={preset().description}>
								{preset().name || 'unnamed'}
							</span>
							<span style={detailStyle}>{presetSummary(preset())}</span>
							<button class='slim-but' onClick={() => setEditing({ preset: i })} title='Preset settings'>
								<TbOutlineSettings2 size={14} />
							</button>
						</div>
					)}
				</Index>
				<button
					style='margin-top: 4px;'
					onClick={() => {
						const idx = props.presets.length;
						props.setPresets([...props.presets, { name: 'new-preset', description: '', model: '', prompt: '' }]);
						setEditing({ preset: idx });
					}}
				>
					<TbOutlinePlus size={14} /> Add preset
				</button>
				<div style='font-size: 0.8em; opacity: 0.5; margin-top: 2px;'>
					Tier models and self settings are global. Presets belong to the active config and bundle a prompt, model and tools under a name the model can call.
				</div>
			</div>

			<Show when={editingSelf()}>
				<Modal title='self' classes='agent-modal' onClose={() => setEditingSelf(false)}>
					<div class='sidebar-note'>Agents on the chat's own model also inherit its reasoning and samplers.</div>
					<label>
						<input
							type='checkbox'
							checked={self().inheritPrompt}
							onInput={ev => updSelf({ inheritPrompt: ev.currentTarget.checked })}
						/>
						<span>Inherit parent's prompts</span>
					</label>
					<strong style='opacity: 0.6'>System prompt</strong>
					<textarea
						class='prompt'
						rows={4}
						disabled={self().inheritPrompt}
						placeholder='System prompt for self agents (empty = none)'
						value={self().prompt}
						onInput={ev => updSelf({ prompt: ev.currentTarget.value })}
					/>
				</Modal>
			</Show>

			<Show when={editing()} keyed>
				{(e) => {
					const isPreset = 'preset' in e;
					const presetIdx = isPreset ? e.preset : -1;
					// Live view of the edited object, not a snapshot — keyed Show children are untracked,
					// so only re-reading via this accessor keeps template expressions fresh after patches
					const obj = () => editorObj() ?? {};
					return (
						<Modal title={isPreset ? `Preset: ${props.presets[presetIdx]?.name || 'unnamed'}` : `${e.tier} tier`} classes='agent-modal' onClose={() => setEditing(null)}>
							<Show when={isPreset}>
								<label>Name
									<input type='text' value={obj().name ?? ''} onInput={ev => patchObj({ name: ev.currentTarget.value })} />
								</label>
								<label title='Shown to the model in the tool description'>Description
									<input type='text' placeholder='e.g. reviews code changes for bugs' value={obj().description ?? ''} onInput={ev => patchObj({ description: ev.currentTarget.value })} />
								</label>
								<label title='Where this preset gets its model from'>Model source
									<select
										value={modelSource(presetIdx, props.presets[presetIdx])}
										onInput={ev => {
											const v = ev.currentTarget.value;
											const preset = props.presets[presetIdx];
											setPickingCustom(prev => ({ ...prev, [presetIdx]: v === 'custom' }));
											if (v !== 'custom') patchObj({ model: v });
											else patchObj({
												provider: preset.provider ?? 'or',
												...(!preset.model.trim() || isTier(preset.model.trim()) || preset.model.trim() === 'self' ? { model: '' } : {}),
											});
										}}
									>
										<option value='self'>self (same as chat)</option>
										<option value='lite'>lite</option>
										<option value='medium'>medium</option>
										<option value='ultra'>ultra</option>
										<option value='custom'>custom…</option>
									</select>
								</label>
								<Show when={modelSource(presetIdx, props.presets[presetIdx]) === 'custom'}>
									<div style='margin-left: 12px;'>
										<ModelPicker
											compact
											provider={obj().provider || 'or'}
											model={obj().model ?? ''}
											onChange={(p, m) => patchObj({ provider: p, model: m })}
											providers={props.providers}
										/>
									</div>
								</Show>
							</Show>

							<Show when={!isPreset}>
								<ModelPicker
									compact
									provider={obj().provider || 'or'}
									model={obj().model ?? ''}
									onChange={(p, m) => patchObj({ provider: p, model: m })}
									providers={props.providers}
								/>
							</Show>

							<strong style='opacity: 0.6'>System prompt</strong>
							<textarea
								class='prompt'
								rows={4}
								placeholder={isPreset ? 'System prompt (empty = inherit chat prompts)' : 'System prompt for this tier (empty = inherit chat prompts)'}
								value={obj().prompt ?? ''}
								onInput={ev => patchObj({ prompt: ev.currentTarget.value })}
							/>

							<strong style='opacity: 0.6'>Reasoning</strong>
							<div class='sidebar-group'>
								<ReasoningControls
									reasoning={obj().reasoning}
									preserveReasoning={obj().preserveReasoning}
									reasoningPrefill={obj().reasoningPrefill}
									setReasoning={r => patchObj({ reasoning: r })}
									setPreserveReasoning={p => patchObj({ preserveReasoning: p })}
									setPrefill={patch => patchObj({ reasoningPrefill: { ...(obj().reasoningPrefill ?? { enabled: false, content: '' }), ...patch } })}
								/>
							</div>

							<strong style='opacity: 0.6'>Samplers</strong>
							<div class='sidebar-note' style='margin-bottom: 2px;'>Unset fields are not sent (provider default).</div>
							<SamplerFieldsRow values={obj().samplers ?? {}} setField={setSamplerField} />

							<label>
								<input
									type='checkbox'
									checked={obj().tools !== undefined}
									onInput={ev => patchObj({ tools: ev.currentTarget.checked ? {} : undefined })}
								/>
								<span>Custom tools (off = inherit chat tools)</span>
							</label>
							<Show when={obj().tools}>
								<div class='agent-tools'>
									<For each={presetTools}>
										{tool => (
											<label>
												<input
													type='checkbox'
													checked={obj().tools?.[tool.function.name] === true}
													onInput={ev => patchObj({ tools: { ...obj().tools, [tool.function.name]: ev.currentTarget.checked } })}
												/>
												<span>{tool.function.name}</span>
											</label>
										)}
									</For>
								</div>
							</Show>
							<label title={'Native: each tool on its own\nBatched: one `run` tool whose calls are grouped into ordered steps\nrun_js only: tools are functions inside run_js'}>Tool calls
								<select
									value={obj().toolMode ?? ''}
									onInput={ev => patchObj({ toolMode: (ev.currentTarget.value || undefined) as ToolMode | undefined })}>
									<option value=''>Same as chat</option>
									<option value='native'>Native</option>
									<option value='run'>Batched</option>
									<option value='js'>run_js only</option>
								</select>
							</label>
							<label>Max turns
								<input
									type='number'
									min='1'
									max='250'
									style='width: 70px;'
									placeholder='30'
									value={obj().maxTurns ?? ''}
									onInput={ev => patchObj({ maxTurns: ev.currentTarget.value ? Number(ev.currentTarget.value) : undefined })}
								/>
						</label>
						<Show when={isPreset}>
							<button class='slim-but red'
								onMouseDown={ev => {
									if (ev.detail === 2 || ev.shiftKey) { delPreset(presetIdx); return; }
									const btn = ev.currentTarget;
									btn.classList.add('shake');
									setTimeout(() => btn.classList.remove('shake'), 300);
								}}
								title='Shift+Click or Double-Click to delete'>
								<TbOutlineTrashX size={14} color='red' /> Delete preset
							</button>
						</Show>
						</Modal>
					);
				}}
			</Show>
		</details>
	);
}
