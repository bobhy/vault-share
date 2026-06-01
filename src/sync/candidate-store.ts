import type { IDBHelper } from './idb';
import type { Candidate, FileSide, SyncActionType, SyncFileResult, SyncedFileState } from './types';
import type { DriveFileSide } from './drive-fs';
import { planAction } from './decision-engine';

const STORE_CANDIDATES = 'candidates';
const STORE_SYNC_STATE = 'sync-state';
const PAUSED_KEY = 'syncPaused';

/** Persistent shape stored in IDB (ephemeral fields excluded). */
type PersistedCandidate = Omit<Candidate, 'local' | 'remote'>;

function toPersistent(c: Candidate): PersistedCandidate {
	const { local: _l, remote: _r, ...rest } = c;
	return rest;
}

// ---------------------------------------------------------------------------
// CandidateStore
// ---------------------------------------------------------------------------

/**
 * Single source of truth for all per-file sharing state.
 *
 * Owns the `candidates` and `sync-state` IDB object stores (accessed via the
 * shared {@link IDBHelper} provided by {@link SyncStore}).  Maintains a
 * `Map<string, Candidate>` in-memory cache so all read operations are O(1)
 * with no IDB I/O.  Only write operations touch IDB.
 *
 * All four sharing layers — planning, execution, deferral, and UI — read from
 * this store instead of maintaining their own ephemeral state.
 *
 * ### Lifecycle
 * Call {@link init} once at startup (before the first scheduler tick) to warm
 * the cache from IDB.  The {@link onChanged} callback fires whenever any
 * persistent state changes; wire it in `main.ts` to update the status bar and
 * refresh Sharing Status views.
 */
export class CandidateStore {
	private cache = new Map<string, Candidate>();
	/** `null` until {@link init} has been awaited. */
	private cachedPaused: boolean | null = null;

	private readonly changeListeners = new Set<() => void>();

