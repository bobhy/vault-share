import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatsTracker } from './stats-tracker';
import { EMPTY_STATS } from './store';
import type { SyncStore } from './store';
import type { SyncStats } from './types';

function makeMockStore(initial: SyncStats = { ...EMPTY_STATS }): SyncStore {
	return {
		getStats: vi.fn().mockResolvedValue(initial),
		putStats: vi.fn().mockResolvedValue(undefined),
	} as unknown as SyncStore;
}

describe('StatsTracker', () => {
	let store: SyncStore;
	let tracker: StatsTracker;
	let getStatsMock: ReturnType<typeof vi.fn>;
	let putStatsMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		getStatsMock = vi.fn().mockResolvedValue({ ...EMPTY_STATS });
		putStatsMock = vi.fn().mockResolvedValue(undefined);
		store = { getStats: getStatsMock, putStats: putStatsMock } as unknown as SyncStore;
		tracker = new StatsTracker(store);
		await tracker.load();
	});

	describe('load', () => {
		it('reads stats from store on load', () => {
			expect(getStatsMock).toHaveBeenCalledOnce();
		});

		it('reflects persisted values after load', async () => {
			const persisted: SyncStats = { ...EMPTY_STATS, filesPushed: 7, filesPulled: 3 };
			const richStore = makeMockStore(persisted);
			const t = new StatsTracker(richStore);
			await t.load();
			expect(t.getCurrent().filesPushed).toBe(7);
			expect(t.getCurrent().filesPulled).toBe(3);
		});
	});

	describe('getCurrent', () => {
		it('returns a copy — mutations do not affect internal state', () => {
			const snap = tracker.getCurrent();
			snap.filesPushed = 999;
			expect(tracker.getCurrent().filesPushed).toBe(0);
		});
	});

	describe('counters', () => {
		it('recordPush increments filesPushed', () => {
			tracker.recordPush();
			tracker.recordPush();
			expect(tracker.getCurrent().filesPushed).toBe(2);
		});

		it('recordPull increments filesPulled', () => {
			tracker.recordPull();
			expect(tracker.getCurrent().filesPulled).toBe(1);
		});

		it('recordMerge increments filesMerged', () => {
			tracker.recordMerge();
			expect(tracker.getCurrent().filesMerged).toBe(1);
		});

		it('recordContentConflict increments contentConflicts', () => {
			tracker.recordContentConflict();
			expect(tracker.getCurrent().contentConflicts).toBe(1);
		});

		it('recordDeleteConflict increments deleteConflicts', () => {
			tracker.recordDeleteConflict();
			expect(tracker.getCurrent().deleteConflicts).toBe(1);
		});

		it('recordBulkSyncPass increments bulkSyncPasses', () => {
			tracker.recordBulkSyncPass();
			tracker.recordBulkSyncPass();
			expect(tracker.getCurrent().bulkSyncPasses).toBe(2);
		});

		it('recordSingleFileSync increments singleFileSyncCount', () => {
			tracker.recordSingleFileSync();
			expect(tracker.getCurrent().singleFileSyncCount).toBe(1);
		});
	});

	describe('recordAPIResponseTime', () => {
		it('sets APIResponseTime to the given value', () => {
			tracker.recordAPIResponseTime(42);
			expect(tracker.getCurrent().APIResponseTime).toBe(42);
		});

		it('overwrites previous value', () => {
			tracker.recordAPIResponseTime(100);
			tracker.recordAPIResponseTime(200);
			expect(tracker.getCurrent().APIResponseTime).toBe(200);
		});
	});

	describe('recordClockSkew', () => {
		it('sets serverClockSkew to the given value', () => {
			tracker.recordClockSkew(-500);
			expect(tracker.getCurrent().serverClockSkew).toBe(-500);
		});
	});

	describe('flush', () => {
		it('persists current stats to store', async () => {
			tracker.recordPush();
			tracker.recordPush();
			await tracker.flush();
			expect(putStatsMock).toHaveBeenCalledWith(
				expect.objectContaining({ filesPushed: 2 }),
			);
		});
	});

	describe('reset', () => {
		it('zeros all counters in memory and records reset timestamp', async () => {
			const before = Date.now();
			tracker.recordPush();
			tracker.recordPull();
			await tracker.reset();
			const after = Date.now();
			const stats = tracker.getCurrent();
			// All counters should be zero — compare without statsResetAt which is intentionally non-zero.
			const { statsResetAt, ...rest } = stats;
			const { statsResetAt: _ignored, ...emptyCounters } = EMPTY_STATS;
			void _ignored;
			expect(rest).toEqual(emptyCounters);
			// statsResetAt should be a current timestamp.
			expect(statsResetAt).toBeGreaterThanOrEqual(before);
			expect(statsResetAt).toBeLessThanOrEqual(after);
		});

		it('persists the zeroed stats to store with reset timestamp', async () => {
			tracker.recordPush();
			await tracker.reset();
			const persisted = tracker.getCurrent();
			expect(persisted.filesPushed).toBe(0);
			expect(persisted.statsResetAt).toBeGreaterThan(0);
			expect(putStatsMock).toHaveBeenCalled();
		});
	});
});
