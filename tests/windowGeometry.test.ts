import { describe, expect, test } from 'bun:test';
import { chunkAtOffset, chunkRange } from '../src/helpers/windowGeometry';

describe('message window geometry', () => {
	test('finds chunks using variable measured heights', () => {
		const heights = [100, 300, 50];
		expect(chunkAtOffset(heights, -10)).toBe(0);
		expect(chunkAtOffset(heights, 99)).toBe(0);
		expect(chunkAtOffset(heights, 100)).toBe(1);
		expect(chunkAtOffset(heights, 399)).toBe(1);
		expect(chunkAtOffset(heights, 400)).toBe(2);
		expect(chunkAtOffset(heights, 1000)).toBe(2);
		expect(chunkAtOffset([], 0)).toBe(0);
	});

	test('retains neighbors and clamps at history boundaries', () => {
		expect(chunkRange(0, 0, 20)).toEqual([0, 2]);
		expect(chunkRange(5, 5, 20)).toEqual([4, 7]);
		expect(chunkRange(5, 6, 20)).toEqual([4, 8]);
		expect(chunkRange(19, 19, 20)).toEqual([18, 20]);
		expect(chunkRange(0, 0, 1)).toEqual([0, 1]);
		expect(chunkRange(0, 0, 0)).toEqual([0, 0]);
	});
});
