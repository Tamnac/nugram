import { For, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from 'solid-js';
import { chunkAtOffset, chunkRange, ESTIMATED_MESSAGE_HEIGHT, MESSAGE_CHUNK_SIZE } from './windowGeometry';

export interface MessageWindowController {
	jump: (index: number) => void;
}

export function MessageWindow<T>(props: {
	messages: T[];
	container: HTMLDivElement;
	controller: (controller: MessageWindowController) => void;
	deferResizeUpdates?: boolean;
	children: (start: number, end: () => number) => JSX.Element;
}) {
	const count = () => Math.ceil(props.messages.length / MESSAGE_CHUNK_SIZE);
	const [range, setRange] = createSignal<[number, number]>([0, 0]);
	const [revision, setRevision] = createSignal(0);
	const heights = new Map<number, number>();
	const elements = new Map<number, HTMLDivElement>();
	let top!: HTMLDivElement;
	let observer: ResizeObserver | undefined;
	let frame = 0;
	let jumping = false;
	let previousFirst: T | undefined;
	let previousLength = 0;
	let previousWidth = 0;
	let readingAnchor: { element: HTMLElement; offset: number } | undefined;
	let wasAtBottom = false;

	function rememberPosition() {
		const container = props.container;
		const viewport = container.getBoundingClientRect();
		wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 2;
		const element = Array.from(container.querySelectorAll<HTMLElement>('[data-message-index]'))
			.find(el => el.getBoundingClientRect().bottom > viewport.top);
		readingAnchor = element ? { element, offset: element.getBoundingClientRect().top - viewport.top } : undefined;
	}

	const sizes = createMemo(() => {
		revision();
		return Array.from({ length: count() }, (_, i) => heights.get(i)
			?? Math.min(MESSAGE_CHUNK_SIZE, props.messages.length - i * MESSAGE_CHUNK_SIZE) * ESTIMATED_MESSAGE_HEIGHT);
	});
	const sum = (start: number, end: number) => sizes().slice(start, end).reduce((a, b) => a + b, 0);
	const chunks = createMemo(() => Array.from({ length: Math.max(0, range()[1] - range()[0]) }, (_, i) => range()[0] + i));

	function measure() {
		let changed = false;
		for (const [index, element] of elements) {
			const height = element.getBoundingClientRect().height;
			if (heights.get(index) !== height) {
				heights.set(index, height);
				changed = true;
			}
		}
		if (changed) setRevision(r => r + 1);
	}

	function preservePosition(change: () => void) {
		const container = props.container;
		const viewport = container.getBoundingClientRect();
		const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 2;
		const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-message-index]'))
			.find(el => el.getBoundingClientRect().bottom > viewport.top);
		const offset = anchor?.getBoundingClientRect().top;
		change();
		if (!atBottom && anchor?.isConnected && offset !== undefined) {
			const adjustment = anchor.getBoundingClientRect().top - offset;
			if (adjustment !== 0) container.scrollTop += adjustment;
		}
	}

	function protectInteractions(start: number, end: number): [number, number] {
		const selection = window.getSelection();
		for (const [index, element] of elements) {
			if (element.querySelector('textarea') || element.contains(document.activeElement)
				|| (selection && !selection.isCollapsed && (element.contains(selection.anchorNode) || element.contains(selection.focusNode)))) {
				start = Math.min(start, index);
				end = Math.max(end, index + 1);
			}
		}
		return [start, end];
	}

	function update() {
		frame = 0;
		if (jumping || !count()) return;

		preservePosition(() => {
			measure();
			const viewport = props.container.getBoundingClientRect();
			const offset = viewport.top - top.getBoundingClientRect().top;
			const first = chunkAtOffset(sizes(), offset);
			const last = chunkAtOffset(sizes(), offset + props.container.clientHeight);
			const [currentStart, currentEnd] = range();
			const nearEdge = first <= currentStart || last >= currentEnd - 1 || currentEnd - currentStart > last - first + 4;
			
			let [start, end] = nearEdge ? chunkRange(first, last, count()) : range();
			[start, end] = protectInteractions(start, end);
			if (start !== range()[0] || end !== range()[1]) {
				setRange([start, end]);
				measure();
			}
		});
		rememberPosition();
	}

	function schedule() {
		if (!frame) frame = requestAnimationFrame(update);
	}

	props.controller({ jump(index) {
		if (index < 0 || index >= props.messages.length) return;
		jumping = true;
		measure();
		const chunk = Math.floor(index / MESSAGE_CHUNK_SIZE);
		setRange(protectInteractions(...chunkRange(chunk, chunk, count())));
		measure();
		props.container.querySelector(`[data-message-index="${index}"]`)?.scrollIntoView({ block: 'center' });
		jumping = false;
		schedule();
	} });

	createEffect(() => {
		if (!props.deferResizeUpdates) schedule();
	});

	createEffect(() => {
		const first = props.messages[0];
		const length = props.messages.length;
		untrack(() => {
			if (first !== previousFirst || !length) {
				heights.clear();
				setRevision(r => r + 1);
				setRange([Math.max(0, count() - 2), count()]);
			} else if (length !== previousLength) {
				heights.delete(Math.floor(Math.min(length, previousLength) / MESSAGE_CHUNK_SIZE));
				setRevision(r => r + 1);
				const [start, end] = range();
				setRange([Math.min(start, Math.max(0, count() - 1)), end === Math.ceil(previousLength / MESSAGE_CHUNK_SIZE) ? count() : Math.min(end, count())]);
			}
			previousFirst = first;
			previousLength = length;
			schedule();
		});
	});

	onMount(() => {
		previousWidth = props.container.clientWidth;
		observer = new ResizeObserver(() => {
			const container = props.container;
			const widthChanged = container.clientWidth !== previousWidth;
			if (widthChanged) {
				previousWidth = container.clientWidth;
				// Offscreen measurements remain provisional until those chunks mount again.
				if (wasAtBottom) container.scrollTop = container.scrollHeight;
				else if (readingAnchor?.element.isConnected)
					container.scrollTop += readingAnchor.element.getBoundingClientRect().top - container.getBoundingClientRect().top - readingAnchor.offset;
			}
			if (widthChanged || !props.deferResizeUpdates) schedule();
		});

		observer.observe(props.container);
		for (const element of elements.values()) observer.observe(element);
		props.container.addEventListener('scroll', schedule, { passive: true });
		props.container.addEventListener('focusout', schedule);
		document.addEventListener('selectionchange', schedule);
	});

	onCleanup(() => {
		cancelAnimationFrame(frame);
		observer?.disconnect();
		props.container.removeEventListener('scroll', schedule);
		props.container.removeEventListener('focusout', schedule);
		document.removeEventListener('selectionchange', schedule);
	});

	return <>
		<div ref={top} aria-hidden='true' style={{ height: `${sum(0, range()[0])}px` }} />
		<For each={chunks()}>{index => {
			let element!: HTMLDivElement;
			onCleanup(() => {
				observer?.unobserve(element);
				elements.delete(index);
			});
			return <div class='messageChunk' ref={el => {
				element = el;
				elements.set(index, el);
				observer?.observe(el);
			}}>
				{props.children(index * MESSAGE_CHUNK_SIZE, () => Math.min(props.messages.length, (index + 1) * MESSAGE_CHUNK_SIZE))}
			</div>;
		}}</For>
		<div aria-hidden='true' style={{ height: `${sum(range()[1], count())}px` }} />
	</>;
}