	/**
	 * Subscribe to "store changed" notifications. The listener fires after any
	 * persistent state mutation ({@link reconcile}, {@link approve}, {@link defer},
	 * {@link markSynced}, {@link remove}, {@link insertSynced}, {@link setPaused},
	 * {@link clear}, {@link deferAllAndPause}).
	 *
	 * Returns an unsubscribe function — call it on view teardown to prevent leaks.
	 *
	 * Listeners run synchronously in registration order. Throwing from a listener
	 * does not abort subsequent listeners (errors are logged to the console and
	 * swallowed); listeners must own their own error handling.
	 */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => { this.changeListeners.delete(listener); };
	}

	private fireChanged(): void {
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch (err) {
				// Listeners are UI code; an error here must not abort the store
				// mutation that triggered the notification.
				console.error('CandidateStore change listener threw', err);
			}
		}
	}

	constructor(private readonly idb: IDBHelper) {}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	/**
	 * Warm in-memory caches from IDB.
	 * Must be called once at startup before the scheduler's first tick.
	 */
	async init(): Promise<void> {
		const [candidates, paused] = await Promise.all([
			this.idb.runTransaction(STORE_CANDIDATES, 'readonly', (tx) => {
				const req = tx.objectStore(STORE_CANDIDATES).getAll() as IDBRequest<PersistedCandidate[]>;
				return () => req.result;
			}),
			this.idb.runTransaction(STORE_SYNC_STATE, 'readonly', (tx) => {
				const req = tx.objectStore(STORE_SYNC_STATE).get(PAUSED_KEY) as IDBRequest<{ key: string; value: boolean } | undefined>;
				return () => req.result?.value ?? false;
			}),
		]);
		this.cache = new Map(candidates.map(c => [c.path, c]));
		this.cachedPaused = paused;
	}

	// ── Planning ───────────────────────────────────────────────────────────────

	/**
	 * Merge a fresh file enumeration into the store.
	 *
	 * For each path in the union of `localFiles`, `remoteFiles`, and existing
	 * candidates:
	 *
	 * - Updates ephemeral fields (`local`, `remote`) from the current enumeration.
	 * - Recomputes `actionType` using {@link planAction}.
	 * - Applies state transitions per the spec state machine.
	 *
	 * Persists changed records to IDB.  Fires {@link onChanged} if any persistent
	 * state changed.
	 *
	 * Returns the paths that were newly rebaselined as `Synced` via the
	 * no-history size-equality heuristic.  Callers that have access to local file
	 * I/O (e.g. {@link BulkSync}) should verify these with a SHA-256 comparison
	 * and call {@link rebaselineAsConflict} for any that do not match, so the
	 * size-only false-positive window is eliminated when Drive provides a hash.
	 */
	async reconcile(
		localFiles: FileSide[],
		remoteFiles: DriveFileSide[],
	): Promise<string[]> {
		const localByPath = new Map<string, FileSide>(localFiles.map(f => [f.path, f]));
		const remoteByPath = new Map<string, DriveFileSide>(remoteFiles.map(f => [f.path, f]));

		// Union of all paths we need to consider.
		const allPaths = new Set<string>([
			...localByPath.keys(),
			...remoteByPath.keys(),
			...this.cache.keys(),
		]);

		const vaultHasHistory = this.hasSyncHistory();
		const toWrite: PersistedCandidate[] = [];
		const toRemove: string[] = [];
		const rebaselinedPaths: string[] = [];

		for (const path of allPaths) {
			const local = localByPath.get(path);
			const remote = remoteByPath.get(path);
			const existing = this.cache.get(path);

			if (!existing) {
				// Brand-new path: only create a candidate if the file exists somewhere.
				const newActionType = planAction(null, local, remote, vaultHasHistory);
				if (newActionType === 'noOp') {
					// `noOp` here is either "neither side present" (truly nothing
					// to track) or the no-history rebaseline case from
					// {@link planAction} ("both sides present, sizes match — most
					// likely already in sync, e.g. just after pluginReset").
					// For the rebaseline case, record a Synced candidate at the
					// current mtime/size so subsequent edits classify against
					// known values; without this, the path stays uncovered until
					// one side actually changes — and then planAction's
					// no-history path would treat a one-sided change as a fresh
					// push/pull, losing the other side's existing content.
					if (local && remote) {
						const candidate: Candidate = {
							path,
							state: 'Synced',
							actionType: 'noOp',
							driveFileId: remote.driveFileId,
							syncedLocalMtime: local.mtime,
							syncedRemoteMtime: remote.mtime,
							syncedLocalSize: local.size,
							syncedRemoteSize: remote.size,
							syncedAt: Date.now(),
							deferredAt: 0,
							deferredLocalMtime: 0,
							deferredRemoteMtime: 0,
							local,
							remote,
						};
						this.cache.set(path, candidate);
						toWrite.push(toPersistent(candidate));
						rebaselinedPaths.push(path);
					}
					continue;
				}

				const candidate: Candidate = {
					path,
					state: 'Default',
					actionType: newActionType,
					driveFileId: remote?.driveFileId ?? '',
					syncedLocalMtime: 0,
					syncedRemoteMtime: 0,
					syncedLocalSize: 0,
					syncedRemoteSize: 0,
					syncedAt: 0,
					deferredAt: 0,
					deferredLocalMtime: 0,
					deferredRemoteMtime: 0,
					local,
					remote,
				};
				this.cache.set(path, candidate);
				toWrite.push(toPersistent(candidate));
				continue;
			}

			// Existing candidate: never mutate `existing` — build `next` and replace
			// the cache entry. Holders of the old reference (e.g. an open UI list)
			// get a stable snapshot until they re-read via getAll() / getByType().
			const prevActionType = existing.actionType;
			const newActionType = planAction(existing, local, remote, vaultHasHistory);

			if (newActionType === 'noOp' && !local && !remote) {
				// File gone from both sides → remove candidate entirely.
				toRemove.push(path);
				this.cache.delete(path);
				continue;
			}

			// Base: copy existing, refresh ephemerals, set the new actionType.
			let next: Candidate = { ...existing, local, remote, actionType: newActionType };
			let persistedChanged = newActionType !== prevActionType;

			if (newActionType === 'noOp') {
				if (existing.state !== 'Synced') {
					// Files agree — promote to Synced.
					next = {
						...next,
						state: 'Synced',
						syncedLocalMtime: local?.mtime ?? next.syncedLocalMtime,
						syncedLocalSize: local?.size ?? next.syncedLocalSize,
						syncedRemoteMtime: remote?.mtime ?? next.syncedRemoteMtime,
						syncedRemoteSize: remote?.size ?? next.syncedRemoteSize,
						driveFileId: remote?.driveFileId ?? next.driveFileId,
						syncedAt: Date.now(),
						deferredAt: 0,
						deferredLocalMtime: 0,
						deferredRemoteMtime: 0,
					};
					persistedChanged = true;
				}
			} else {
				// actionType is not noOp — apply the state machine.
				switch (existing.state) {
					case 'Synced':
						// Something changed — demote to Default.
						next = { ...next, state: 'Default' };
						persistedChanged = true;
						break;

					case 'Default':
						// Stay Default; persistedChanged already covers actionType drift.
						break;

					case 'Deferred': {
						// Auto-revocation: if either mtime changed, transition back to Default.
						const currentLocalMtime = local?.mtime ?? 0;
						const currentRemoteMtime = remote?.mtime ?? 0;
						if (
							currentLocalMtime !== existing.deferredLocalMtime ||
							currentRemoteMtime !== existing.deferredRemoteMtime
						) {
							next = {
								...next,
								state: 'Default',
								deferredAt: 0,
								deferredLocalMtime: 0,
								deferredRemoteMtime: 0,
							};
							persistedChanged = true;
						}
						break;
					}

					case 'Approved':
						// Stay Approved; persistedChanged already covers actionType drift.
						break;
				}
			}

			this.cache.set(path, next);
			if (persistedChanged) {
				toWrite.push(toPersistent(next));
			}
		}

		if (toWrite.length > 0 || toRemove.length > 0) {
			await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
				const store = tx.objectStore(STORE_CANDIDATES);
				for (const c of toWrite) store.put(c);
				for (const path of toRemove) store.delete(path);
				return () => undefined;
			});
			this.fireChanged();
		}

		return rebaselinedPaths;
	}

	// ── Read (all from in-memory cache; no IDB I/O) ────────────────────────────

	/**
	 * Look up a candidate by path.  O(1).  Returns `undefined` if no candidate
	 * exists at that path.
	 *
	 * The returned reference is an immutable snapshot per the contract on
	 * {@link Candidate}; subsequent mutations replace the cache entry rather
	 * than rewriting the returned object, so the value here is safe to read
	 * without further synchronisation.
	 */
	get(path: string): Candidate | undefined {
		return this.cache.get(path);
	}

	/** All candidates regardless of state; for the Sharing Status view count table. */
	getAll(): Candidate[] {
		return Array.from(this.cache.values());
	}

	/** Candidates filtered by `actionType`; for {@link PendingListModal} rows. */
	getByType(type: SyncActionType): Candidate[] {
		return Array.from(this.cache.values()).filter(c => c.actionType === type);
	}

	/** `state === 'Approved'`; processed by {@link BulkSync.doRun} before any full planning pass. */
	getApproved(): Candidate[] {
		return Array.from(this.cache.values()).filter(c => c.state === 'Approved');
	}

	/** `state === 'Default'`; subject to threshold guard and normal execution. */
	getPending(): Candidate[] {
		return Array.from(this.cache.values()).filter(c => c.state === 'Default');
	}

	/** True if any candidate has been synced at least once. Replaces `allRecords.length > 0`. */
	hasSyncHistory(): boolean {
		for (const c of this.cache.values()) {
			if (c.syncedAt > 0) return true;
		}
		return false;
	}

	/**
	 * Total count of non-`Synced` candidates; for status bar display.
	 * Returns `null` before the first {@link reconcile} call.
	 */
	getPendingCount(): number | null {
		if (this.cache.size === 0 && this.cachedPaused === null) return null;
		let count = 0;
		for (const c of this.cache.values()) {
			if (c.state !== 'Synced') count++;
		}
		return count;
	}

	/**
	 * Returns `true` if the given path's candidate is in the `Deferred` state.
	 * Sync-safe (no I/O); used by the scheduler to skip individually-deferred files.
	 */
	isDeferred(path: string): boolean {
		return this.cache.get(path)?.state === 'Deferred';
	}

	// ── User actions (from PendingListModal; persist to IDB) ──────────────────

	/**
	 * Transition `Deferred` or `Default` → `Approved` for the given paths.
	 * Resets deferral sentinel fields to 0.  Fires {@link onChanged}.
	 */
	async approve(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		const toWrite: PersistedCandidate[] = [];
		for (const path of paths) {
			const existing = this.cache.get(path);
			if (!existing) continue;
			const next: Candidate = {
				...existing,
				state: 'Approved',
				deferredAt: 0,
				deferredLocalMtime: 0,
				deferredRemoteMtime: 0,
			};
			this.cache.set(path, next);
			toWrite.push(toPersistent(next));
		}
		if (toWrite.length === 0) return;
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			const store = tx.objectStore(STORE_CANDIDATES);
			for (const c of toWrite) store.put(c);
			return () => undefined;
		});
		this.fireChanged();
	}

	/**
	 * Transition `Default` or `Approved` → `Deferred` for the given paths.
	 * Captures current ephemeral `local` / `remote` mtimes as deferral sentinels.
	 * Fires {@link onChanged}.
	 */
	async defer(paths: string[], now = Date.now()): Promise<void> {
		if (paths.length === 0) return;
		const toWrite: PersistedCandidate[] = [];
		for (const path of paths) {
			const existing = this.cache.get(path);
			if (!existing) continue;
			const next: Candidate = {
				...existing,
				state: 'Deferred',
				deferredAt: now,
				deferredLocalMtime: existing.local?.mtime ?? 0,
				deferredRemoteMtime: existing.remote?.mtime ?? 0,
			};
			this.cache.set(path, next);
			toWrite.push(toPersistent(next));
		}
		if (toWrite.length === 0) return;
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			const store = tx.objectStore(STORE_CANDIDATES);
			for (const c of toWrite) store.put(c);
			return () => undefined;
		});
		this.fireChanged();
	}

	// ── Threshold guard ────────────────────────────────────────────────────────

	/**
	 * Transition all `Default` candidates → `Deferred`, and set the paused flag.
	 * Called by {@link BulkSync} when the action count exceeds the threshold.
	 * Fires {@link onChanged} once after all writes complete.
	 */
	async deferAllAndPause(pending: Candidate[]): Promise<void> {
		const now = Date.now();
		this.cachedPaused = true;
		const toWrite: PersistedCandidate[] = [];
		for (const stale of pending) {
			// `stale` is the caller's snapshot — re-read the live cache by path so
			// the "Default → Deferred" check sees current state, not whatever the
			// caller captured before any concurrent mutation.
			const existing = this.cache.get(stale.path);
			if (!existing || existing.state !== 'Default') continue;
			const next: Candidate = {
				...existing,
				state: 'Deferred',
				deferredAt: now,
				deferredLocalMtime: existing.local?.mtime ?? 0,
				deferredRemoteMtime: existing.remote?.mtime ?? 0,
			};
			this.cache.set(stale.path, next);
			toWrite.push(toPersistent(next));
		}
		await this.idb.runTransaction([STORE_CANDIDATES, STORE_SYNC_STATE], 'readwrite', (tx) => {
			const candidateStore = tx.objectStore(STORE_CANDIDATES);
			for (const c of toWrite) candidateStore.put(c);
			tx.objectStore(STORE_SYNC_STATE).put({ key: PAUSED_KEY, value: true });
			return () => undefined;
		});
		this.fireChanged();
	}

	// ── Execution lifecycle (called by BulkSync after syncOneFile) ────────────

	/**
	 * Transition `Approved` → `Synced` after a successful push / pull / conflict sync.
	 * Updates all `synced*` fields from `state`.
	 * Persists to IDB.  Fires {@link onChanged}.
	 */
	async markSynced(path: string, state: NonNullable<SyncFileResult['syncedState']>): Promise<void> {
		const existing = this.cache.get(path);
		if (!existing) return;
		const next: Candidate = {
			...existing,
			state: 'Synced',
			actionType: 'noOp',
			driveFileId: state.driveFileId,
			syncedLocalMtime: state.localMtime,
			syncedRemoteMtime: state.remoteMtime,
			syncedLocalSize: state.localSize,
			syncedRemoteSize: state.remoteSize,
			syncedAt: state.syncedAt,
			deferredAt: 0,
			deferredLocalMtime: 0,
			deferredRemoteMtime: 0,
		};
		this.cache.set(path, next);
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			tx.objectStore(STORE_CANDIDATES).put(toPersistent(next));
			return () => undefined;
		});
		this.fireChanged();
	}

	/**
	 * Remove a candidate entirely.
	 * Used after a successful delete action, or when a file disappears from both vaults.
	 * Fires {@link onChanged}.
	 */
	async remove(path: string): Promise<void> {
		if (!this.cache.has(path)) return;
		this.cache.delete(path);
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			tx.objectStore(STORE_CANDIDATES).delete(path);
			return () => undefined;
		});
		this.fireChanged();
	}

	/**
	 * Revert a newly rebaselined `Synced` candidate back to `Default` with
	 * `actionType = 'conflict'` when a SHA-256 check reveals the size-equality
	 * heuristic produced a false positive (same byte count but different content).
	 *
	 * Resets all `synced*` fields to `0` because no actual sync has occurred.
	 * Called by {@link BulkSync.doRun} after the post-reconcile hash verification
	 * pass.  Fires {@link onChanged}.
	 */
	async rebaselineAsConflict(path: string): Promise<void> {
		const existing = this.cache.get(path);
		if (!existing) return;
		const next: Candidate = {
			...existing,
			state: 'Default',
			actionType: 'conflict',
			syncedLocalMtime: 0,
			syncedRemoteMtime: 0,
			syncedLocalSize: 0,
			syncedRemoteSize: 0,
			syncedAt: 0,
		};
		this.cache.set(path, next);
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			tx.objectStore(STORE_CANDIDATES).put(toPersistent(next));
			return () => undefined;
		});
		this.fireChanged();
	}

	/**
	 * Insert a brand-new `Synced` candidate for a newly-created vault path.
	 *
	 * Used after a "Keep Both" or delete-conflict resolution creates new conflict-copy
	 * files so the next planning pass does not re-plan them as conflicts.
	 * Fires {@link onChanged}.
	 */
	async insertSynced(path: string, state: SyncedFileState): Promise<void> {
		const candidate: Candidate = {
			path,
			state: 'Synced',
			actionType: 'noOp',
			driveFileId: state.driveFileId,
			syncedLocalMtime: state.localMtime,
			syncedRemoteMtime: state.remoteMtime,
			syncedLocalSize: state.localSize,
			syncedRemoteSize: state.remoteSize,
			syncedAt: state.syncedAt,
			deferredAt: 0,
			deferredLocalMtime: 0,
			deferredRemoteMtime: 0,
		};
		this.cache.set(path, candidate);
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			tx.objectStore(STORE_CANDIDATES).put(toPersistent(candidate));
			return () => undefined;
		});
		this.fireChanged();
	}

	/**
	 * Apply a {@link SyncFileResult} from {@link syncOneFile} to the store.
	 *
	 * The single point that translates a file-syncer outcome into the
	 * corresponding store mutations. Used by both the bulk-sync execute loops
	 * and the single-decision paths in `resolution-executor`/`single-file-sync`
	 * so the post-result branching lives in one place.
	 *
	 * Semantics by combination:
	 *
	 * | actionType            | syncedState | result for the original path     |
	 * |-----------------------|-------------|----------------------------------|
	 * | deleteLocal / deleteRemote | any   | remove                           |
	 * | push / pull / conflict     | set   | upsert as Synced                 |
	 * | conflict (Keep Both /      | unset | remove — both sides of the path  |
	 * |   delete-conflict)         |       | are gone or moved aside          |
	 *
	 * `newSyncedFiles` (conflict-copy candidates produced by Keep Both /
	 * delete-conflict resolutions) are always inserted as `Synced`.
	 *
	 * `changed === false` is a no-op for both the original path and any
	 * `newSyncedFiles` (no resolver returns `newSyncedFiles` without
	 * `changed: true` today, but the early return keeps the contract clear).
	 *
	 * Callers are responsible for tallying their own counters
	 * (e.g. {@link BulkSync} updates {@link SyncPassResult}).
	 */
	async applyFileResult(
		path: string,
		actionType: SyncActionType,
		fileResult: SyncFileResult,
	): Promise<void> {
		if (!fileResult.changed) return;
		const isDelete = actionType === 'deleteLocal' || actionType === 'deleteRemote';
		if (isDelete || !fileResult.syncedState) {
			// Delete: candidate's file is gone on its surviving side.
			// !syncedState (non-delete): conflict resolved by moving the
			//   original aside (Keep Both renamed local + deleted remote;
			//   delete-conflict created a placeholder at a new path). Either
			//   way, the candidate at `path` no longer reflects any sync we
			//   want to track. Drop it; the next reconcile will create a
			//   fresh candidate if either side still has a file here.
			await this.remove(path);
		} else {
			// Upsert: markSynced is a no-op for paths not in the cache (e.g.
			// single-file-sync on a brand-new file the bulk pass hasn't seen).
			if (this.cache.has(path)) {
				await this.markSynced(path, fileResult.syncedState);
			} else {
				await this.insertSynced(path, fileResult.syncedState);
			}
		}
		if (fileResult.newSyncedFiles) {
			for (const f of fileResult.newSyncedFiles) {
				const { path: newPath, ...state } = f;
				await this.insertSynced(newPath, state);
			}
		}
	}

	/**
	 * Clear all candidates from cache and IDB.
	 * Used during plugin reset or group-vault switch.
	 * Fires {@link onChanged}.
	 */
	async clear(): Promise<void> {
		this.cache.clear();
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			tx.objectStore(STORE_CANDIDATES).clear();
			return () => undefined;
		});
		this.fireChanged();
	}

	// ── Paused flag ────────────────────────────────────────────────────────────

	/** Returns the current paused state, reading from IDB the first time and from cache thereafter. */
	async isPaused(): Promise<boolean> {
		if (this.cachedPaused !== null) return this.cachedPaused;
		const paused = await this.idb.runTransaction(STORE_SYNC_STATE, 'readonly', (tx) => {
			const req = tx.objectStore(STORE_SYNC_STATE).get(PAUSED_KEY) as IDBRequest<{ key: string; value: boolean } | undefined>;
			return () => req.result?.value ?? false;
		});
		this.cachedPaused = paused;
		return paused;
	}

	/**
	 * Synchronous cache read.  Returns `false` until {@link init} (or {@link isPaused})
	 * has been awaited at least once.  Safe to call from hot paths like the scheduler tick.
	 */
	isPausedSync(): boolean {
		return this.cachedPaused ?? false;
	}

	/** Pause or resume sharing on this device.  Updates the cache and fires {@link onChanged}. */
	async setPaused(paused: boolean): Promise<void> {
		this.cachedPaused = paused;
		await this.idb.runTransaction(STORE_SYNC_STATE, 'readwrite', (tx) => {
			tx.objectStore(STORE_SYNC_STATE).put({ key: PAUSED_KEY, value: paused });
			return () => undefined;
		});
		this.fireChanged();
	}
}
