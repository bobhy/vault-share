import { IDBHelper, idbRequest, sanitizeDbName } from './idb';
import type { SyncStats } from './types';

/**
 * Increment DB_VERSION on any schema change.
 *
 * SCHEMA_CHANGELOG
 *   1 — initial schema: sync-records, sync-content, sync-stats, device
 *   2 — added deferred-candidates, sync-state
 *   3 — candidates store replaces deferred-candidates + sync-records;
 *         sync-state store retained unchanged
 */
const DB_VERSION = 3;
const STORE_CANDIDATES = 'candidates';
const STORE_CONTENT = 'sync-content';
const STORE_STATS = 'sync-stats';
const STORE_DEVICE = 'device';
const STORE_SYNC_STATE = 'sync-state';
const STATS_KEY = 'stats';
const CLIENT_ID_KEY = 'clientId';

export const EMPTY_STATS: SyncStats = {
	APIResponseTime: 0,
	serverClockSkew: 0,
	bulkSyncPasses: 0,
	bulkPassesWithDuplicates: 0,
	singleFileSyncCount: 0,
	filesPushed: 0,
	filesPulled: 0,
	filesMerged: 0,
	contentConflicts: 0,
	deleteConflicts: 0,
};

/** Create all IDB object stores for schema version 3. */
function createStores(db: IDBDatabase): void {
	db.createObjectStore(STORE_CANDIDATES, { keyPath: 'path' });
	db.createObjectStore(STORE_CONTENT, { keyPath: 'path' });
	db.createObjectStore(STORE_STATS, { keyPath: 'key' });
	db.createObjectStore(STORE_DEVICE, { keyPath: 'key' });
	db.createObjectStore(STORE_SYNC_STATE, { keyPath: 'key' });
}

/**
 * Manages all IndexedDB object stores for vault-share.
 *
 * Schema is versioned via {@link DB_VERSION}.  The upgrade handler performs a
 * cold-start on all pre-1.0 version bumps (drop everything, recreate).  Post-1.0
 * migrations should replace the cold-start with incremental `if (oldVersion < N)`
 * migration blocks.
 */
export class SyncStore {
	private readonly idb: IDBHelper;

	constructor(vaultName: string) {
		this.idb = new IDBHelper({
			dbName: `vault-share-${sanitizeDbName(vaultName)}`,
			version: DB_VERSION,
			onUpgrade: (db, oldVersion) => {
				if (oldVersion < 3) {
					// Pre-1.0 policy: cold-start on any schema change.
					// Post-1.0: replace this block with per-step migration logic, e.g.:
					//   if (oldVersion < 3) { migrate_2_to_3(db); }
					for (const name of Array.from(db.objectStoreNames)) {
						db.deleteObjectStore(name);
					}
					createStores(db);
				}
			},
		});
	}

	/**
	 * Returns the underlying IDBHelper for use by peer store classes (e.g. CandidateStore)
	 * that share this database connection and schema.
	 */
	getIdb(): IDBHelper {
		return this.idb;
	}

	open(): Promise<void> {
		return this.idb.open();
	}

	close(): void {
		this.idb.close();
	}

	// --- sync-content ---

	getContent(path: string): Promise<ArrayBuffer | undefined> {
		return this.idb.runTransaction(STORE_CONTENT, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_CONTENT).get(path) as IDBRequest<{ path: string; content: ArrayBuffer } | undefined>;
			return () => req.result?.content;
		});
	}

	putContent(path: string, content: ArrayBuffer): Promise<void> {
		return this.idb.runTransaction(STORE_CONTENT, 'readwrite', (tx) => {
			tx.objectStore(STORE_CONTENT).put({ path, content });
			return () => undefined;
		});
	}

	deleteContent(path: string): Promise<void> {
		return this.idb.runTransaction(STORE_CONTENT, 'readwrite', (tx) => {
			tx.objectStore(STORE_CONTENT).delete(path);
			return () => undefined;
		});
	}

	// --- sync-stats ---

	getStats(): Promise<SyncStats> {
		return this.idb.runTransaction(STORE_STATS, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_STATS).get(STATS_KEY) as IDBRequest<{ key: string } & SyncStats | undefined>;
			return () => {
				const row = req.result;
				if (!row) return { ...EMPTY_STATS };
				const { key: _key, ...stats } = row;
				return stats;
			};
		});
	}

	putStats(stats: SyncStats): Promise<void> {
		return this.idb.runTransaction(STORE_STATS, 'readwrite', (tx) => {
			tx.objectStore(STORE_STATS).put({ key: STATS_KEY, ...stats });
			return () => undefined;
		});
	}

	// --- device ---

	getClientId(): Promise<string | undefined> {
		return this.idb.runTransaction(STORE_DEVICE, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_DEVICE).get(CLIENT_ID_KEY) as IDBRequest<{ key: string; value: string } | undefined>;
			return () => req.result?.value;
		});
	}

	putClientId(id: string): Promise<void> {
		return this.idb.runTransaction(STORE_DEVICE, 'readwrite', (tx) => {
			tx.objectStore(STORE_DEVICE).put({ key: CLIENT_ID_KEY, value: id });
			return () => undefined;
		});
	}

	/** Clear cached content without touching stats or candidates. */
	clearContent(): Promise<void> {
		return this.idb.runTransaction(STORE_CONTENT, 'readwrite', (tx) => {
			tx.objectStore(STORE_CONTENT).clear();
			return () => undefined;
		});
	}

	/** Clear stats only. */
	clearStats(): Promise<void> {
		return this.idb.runTransaction(STORE_STATS, 'readwrite', (tx) => {
			tx.objectStore(STORE_STATS).clear();
			return () => undefined;
		});
	}
}

// Re-export for consumers that only need idbRequest.
export { idbRequest };
