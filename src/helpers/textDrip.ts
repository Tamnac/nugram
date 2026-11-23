export interface TextDrip {
	push(text: string): void;
	flush(): Promise<void>;
}

const TICK_MS = 33;
/** Typical delay between text arriving and being shown in flow mode. Each tick releases the share of the backlog that keeps it near this. */
const LAG_MS = 300;
/** Lag used once no text has arrived for STALE_MS, or a flush is waiting, so the tail doesn't trickle out. */
const DRAIN_LAG_MS = 100;
const STALE_MS = 500;
const BLUR_INTERVAL_MS = 800;
/** Incoming rate (chars/s, roughly 40 tok/s) from which paragraphs are shown whole. */
const BLOCK_RATE = 160;
const RATE_WINDOW_MS = 1000;
/** Time to measure the rate before the first paragraph is shown. */
const MIN_RATE_SAMPLE_MS = 300;
/** A paragraph that hasn't ended after this long or this many chars is shown as it arrives instead. */
const BLOCK_WAIT_MS = 2000;
const BLOCK_MAX_CHARS = 1200;

/**
 * Buffers incoming text and releases it smoothly for streaming.
 * @param onText callback receiving each chunk of text to render
 * @param getWeight optional callback returning a weight that slows the tick rate (e.g. message count)
 *
 * Each paragraph (source line) is shown in one of two modes, chosen from the incoming rate when it
 * starts and kept until it ends, so a paragraph is never part typed out and part shown at once:
 * - block, for fast streams: a whole paragraph (or code line) at a time;
 * - flow: about 30 times a second, a share of the backlog proportional to its size, extended to the
 *   end of a word. This follows the incoming rate and spreads out bursts.
 * While the page is blurred, releases the whole buffer at most about once per second. While hidden,
 * releases nothing until flush(), which emits the whole buffer, or until the page is visible again.
 */
export function createTextDrip(onText: (text: string) => void, getWeight?: () => number): TextDrip {
	let buffer = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onDrained: (() => void) | null = null;
	let firstPushTime = 0;
	let lastPushTime = 0;
	let lastBlurEmit = 0;
	/** Mode of the paragraph being shown, null until the next one starts. */
	let mode: 'flow' | 'block' | null = null;
	let paragraphStart = 0;
	const arrivals: [time: number, chars: number][] = [];

	function onVisible() {
		document.removeEventListener('visibilitychange', onVisible);
		schedule();
	}

	function tickMs() {
		return TICK_MS * Math.max(1, Math.floor((getWeight?.() ?? 0) / 4000));
	}

	function schedule(delay = tickMs()) {
		if (timer !== undefined || buffer.length === 0) return;
		if (document.hidden) {
			document.addEventListener('visibilitychange', onVisible);
			return;
		}
		timer = setTimeout(tick, delay);
	}

	/** Chars per second over the last RATE_WINDOW_MS. */
	function incomingRate(now: number) {
		while (arrivals.length && arrivals[0]![0] < now - RATE_WINDOW_MS) arrivals.shift();
		const chars = arrivals.reduce((sum, [, n]) => sum + n, 0);
		return chars * 1000 / Math.max(1, Math.min(RATE_WINDOW_MS, now - firstPushTime));
	}

	/** How much of the buffer to show now. */
	function releaseLength(now: number): number {
		const draining = !!onDrained || now - lastPushTime > STALE_MS;
		if (!mode) {
			if (!draining && now - firstPushTime < MIN_RATE_SAMPLE_MS) return 0;
			mode = incomingRate(now) >= BLOCK_RATE ? 'block' : 'flow';
			paragraphStart = now;
		}
		if (mode === 'block') {
			const lastLineEnd = buffer.lastIndexOf('\n');
			if (lastLineEnd !== -1) {
				mode = null;
				return lastLineEnd + 1;
			}
			if (draining) return buffer.length;
			if (now - paragraphStart < BLOCK_WAIT_MS && buffer.length < BLOCK_MAX_CHARS) return 0;
			mode = 'flow';
		}
		const share = Math.ceil(buffer.length * Math.min(1, tickMs() / (draining ? DRAIN_LAG_MS : LAG_MS)));
		const wordEnd = buffer.slice(share).search(/\s/);
		const length = wordEnd === -1 ? share : share + wordEnd + 1;
		const lineEnd = buffer.indexOf('\n');
		if (lineEnd !== -1 && lineEnd < length) {
			mode = null;
			return lineEnd + 1;
		}
		return length;
	}

	function emit(length: number) {
		if (length === 0) return;
		const chunk = buffer.slice(0, length);
		buffer = buffer.slice(length);
		onText(chunk);
	}

	function drained() {
		onDrained?.();
		onDrained = null;
	}

	function tick() {
		timer = undefined;
		const now = performance.now();
		if (document.hidden) {
			emit(buffer.length);
			mode = null;
		} else if (!document.hasFocus()) {
			const wait = lastBlurEmit + BLUR_INTERVAL_MS - now;
			if (wait > 0) return schedule(wait);
			lastBlurEmit = now;
			emit(buffer.length);
			mode = null;
		} else {
			emit(releaseLength(now));
		}
		if (buffer.length === 0) drained();
		else schedule();
	}

	return {
		push(text: string) {
			lastPushTime = performance.now();
			firstPushTime ||= lastPushTime;
			arrivals.push([lastPushTime, text.length]);
			buffer += text;
			schedule();
		},
		flush() {
			document.removeEventListener('visibilitychange', onVisible);
			if (buffer.length === 0) return Promise.resolve();
			if (document.hidden) {
				clearTimeout(timer);
				timer = undefined;
				emit(buffer.length);
				return Promise.resolve();
			}
			schedule();
			return new Promise<void>(resolve => { onDrained = resolve; });
		}
	};
}
