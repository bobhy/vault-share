import type { IDBHelper } from './idb';
import type { DeferredCandidate } from './types';

const STORE_DEFERRED = 'deferred-candidates';
const STORE_SYNC_STATE = 'sync-state';
const PAUSED_KEY = 'syncPaused';

/**
 * Manages the `deferred-candidates` and `sync-state` IndexedDB object stores.
 *
 * Both stores hold device-local state that must never be shared to other vaults.
 * The {@link IDBHelper} is provided by {@link SyncStore} (which owns the schema) so
 * both classes share the same database connection.
 */
export class DeferralStore {
	constructor(private readonly idb: IDBHelper) {}

	// -------------------------------------------------------------------------
	// deferred-candidates store
	// -------------------------------------------------------------------------

	/** Retrieve all currently deferred candidates. */
	getAllCandidates(): Promise<DeferredCandidate[]> {
		return this.idb.runTransaction(STORE_DEFERRED, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_DEFERRED).getAll() as IDBRequest<DeferredCandidate[]>;
			return () => req.result;
		});
	}

	/** Persist or overwrite a single deferred candidate. */
	putCandidate(candidate: DeferredCandidate): Promise<void> {
		return this.idb.runTransaction(STORE_DEFERRED, 'readwrite', (tx) => {
			tx.objectStore(STORE_DEFERRED).put(candidate);
			return () => undefined;
		});
	}

	/** Persist or overwrite multiple deferred candidates in a single transaction. */
	putCandidates(candidates: DeferredCandidate[]): Promise<void> {
		if (candidates.length === 0) return Promise.resolve();
		return this.idb.runTransaction(STORE_DEFERRED, 'readwrite', (tx) => {
			const store = tx.objectStore(STORE_DEFERRED);
			for (const c of candidates) store.put(c);
			return () => undefined;
		});
	}

	/** Remove a single deferred candidate by vault path. No-op if the path is not found. */
	deleteCandidate(path: string): Promise<void> {
		return this.idb.runTransaction(STORE_DEFERRED, 'readwrite', (tx) => {
			tx.objectStore(STORE_DEFERRED).delete(path);
			return () => undefined;
		});
	}

	/** Remove multiple deferred candidates by vault path in a single transaction. */
	deleteCandidates(paths: string[]): Promise<void> {
		if (paths.length === 0) return Promise.resolve();
		return this.idb.runTransaction(STORE_DEFERRED, 'readwrite', (tx) => {
			const store = tx.objectStore(STORE_DEFERRED);
			for (const path of paths) store.delete(path);
			return () => undefined;
		});
	}

	/** Remove all deferred candidates. */
	clearCandidates(): Promise<void> {
		return this.idb.runTransaction(STORE_DEFERRED, 'readwrite', (tx) => {
			tx.objectStore(STORE_DEFERRED).clear();
			return () => undefined;
		});
	}

	// -------------------------------------------------------------------------
	// sync-state store (paused flag)
	// -------------------------------------------------------------------------

	/** Returns true if bulk sync is currently paused on this device. */
	isPaused(): Promise<boolean> {
		return this.idb.runTransaction(STORE_SYNC_STATE, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_SYNC_STATE).get(PAUSED_KEY) as IDBRequest<{ key: string; value: boolean } | undefined>;
			return () => req.result?.value ?? false;
		});
	}

	/** Persist the paused state for this device. */
	setPaused(paused: boolean): Promise<void> {
		return this.idb.runTransaction(STORE_SYNC_STATE, 'readwrite', (tx) => {
			tx.objectStore(STORE_SYNC_STATE).put({ key: PAUSED_KEY, value: paused });
			return () => undefined;
		});
	}
}
