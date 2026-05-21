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

	getCurrent(): SyncStats {
		return { ...this.current };
	}

	recordPush(): void { this.current.filesPushed++; }
	recordPull(): void { this.current.filesPulled++; }
	recordMerge(): void { this.current.filesMerged++; }
	recordContentConflict(): void { this.current.contentConflicts++; }
	recordDeleteConflict(): void { this.current.deleteConflicts++; }
	recordBulkSyncPass(): void { this.current.bulkSyncPasses++; }
	recordSingleFileSync(): void { this.current.singleFileSyncCount++; }

	recordAPIResponseTime(ms: number): void {
		this.current.APIResponseTime = ms;
	}

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
