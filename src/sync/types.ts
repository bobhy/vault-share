import type { App } from 'obsidian';
import type { VaultShareSettings } from '../settings';
import type { Logger } from '../logger';
import type { SyncStore } from './store';
import type { StatsTracker } from './stats-tracker';
import type { LocalFs } from './local-fs';
import type { DriveFsAdapter } from './drive-fs';

/** One side's (local or remote) view of a file. */
export interface FileSide {
	path: string;
	mtime: number;  // epoch ms; 0 = unknown
	size: number;
}

export type SyncActionType =
	| 'push'          // local → remote
	| 'pull'          // remote → local
	| 'deleteRemote'  // delete from Drive
	| 'deleteLocal'   // delete from local vault
	| 'conflict'
	| 'noOp';

/**
 * The sharing state of a single {@link Candidate}.
 *
 * - `Synced`   — file is in sync; record holds last-sync history for future planning.
 * - `Default`  — pending operation; will be processed on the next bulk sync pass,
 *                subject to the threshold guard.
 * - `Deferred` — explicitly held back by the user or the threshold guard; bulk sync
 *                skips this file until the state changes.
 * - `Approved` — user clicked Apply; bulk sync executes this on the next run,
 *                bypassing the threshold guard.
 */
export type CandidateState = 'Synced' | 'Default' | 'Deferred' | 'Approved';

/**
 * Unified record for a single vault path that sharing tracks.
 *
 * Persistent fields are stored in the `candidates` IDB object store and survive
 * plugin restarts.  Ephemeral fields are populated by {@link CandidateStore.reconcile}
 * and are `undefined` between planning passes.
 *
 * All four sharing layers — planning, UI, deferral, execution — work directly
 * with `Candidate`.  There are no intermediate projection types.
 *
 * ### Immutability contract
 *
 * `Candidate` is **immutable to readers**. Any reference returned by
 * `CandidateStore.getAll()` / `getByType()` / `getApproved()` / `getPending()`
 * is a stable snapshot — its fields will not change underneath the holder.
 *
 * `CandidateStore` enforces this by **replacing** the cache entry on every
 * mutation (reconcile, markSynced, defer, approve, …) rather than rewriting
 * the existing object in place. Held references therefore go *stale* after a
 * mutation (they still describe the candidate at the moment of fetch), but
 * they do not lie about their fields. Callers that need the current view must
 * re-fetch from the store; subscribe to {@link CandidateStore.onChange} for a
 * notification when re-fetching is worthwhile.
 *
 * Code that constructs a `Candidate` outside the store (e.g.
 * `single-file-sync.ts` building a transient candidate for a brand-new path)
 * is free to mutate its own object until it hands the candidate over to
 * `CandidateStore`.
 */
export interface Candidate {
	// ── Identity (IDB key) ────────────────────────────────────────────────────
	path: string;

	// ── State (persistent) ────────────────────────────────────────────────────
	state: CandidateState;

	/**
	 * What sharing plans to do with this file.
	 * `'noOp'` when `state === 'Synced'`.
	 * Set / updated by {@link CandidateStore.reconcile} on every planning pass.
	 */
	actionType: SyncActionType;

	// ── Last-sync history (persistent) ───────────────────────────────────────
	// Populated after each successful sync.  Used by the planning pass to
	// determine whether local / remote have changed since last sync.
	// All fields are 0 / '' for a file that has never been synced.
	driveFileId: string;
	syncedLocalMtime: number;
	syncedRemoteMtime: number;
	syncedLocalSize: number;
	syncedRemoteSize: number;
	/** Epoch ms of the last successful sync; 0 = never synced. */
	syncedAt: number;

	// ── Deferral sentinels (persistent; meaningful only when state = 'Deferred') ──
	// Set when the candidate enters Deferred state.
	// Auto-revocation: if either mtime differs from the current value on the next
	// planning pass, the candidate transitions back to Default.
	/** Epoch ms when deferred; 0 otherwise. */
	deferredAt: number;
	/** Local mtime at deferral time; 0 = file was absent. */
	deferredLocalMtime: number;
	/** Remote mtime at deferral time; 0 = file was absent. */
	deferredRemoteMtime: number;

	// ── Ephemeral (populated by reconcile(); undefined between passes) ─────────
	local?: FileSide;
	remote?: FileSide & { driveFileId: string };
}

/** Post-sync file metadata shared by {@link SyncFileResult.syncedState} and {@link SyncFileResult.newSyncedFiles}. */
export interface SyncedFileState {
	driveFileId: string;
	localMtime: number;
	remoteMtime: number;
	localSize: number;
	remoteSize: number;
	syncedAt: number;
}

/**
 * Result of a single file sync operation.
 *
 * When `changed` is true and the action was a push / pull / conflict resolution,
 * `syncedState` carries the post-sync metadata that {@link BulkSync} uses to call
 * `candidateStore.markSynced()`.  For delete actions and unchanged files,
 * `syncedState` is `undefined`.
 *
 * `newSyncedFiles` carries metadata for any additional vault paths created during
 * the operation (e.g. conflict copies from a "Keep Both" resolution) so the caller
 * can insert them as `Synced` candidates without the sync function needing a store
 * reference.
 */
export interface SyncFileResult {
	changed: boolean;
	merged: boolean;
	hadConflictMarkers: boolean;
	/**
	 * Set when `changed = true` for non-delete actions.
	 * Used by the caller to update {@link CandidateStore} without
	 * {@link syncOneFile} needing a store reference.
	 */
	syncedState?: SyncedFileState;
	/**
	 * Newly created vault paths (conflict copies, placeholders) that should be
	 * inserted into {@link CandidateStore} as `Synced` candidates so the next
	 * planning pass does not re-plan them as conflicts.
	 */
	newSyncedFiles?: Array<{ path: string } & SyncedFileState>;
}

/** Result of a single bulk sync pass. */
export interface SyncPassResult {
	downloaded: number;
	uploaded: number;
	deleted: number;
	conflicts: number;
	merges: number;
	/** True if the pass was halted because the action count exceeded the deferral threshold. */
	deferredByThreshold: boolean;
	error?: Error;
}

/** Cumulative sync statistics. */
export interface SyncStats {
	APIResponseTime: number;
	serverClockSkew: number;
	bulkSyncPasses: number;
	/** Number of bulk sync passes that detected at least one duplicate Drive file. Resets to 0 after a successful "Repair Drive duplicates" run. */
	bulkPassesWithDuplicates: number;
	singleFileSyncCount: number;
	filesPushed: number;
	filesPulled: number;
	filesMerged: number;
	contentConflicts: number;
	deleteConflicts: number;
}

/** Context object threaded through all sync operations. */
export interface SyncContext {
	app: App;
	localFs: LocalFs;
	driveFs: DriveFsAdapter;
	store: SyncStore;
	statsTracker: StatsTracker;
	settings: () => VaultShareSettings;
	clientId: string;
	driveFolderId: () => string;  // getter so re-resolution after log in is visible
	logger: Logger;
}
