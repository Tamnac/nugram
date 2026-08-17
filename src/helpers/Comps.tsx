import { createResource, createSignal, For, Show } from "solid-js";
import { imageSrc } from "./attachments";


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
export function ChatImage(props: { src: string, onRemove?: (() => void) | undefined }) {
	const [url] = createResource(() => props.src, imageSrc);
	const [full, setFull] = createSignal(false);

	return (
		<div class="chatImage" classList={{ chatImageFull: full() }}>
			<Show when={url()} fallback={<div class="chatImagePending" />}>
				<img src={url()} alt="attachment" onClick={() => setFull(f => !f)} />
			</Show>
			<Show when={props.onRemove}>
				<button class="chatImageRemove" title="Remove image" onClick={() => props.onRemove!()}>×</button>
			</Show>
		</div>
	)
}