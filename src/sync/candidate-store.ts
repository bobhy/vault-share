import type { IDBHelper } from './idb';
import type { Candidate, FileSide, SyncActionType, SyncFileResult, SyncedFileState } from './types';
import type { DriveFileSide } from './drive-fs';

const STORE_CANDIDATES = 'candidates';
const STORE_SYNC_STATE = 'sync-state';
const PAUSED_KEY = 'syncPaused';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** File status relative to the last known sync. */
type FileStatus = 'modified' | 'unmodified' | 'deleted' | 'absent';

/**
 * Classify a side's status relative to the candidate's last-sync history.
 *
 * - `absent`     — file does not exist and was never synced
 * - `deleted`    — file does not exist but was once synced (syncedAt > 0)
 * - `unmodified` — file exists and mtime/size match the last-sync record
 * - `modified`   — file exists and differs from the last-sync record
 */
function classifyStatus(
	side: FileSide | undefined,
	syncedMtime: number,
	syncedSize: number,
	wasSynced: boolean,   // = candidate.syncedAt > 0
): FileStatus {
	if (!side) {
		return wasSynced ? 'deleted' : 'absent';
	}
	if (!wasSynced) {
		return 'modified'; // present but never synced — treat as modified (new)
	}
	if (side.mtime === syncedMtime && side.size === syncedSize) {
		return 'unmodified';
	}
	return 'modified';
}

/**
 * Determine the action type for a candidate given current local/remote state.
 * Mirrors the logic of the former `planActions` in `decision-engine.ts`.
 */
