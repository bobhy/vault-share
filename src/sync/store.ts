import { IDBHelper, idbRequest, sanitizeDbName } from './idb';
import type { SyncRecord, SyncStats } from './types';

const DB_VERSION = 2;
const STORE_RECORDS = 'sync-records';
const STORE_CONTENT = 'sync-content';
const STORE_STATS = 'sync-stats';
const STORE_DEVICE = 'device';
const STORE_DEFERRED = 'deferred-candidates';
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

/**
 * Manages all IndexedDB object stores for vault-share.
 * On schema version change, all stores are dropped and recreated (cold-start).
 */
export class SyncStore {
	private readonly idb: IDBHelper;

	constructor(vaultName: string) {
		this.idb = new IDBHelper({
			dbName: `vault-share-${sanitizeDbName(vaultName)}`,
			version: DB_VERSION,
			onUpgrade: (db, oldVersion) => {
				// Cold-start: drop everything and recreate.
				if (oldVersion > 0) {
					for (const name of Array.from(db.objectStoreNames)) {
						db.deleteObjectStore(name);
					}
				}
				db.createObjectStore(STORE_RECORDS, { keyPath: 'path' });
				db.createObjectStore(STORE_CONTENT, { keyPath: 'path' });
				db.createObjectStore(STORE_STATS, { keyPath: 'key' });
				db.createObjectStore(STORE_DEVICE, { keyPath: 'key' });
				db.createObjectStore(STORE_DEFERRED, { keyPath: 'path' });
				db.createObjectStore(STORE_SYNC_STATE, { keyPath: 'key' });
			},
		});
	}

	/**
	 * Returns the underlying IDBHelper for use by peer store classes (e.g. DeferralStore)
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

	// --- sync-records ---

	getRecord(path: string): Promise<SyncRecord | undefined> {
		return this.idb.runTransaction(STORE_RECORDS, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_RECORDS).get(path) as IDBRequest<SyncRecord | undefined>;
			return () => req.result;
		});
	}

	getAllRecords(): Promise<SyncRecord[]> {
		return this.idb.runTransaction(STORE_RECORDS, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_RECORDS).getAll() as IDBRequest<SyncRecord[]>;
			return () => req.result;
		});
	}

	putRecord(record: SyncRecord): Promise<void> {
		return this.idb.runTransaction(STORE_RECORDS, 'readwrite', (tx) => {
			tx.objectStore(STORE_RECORDS).put(record);
			return () => undefined;
		});
	}

	deleteRecord(path: string): Promise<void> {
		return this.idb.runTransaction(STORE_RECORDS, 'readwrite', (tx) => {
			tx.objectStore(STORE_RECORDS).delete(path);
			return () => undefined;
		});
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

	/** Clear sync records and cached content without touching stats. */
	clearHistory(): Promise<void> {
		return this.idb.runTransaction([STORE_RECORDS, STORE_CONTENT], 'readwrite', (tx) => {
			tx.objectStore(STORE_RECORDS).clear();
			tx.objectStore(STORE_CONTENT).clear();
			return () => undefined;
		});
	}

	/** Clear sync history (records + content) and reset stats. */
	async clearAll(): Promise<void> {
		await this.idb.runTransaction([STORE_RECORDS, STORE_CONTENT, STORE_STATS], 'readwrite', (tx) => {
			tx.objectStore(STORE_RECORDS).clear();
			tx.objectStore(STORE_CONTENT).clear();
			tx.objectStore(STORE_STATS).clear();
			return () => undefined;
		});
	}
}

// Re-export for consumers that only need idbRequest.
export { idbRequest };
