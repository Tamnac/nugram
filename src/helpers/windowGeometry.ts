export const MESSAGE_CHUNK_SIZE = 70;
export const ESTIMATED_MESSAGE_HEIGHT = 480;
export const ESTIMATED_FOLD_HEIGHT = 110;

/**
 * Estimated height of messages `[start, end)` before they are measured. `collapsed` are the
 * closed folds not inside another closed fold, sorted: each shows as one row and hides the rest of its span.
 */
export function estimateHeight(start: number, end: number, collapsed: readonly { start: number; end: number }[] = []): number {
	let shown = end - start, rows = 0;
	for (const f of collapsed) {
		const overlap = Math.min(f.end, end) - Math.max(f.start, start);
		if (overlap <= 0) continue;
		shown -= overlap;
		if (f.start >= start) rows++;
	}
	return shown * ESTIMATED_MESSAGE_HEIGHT + rows * ESTIMATED_FOLD_HEIGHT;
}

export function chunkAtOffset(heights: readonly number[], offset: number): number {
	let bottom = 0;
	for (let i = 0; i < heights.length; i++) {
		bottom += heights[i];
		if (offset < bottom) return i;
	}
	return Math.max(0, heights.length - 1);
}

export function chunkRange(first: number, last: number, count: number): [number, number] {
	return [Math.max(0, first - 1), Math.min(count, last + 2)];
}