function planAction(
	candidate: Candidate | null,
	local: FileSide | undefined,
	remote: (FileSide & { driveFileId: string }) | undefined,
	vaultHasHistory: boolean,
): SyncActionType {
	const wasSynced = (candidate?.syncedAt ?? 0) > 0;

	if (!vaultHasHistory || !wasSynced) {
		// No-history path: use presence alone.
		if (local && !remote) return 'push';
		if (!local && remote) return 'pull';
		if (local && remote) return 'conflict';
		return 'noOp';
	}

	// With-history path: compare against last-sync record.
	const syncedLocalMtime = candidate?.syncedLocalMtime ?? 0;
	const syncedLocalSize = candidate?.syncedLocalSize ?? 0;
	const syncedRemoteMtime = candidate?.syncedRemoteMtime ?? 0;
	const syncedRemoteSize = candidate?.syncedRemoteSize ?? 0;

	const localStatus: FileStatus = classifyStatus(local, syncedLocalMtime, syncedLocalSize, wasSynced);
	const remoteStatus: FileStatus = classifyStatus(remote, syncedRemoteMtime, syncedRemoteSize, wasSynced);

	if (localStatus === 'modified' && (remoteStatus === 'absent' || remoteStatus === 'unmodified')) return 'push';
	if ((localStatus === 'absent' || localStatus === 'unmodified') && remoteStatus === 'modified') return 'pull';
	if (localStatus === 'deleted' && remoteStatus === 'unmodified') return 'deleteRemote';
	if (localStatus === 'unmodified' && remoteStatus === 'deleted') return 'deleteLocal';
	if (localStatus === 'deleted' && remoteStatus === 'deleted') return 'deleteLocal'; // both gone — clean up
	if (
		(localStatus === 'deleted' && remoteStatus === 'modified') ||
		(localStatus === 'modified' && remoteStatus === 'deleted') ||
		(localStatus === 'modified' && remoteStatus === 'modified')
	) return 'conflict';

	return 'noOp';
}

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

	/**
	 * Fired whenever any persistent state changes.
	 * Wired in `main.ts` to {@link updateStatusBar} + {@link refreshSharingStatusViews}.
	 */
	onChanged: (() => void) | null = null;

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
	 */
	async reconcile(
		localFiles: FileSide[],
		remoteFiles: DriveFileSide[],
	): Promise<void> {
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

		for (const path of allPaths) {
			const local = localByPath.get(path);
			const remote = remoteByPath.get(path);
			const existing = this.cache.get(path);

			if (!existing) {
				// Brand-new path: only create a candidate if the file exists somewhere.
				const newActionType = planAction(null, local, remote, vaultHasHistory);
				if (newActionType === 'noOp') continue;

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

			// Update ephemeral fields.
			existing.local = local;
			existing.remote = remote;

			const prevActionType = existing.actionType;
			const prevState = existing.state;
			const newActionType = planAction(existing, local, remote, vaultHasHistory);
			existing.actionType = newActionType;

			if (newActionType === 'noOp') {
				if (!local && !remote) {
					// File gone from both sides → remove candidate entirely.
					toRemove.push(path);
					this.cache.delete(path);
				} else if (existing.state !== 'Synced') {
					// Files agree — promote to Synced.
					existing.state = 'Synced';
					if (local) {
						existing.syncedLocalMtime = local.mtime;
						existing.syncedLocalSize = local.size;
					}
					if (remote) {
						existing.syncedRemoteMtime = remote.mtime;
						existing.syncedRemoteSize = remote.size;
						existing.driveFileId = remote.driveFileId;
					}
					existing.syncedAt = Date.now();
					existing.deferredAt = 0;
					existing.deferredLocalMtime = 0;
					existing.deferredRemoteMtime = 0;
					toWrite.push(toPersistent(existing));
				}
				continue;
			}

			// actionType is not noOp — apply state machine.
			let stateChanged = false;
			switch (existing.state) {
				case 'Synced':
					// Something changed — demote to Default.
					existing.state = 'Default';
					stateChanged = true;
					break;

				case 'Default':
					// Stay Default; record if actionType changed.
					if (newActionType !== prevActionType) stateChanged = true;
					break;

				case 'Deferred': {
					// Auto-revocation: if either mtime changed, transition back to Default.
					const currentLocalMtime = local?.mtime ?? 0;
					const currentRemoteMtime = remote?.mtime ?? 0;
					if (
						currentLocalMtime !== existing.deferredLocalMtime ||
						currentRemoteMtime !== existing.deferredRemoteMtime
					) {
						existing.state = 'Default';
						existing.deferredAt = 0;
						existing.deferredLocalMtime = 0;
						existing.deferredRemoteMtime = 0;
						stateChanged = true;
					} else if (newActionType !== prevActionType) {
						stateChanged = true;
					}
					break;
				}

				case 'Approved':
					// Stay Approved; note actionType changes so UI stays consistent.
					if (newActionType !== prevActionType) stateChanged = true;
					break;
			}

			if (stateChanged || existing.state !== prevState) {
				toWrite.push(toPersistent(existing));
			}
		}

		if (toWrite.length > 0 || toRemove.length > 0) {
			await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
				const store = tx.objectStore(STORE_CANDIDATES);
				for (const c of toWrite) store.put(c);
				for (const path of toRemove) store.delete(path);
				return () => undefined;
			});
			this.onChanged?.();
		}
	}

	// ── Read (all from in-memory cache; no IDB I/O) ────────────────────────────

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
			const c = this.cache.get(path);
			if (!c) continue;
			c.state = 'Approved';
			c.deferredAt = 0;
			c.deferredLocalMtime = 0;
			c.deferredRemoteMtime = 0;
			toWrite.push(toPersistent(c));
		}
		if (toWrite.length === 0) return;
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			const store = tx.objectStore(STORE_CANDIDATES);
			for (const c of toWrite) store.put(c);
			return () => undefined;
		});
		this.onChanged?.();
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
			const c = this.cache.get(path);
			if (!c) continue;
			c.state = 'Deferred';
			c.deferredAt = now;
			c.deferredLocalMtime = c.local?.mtime ?? 0;
			c.deferredRemoteMtime = c.remote?.mtime ?? 0;
			toWrite.push(toPersistent(c));
		}
		if (toWrite.length === 0) return;
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			const store = tx.objectStore(STORE_CANDIDATES);
			for (const c of toWrite) store.put(c);
			return () => undefined;
		});
		this.onChanged?.();
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
		for (const c of pending) {
			if (c.state === 'Default') {
				c.state = 'Deferred';
				c.deferredAt = now;
				c.deferredLocalMtime = c.local?.mtime ?? 0;
				c.deferredRemoteMtime = c.remote?.mtime ?? 0;
			}
		}
		await this.idb.runTransaction([STORE_CANDIDATES, STORE_SYNC_STATE], 'readwrite', (tx) => {
			const candidateStore = tx.objectStore(STORE_CANDIDATES);
			for (const c of pending) candidateStore.put(toPersistent(c));
			tx.objectStore(STORE_SYNC_STATE).put({ key: PAUSED_KEY, value: true });
			return () => undefined;
		});
		this.onChanged?.();
	}

	// ── Execution lifecycle (called by BulkSync after syncOneFile) ────────────

	/**
	 * Transition `Approved` → `Synced` after a successful push / pull / conflict sync.
	 * Updates all `synced*` fields from `state`.
	 * Persists to IDB.  Fires {@link onChanged}.
	 */
	async markSynced(path: string, state: NonNullable<SyncFileResult['syncedState']>): Promise<void> {
		const c = this.cache.get(path);
		if (!c) return;
		c.state = 'Synced';
		c.actionType = 'noOp';
		c.driveFileId = state.driveFileId;
		c.syncedLocalMtime = state.localMtime;
		c.syncedRemoteMtime = state.remoteMtime;
		c.syncedLocalSize = state.localSize;
		c.syncedRemoteSize = state.remoteSize;
		c.syncedAt = state.syncedAt;
		c.deferredAt = 0;
		c.deferredLocalMtime = 0;
		c.deferredRemoteMtime = 0;
		await this.idb.runTransaction(STORE_CANDIDATES, 'readwrite', (tx) => {
			tx.objectStore(STORE_CANDIDATES).put(toPersistent(c));
			return () => undefined;
		});
		this.onChanged?.();
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
		this.onChanged?.();
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
		this.onChanged?.();
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
		this.onChanged?.();
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
		this.onChanged?.();
	}
}
