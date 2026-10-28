export const MESSAGE_CHUNK_SIZE = 70;
export const ESTIMATED_MESSAGE_HEIGHT = 480;

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
