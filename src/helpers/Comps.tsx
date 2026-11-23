import { createResource, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { imageSrc } from "./attachments";
import type { Options, PreserveReasoning } from "./types";
import { TbOutlineSettings2, TbOutlineX } from "solid-icons/tb";


export function TSeg(props: {
	options: Record<string, string>,
	selected: string,
	setSelected: (key: string) => any,
	tooltips?: Record<string, string>,
}) {
	return (
		<div class="tseg-container">
			<For each={Object.entries(props.options)}>
				{([key, displayName], i) => (
					<button
						class={`tseg-button ${key === props.selected ? 'tseg-button-selected' : ''}`}
						onClick={() => props.setSelected(key)}
						title={props.tooltips?.[key]}
					>
						{displayName}
					</button>
				)}
			</For>
		</div>
	)
}

/** A message image: attachment id or literal url, resolved lazily. Click to enlarge. */
export function ChatImage(props: { src: string, onRemove?: (() => void) | undefined, label?: string | undefined }) {
	const [url] = createResource(() => props.src, imageSrc);
	const [full, setFull] = createSignal(false);

	return (
		<div class="chatImage" classList={{ chatImageFull: full() }}>
			<Show when={url()} fallback={<div class="chatImagePending" />}>
				<img src={url()} alt="attachment" onClick={e => { e.stopPropagation(); setFull(f => !f); }} />
			</Show>
			<Show when={props.label}>
				<span class="chatImageLabel" title="The model sees this image with this label">{props.label}</span>
			</Show>
			<Show when={props.onRemove}>
				<button class="chatImageRemove" title="Remove image" onClick={() => props.onRemove!()}>×</button>
			</Show>
		</div>
	)
}

/**
 * Reasoning effort / preserve / prefill controls, shared by the sidebar, agent settings and the titler.
 * Preserve and prefill are hidden when their setter is omitted (no history to resend).
 */
export function ReasoningControls(props: {
	/** Value the agent/chat currently uses when nothing is set. */
	reasoning: Options['reasoning'] | undefined,
	preserveReasoning?: PreserveReasoning | undefined,
	reasoningPrefill?: { enabled: boolean; content: string } | undefined,
	setReasoning: (r: Options['reasoning']) => void,
	setPreserveReasoning?: (p: PreserveReasoning) => void,
	setPrefill?: (patch: Partial<{ enabled: boolean; content: string }>) => void,
}) {
	return (
		<>
			<div class='setting-row wide' title="Reasoning effort level">
				<span>Effort</span>
				<TSeg
					options={{ none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }}
					selected={props.reasoning?.effort || 'none'}
					setSelected={v => props.setReasoning({ effort: v as 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' })}
				/>
			</div>

			<Show when={props.setPreserveReasoning}>
				<div class='setting-row' title="Send earlier reasoning back to the model. Interleaved: the provider decides what to keep. Clipped: like interleaved, for the last 5 messages only. Full: ask the provider to keep all of it (ZAI/Fireworks/Neuralwatt)">
					<span>Preserve</span>
					<TSeg options={{ off: 'Off', interleaved: 'Interleaved', clipped: 'Clipped', full: 'Full' }}
						selected={props.preserveReasoning || 'interleaved'}
						setSelected={v => props.setPreserveReasoning!(v as PreserveReasoning)}
						tooltips={{off: "Don't send any reasoning", interleaved: "Send all reasoning; the provider keeps what the model expects, usually since the last user message or around tool calls", clipped: "Like interleaved, but only the last 5 messages keep their reasoning", full: "All reasoning, on providers that support it"}}/>
				</div>
			</Show>

			<Show when={props.setPrefill}>
				<label>
					<span>Prefill</span>
					<input
						type='checkbox'
						checked={props.reasoningPrefill?.enabled ?? false}
						onInput={e => props.setPrefill!({ enabled: e.target.checked })}
					/>
				</label>
				<Show when={props.reasoningPrefill?.enabled}>
					<textarea
						class='prompt'
						placeholder="Enter reasoning template here..."
						value={props.reasoningPrefill?.content ?? ''}
						onInput={e => props.setPrefill!({ content: e.target.value })}
						rows={4}
					/>
				</Show>
			</Show>
		</>
	);
}

/** Row in a settings list: a name, a dim summary, and an optional gear that opens its editor. */
export function SettingsRow(props: {
	label: string,
	detail?: JSX.Element,
	title?: string,
	settingsTitle?: string,
	onSettings?: () => void,
}) {
	return (
		<div class="settings-row">
			<span class="settings-row-label" title={props.title}>{props.label}</span>
			<span class="settings-row-detail">{props.detail}</span>
			<Show when={props.onSettings}>
				<button class="slim-but" onClick={() => props.onSettings?.()} title={props.settingsTitle ?? 'Settings'}>
					<TbOutlineSettings2 size={14} />
				</button>
			</Show>
		</div>
	);
}

/** Centered dialog over a click-to-close backdrop. Esc closes. */
export function Modal(props: { title: string, onClose: () => void, children: JSX.Element, canClose?: boolean, classes?: string, style?: string | JSX.CSSProperties | undefined }) {
	let dialog!: HTMLDivElement;
	const previousFocus = document.activeElement as HTMLElement | null;
	const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
		'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
	));
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && props.canClose !== false) props.onClose();
		if (e.key !== 'Tab') return;
		const items = focusable();
		const first = items[0];
		const last = items[items.length - 1];
		if (!first || !last) {
			e.preventDefault();
			dialog.focus();
		} else if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
			e.preventDefault();
			first.focus();
		}
	};
	onMount(() => (focusable()[0] ?? dialog).focus());
	window.addEventListener('keydown', onKey);
	onCleanup(() => {
		window.removeEventListener('keydown', onKey);
		previousFocus?.focus();
	});
	return (
		<Portal mount={document.body}>
			<div class='modal-overlay' onClick={e => { if (e.target === e.currentTarget && props.canClose !== false) props.onClose(); }}>
				<div ref={dialog} class={`modal-box ${props.classes ?? ''}`} role='dialog' aria-modal='true' aria-label={props.title} tabIndex={-1} style={props.style}>
					<div class='modal-header'>
						<span class='modal-title'>{props.title}</span>
						<button class='slim-but' onClick={props.onClose} disabled={props.canClose === false} title='Close'><TbOutlineX size={15} /></button>
					</div>
					<div class='modal-body'>{props.children}</div>
				</div>
			</div>
		</Portal>
	);
}