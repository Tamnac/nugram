/**
 * Tests for the pure parts of the backup layer (src/helpers/backup.ts):
 * snapshot naming and the tiered retention selector.
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import {
	expiredBackups, parseStampName, PROFILES, MINUTE, HOUR, DAY, WEEK,
	type BackupFile, type RetentionRule,
} from '../src/helpers/backup';

const NOW = new Date('2026-08-09T12:00:00').getTime();

/** Snapshot taken `agoMs` before NOW. */
function snap(agoMs: number): BackupFile {
	const time = NOW - agoMs;
	return { name: `story-${time}.db`, path: `/b/story-${time}.db`, time, size: 1000, settings: true };
}

const keptPaths = (files: BackupFile[], rules: RetentionRule[]) => {
	const gone = new Set(expiredBackups(files, rules).map(f => f.path));
	return files.filter(f => !gone.has(f.path)).map(f => f.path);
};

describe('parseStampName', () => {
	test('round-trips local time', () => {
		expect(parseStampName('story-20260809-153045.db'))
			.toBe(new Date(2026, 7, 9, 15, 30, 45).getTime());
	});

	test('ignores anything we did not write', () => {
		for (const name of ['story.db', 'story-2026.db', 'story-20260809-1530.db', 'notes.txt', 'story-20260809-153045.db.tmp'])
			expect(parseStampName(name)).toBeNull();
	});
});

describe('expiredBackups', () => {
	const rules = PROFILES.normal.rules;

	test('keeps everything while under the tier counts', () => {
		const files = [snap(0), snap(20 * MINUTE), snap(40 * MINUTE)];
		expect(expiredBackups(files, rules)).toEqual([]);
	});

	test('empty input', () => {
		expect(expiredBackups([], rules)).toEqual([]);
	});

	test('always keeps the newest', () => {
		const newest = snap(0);
		const files = [newest, ...Array.from({ length: 40 }, (_, i) => snap((i + 1) * 6 * HOUR))];
		expect(expiredBackups(files, rules).some(f => f.path === newest.path)).toBe(false);
	});

	test('collapses a dense burst to one per bucket', () => {
		// Buckets are wall-clock aligned, so this burst straddles two of them:
		// 12:00 opens a new quarter-hour, 11:58–11:52 share the previous one.
		const files = [snap(0), snap(2 * MINUTE), snap(4 * MINUTE), snap(6 * MINUTE), snap(8 * MINUTE)];
		expect(keptPaths(files, [{ every: 15 * MINUTE, keep: 4 }]))
			.toEqual([files[0].path, files[1].path]);
	});

	test('thins by age: recent dense, older sparse', () => {
		// One snapshot every 15 minutes for a week.
		const files = Array.from({ length: 4 * 24 * 7 }, (_, i) => snap(i * 15 * MINUTE));
		const kept = keptPaths(files, rules);

		// 4 quarter-hourly + 3 hourly + 3 daily + 2 weekly, minus overlap at the
		// newest end where one file satisfies several tiers.
		expect(kept.length).toBeLessThanOrEqual(12);
		expect(kept[0]).toBe(files[0].path);

		const ages = kept.map(p => NOW - files.find(f => f.path === p)!.time);
		expect(ages).toEqual([...ages].sort((a, b) => a - b)); // newest first, no gaps in ordering
		expect(Math.max(...ages)).toBeGreaterThanOrEqual(3 * DAY); // reaches back past the newest week boundary
		expect(ages.filter(a => a < HOUR).length).toBeGreaterThanOrEqual(3);
		expect(ages.filter(a => a >= DAY).length).toBeGreaterThanOrEqual(2);
	});

	test('a file pinned by a longer tier survives falling out of a shorter one', () => {
		// Two snapshots an hour apart: the older one is out of the 15m tier's reach
		// but is the hourly tier's second representative.
		const files = [snap(0), snap(90 * MINUTE)];
		expect(keptPaths(files, [{ every: 15 * MINUTE, keep: 1 }, { every: HOUR, keep: 2 }]))
			.toEqual([files[0].path, files[1].path]);
	});

	test('protects the snapshot being restored from the safety snapshot', () => {
		// A fresh snapshot claims the newest bucket and pushes the oldest quarter-hour
		// representative out — which is exactly the one the user asked to restore.
		const target = snap(45 * MINUTE);
		const files = [snap(0), snap(20 * MINUTE), snap(35 * MINUTE), target, snap(50 * MINUTE)];
		const tier = [{ every: 15 * MINUTE, keep: 3 }];

		expect(expiredBackups(files, tier).map(f => f.path)).toContain(target.path);
		expect(expiredBackups(files, tier, target.path).map(f => f.path)).not.toContain(target.path);
	});

	test('unsorted input is handled', () => {
		const files = [snap(2 * DAY), snap(0), snap(DAY)];
		expect(keptPaths(files, [{ every: DAY, keep: 2 }]))
			.toEqual([files[1].path, files[2].path]);
	});
});
