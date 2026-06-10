/**
 * In-memory accumulator for cumulative sync counters (pushes, pulls, merges,
 * conflicts, …).
 *
 * Increment methods are synchronous so they can be called from any sync code
 * path; {@link StatsTracker.flush} writes the accumulated counters to IDB.
 * {@link sync/bulk-sync!BulkSync} calls flush at the end of every successful pass. Reset is wired
 * to the plugin reset and "change Drive folder" flows.
 *
 * @packageDocumentation
 */
import type { SyncStats } from './types';
import { EMPTY_STATS, SyncStore } from './store';

/**
 * In-memory accumulator for sync statistics.
 * Flushes to IndexedDB after each sync pass or operation.
 * Reset ties to sync history clear via SyncStore.clearAll().
 */
export class StatsTracker {
	private current: SyncStats = { ...EMPTY_STATS };

	constructor(private readonly store: SyncStore) {}

	/** Load persisted stats from IDB into memory. Call once at startup. */
	async load(): Promise<void> {
		this.current = await this.store.getStats();
	}

	/** Snapshot of the current in-memory counters (a copy; safe to mutate). */
	getCurrent(): SyncStats {
		return { ...this.current };
	}

	/** Increment the lifetime push counter (a file went local → Drive). */
	recordPush(): void { this.current.filesPushed++; }
	/** Increment the lifetime pull counter (a file went Drive → local). */
	recordPull(): void { this.current.filesPulled++; }
	/** Increment the lifetime three-way merge counter. */
	recordMerge(): void { this.current.filesMerged++; }
	/** Increment the lifetime content-conflict counter (both sides edited). */
	recordContentConflict(): void { this.current.contentConflicts++; }
	/** Increment the lifetime modify/delete conflict counter. */
	recordDeleteConflict(): void { this.current.deleteConflicts++; }
	/** Increment the lifetime count of completed bulk-sync passes. */
	recordBulkSyncPass(): void { this.current.bulkSyncPasses++; }
	/** Increment the count of bulk passes that found at least one Drive duplicate. */
	recordPassWithDuplicates(): void { this.current.bulkPassesWithDuplicates++; }
	/** Increment the lifetime count of single-file (open-file) sync operations. */
	recordSingleFileSync(): void { this.current.singleFileSyncCount++; }

	/**
	 * Reset only the duplicate-pass counter to zero and persist.
	 * Called after a successful "Repair Drive duplicates" run so the counter
	 * reflects passes-since-last-cleanup rather than all-time passes.
	 */
	async resetDuplicateCounter(): Promise<void> {
		this.current.bulkPassesWithDuplicates = 0;
		await this.store.putStats(this.current);
	}

	/** Record the most recent Drive API response time (ms); not aggregated. */
	recordAPIResponseTime(ms: number): void {
		this.current.APIResponseTime = ms;
	}

	/** Record the most recent observed local-vs-server clock skew (ms). */
	recordClockSkew(ms: number): void {
		this.current.serverClockSkew = ms;
	}

	/** Persist current in-memory stats to IDB. */
	flush(): Promise<void> {
		return this.store.putStats(this.current);
	}

	/** Reset all stats to zero in memory and IDB. */
	async reset(): Promise<void> {
		this.current = { ...EMPTY_STATS };
		await this.store.putStats(this.current);
	}
}
