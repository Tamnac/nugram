export interface TextDrip {
	push(text: string): void;
	flush(): Promise<void>;
}

/**
 * Buffers incoming text and releases it at a steady rate for smooth streaming.
 * @param onText callback receiving each chunk of text to render
 * @param getWeight optional callback returning a weight for frame-skip calculation (e.g. message count)
 *
 * Larger chunks when page blurred. When hidden, doesn't render - buffer dumped at flush() or on refocus.
 */
export function createTextDrip(onText: (text: string) => void, getWeight?: () => number): TextDrip {
	let buffer = '';
	let rafId = 0;
	let draining = false;
	let frameCount = 0;
	let onDrained: (() => void) | null = null;
	let charsPerTick = 2;
	let lastPushTime = 0;
	let lastBlurEmit = 0;

	function onVisible() {
		document.removeEventListener('visibilitychange', onVisible);
		schedule();
	}

	function schedule() {
		if (buffer.length === 0) return;
		if (document.hidden) {
			document.addEventListener('visibilitychange', onVisible);
			return;
		}
		if (!draining) {
			draining = true;
			rafId = requestAnimationFrame(drain);
		}
	}

	function drain() {
		if (buffer.length === 0) {
			draining = false;
			onDrained?.();
			onDrained = null;
			return;
		}
		// Hidden: stop the loop, resolve any pending flush, wait for refocus
		if (document.hidden) {
			draining = false;
			const chunk = buffer;
			buffer = '';
			onText(chunk);
			onDrained?.();
			onDrained = null;
			schedule();
			return;
		}
		rafId = requestAnimationFrame(drain);
		const skip = Math.max(1, Math.floor((getWeight?.() ?? 0) / 4000));
		if (++frameCount % skip !== 0) return;
		// Nobody's watching: dump the whole buffer at most once per second
		if (!document.hasFocus()) {
			const now = performance.now();
			if (now - lastBlurEmit < 800) return;
			lastBlurEmit = now;
			const chunk = buffer;
			buffer = '';
			onText(chunk);
			return;
		}
		// Use rate derived from incoming speed; flush remainder in ≤5 ticks when no new data arrives
		const stale = performance.now() - lastPushTime > 1000;
		// Fast streams: release whole lines at once to avoid visual busyness
		if (charsPerTick > 3) {
			const lastNl = buffer.lastIndexOf('\n');
			if (lastNl !== -1) {
				const chunk = buffer.slice(0, lastNl + 1);
				buffer = buffer.slice(lastNl + 1);
				onText(chunk);
			} else if (stale || buffer.length > 300) {
				const chunk = buffer;
				buffer = '';
				onText(chunk);
			}
		} else {
			const chars = stale ? Math.max(charsPerTick, Math.ceil(buffer.length / 5)) : charsPerTick;
			const chunk = buffer.slice(0, chars);
			buffer = buffer.slice(chars);
			onText(chunk);
		}
	}

	return {
		push(text: string) {
			const now = performance.now();
			// Estimate a smooth per-tick drain rate from incoming data speed (~60fps = 16ms/tick)
			if (lastPushTime > 0) {
				const dt = now - lastPushTime;
				if (dt > 0) {
					const incomingPerMs = text.length / dt;
					// Smooth toward incoming rate
					charsPerTick = Math.max(1, Math.round(charsPerTick * 0.5 + incomingPerMs * 16 * 0.5));
				}
			}
			lastPushTime = now;
			buffer += text;
			schedule();
		},
		flush() {
			document.removeEventListener('visibilitychange', onVisible);
			if (buffer.length === 0) return Promise.resolve();
			if (document.hidden) {
				const chunk = buffer;
				buffer = '';
				onText(chunk);
				return Promise.resolve();
			}
			schedule();
			return new Promise<void>(resolve => { onDrained = resolve; });
		}
	};
}
