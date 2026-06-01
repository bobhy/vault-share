/**
 * Minimal IndexedDB helper.
 * On schema version change the upgrade handler is expected to drop all stores
 * and recreate them (cold-start per project convention).
 *
 * @packageDocumentation
 */

/** Inputs required to open an {@link IDBHelper}-managed database. */
export interface IDBOpenConfig {
	dbName: string;
	version: number;
	onUpgrade: (db: IDBDatabase, oldVersion: number) => void;
}

/**
 * Promise-friendly wrapper over the raw `indexedDB.open` request-style API.
 *
 * Hands callers a {@link IDBHelper.runTransaction} primitive that takes a
 * synchronous body plus a result extractor — keeping the IDB-request → Promise
 * adaptation out of the rest of the codebase.
 */
export class IDBHelper {
	private db: IDBDatabase | null = null;

	constructor(private readonly config: IDBOpenConfig) {}

	open(): Promise<void> {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(this.config.dbName, this.config.version);

			req.onupgradeneeded = (event) => {
				this.config.onUpgrade(req.result, event.oldVersion);
			};

			req.onsuccess = () => {
				this.db = req.result;
				resolve();
			};

			req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
			req.onblocked = () => reject(new Error(`IDB blocked: ${this.config.dbName}`));
		});
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}

	/**
	 * Run a function inside an IDB transaction.
	 * `fn` receives the transaction and returns a getter that retrieves
	 * the result after the transaction commits.
	 */
	runTransaction<T>(
		storeNames: string | string[],
		mode: IDBTransactionMode,
		fn: (tx: IDBTransaction) => () => T,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			if (!this.db) {
				reject(new Error('IDB not open'));
				return;
			}
			const names = Array.isArray(storeNames) ? storeNames : [storeNames];
			const tx = this.db.transaction(names, mode);
			let getResult: () => T;

			try {
				getResult = fn(tx);
			} catch (err) {
				tx.abort();
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}

			tx.oncomplete = () => resolve(getResult());
			tx.onerror = () => reject(tx.error ?? new Error('IDB transaction error'));
			tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
		});
	}
}

/** Wrap an IDBRequest in a Promise, resolving with the result. */
export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
	});
}

/** Replace characters that are invalid in IDB database names. */
export function sanitizeDbName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
