import { createEffect, createSignal, Show } from 'solid-js';
import { TbOutlineX } from 'solid-icons/tb';
import { dockedWidget, mountWidget, undockWidget, widgetRegistry } from './widgets';

const MIN_WIDTH = 280;
const [width, setWidth] = createSignal(440);

function startResize(event: PointerEvent) {
	const handle = event.currentTarget as HTMLElement;
	handle.setPointerCapture(event.pointerId);
	const startX = event.clientX;
	const startWidth = width();
	const move = (e: PointerEvent) => setWidth(Math.min(window.innerWidth * 0.7, Math.max(MIN_WIDTH, startWidth + startX - e.clientX)));
	const stop = () => {
		handle.removeEventListener('pointermove', move);
		handle.removeEventListener('pointerup', stop);
		handle.removeEventListener('pointercancel', stop);
	};
	handle.addEventListener('pointermove', move);
	handle.addEventListener('pointerup', stop);
	handle.addEventListener('pointercancel', stop);
}

/** The side panel: the widget the user moved out of the message list. Beside the chat, an overlay on narrow windows. */
export function WidgetDock() {
	return (
		<Show when={dockedWidget()}>
			{spec => {
				let body!: HTMLDivElement;
				createEffect(() => {
					widgetRegistry();
					const { name, args, height } = spec();
					void mountWidget(body, name, args, height, true);
				});
				return (
					<aside class='widgetDock' style={{ '--dock-w': `${width()}px` }}>
						<div class='widgetDockResize' onPointerDown={startResize} />
						<header>
							<span class='widgetDockTitle'>{spec().name}</span>
							<button class='slim-but' title='Move back into the chat' onClick={undockWidget}><TbOutlineX size={16} /></button>
						</header>
						<div class='widgetDockBody' ref={body} />
					</aside>
				);
			}}
		</Show>
	);
}
