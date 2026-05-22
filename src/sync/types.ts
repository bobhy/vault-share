import type { App } from 'obsidian';
import type { VaultShareSettings } from '../settings';
import type { Logger } from '../logger';
import type { SyncStore } from './store';
import type { StatsTracker } from './stats-tracker';
import type { LocalFs } from './local-fs';
import type { DriveFsAdapter } from './drive-fs';

/** File status relative to the last known sync record. */
export type FileStatus =
	| 'modified'
	| 'unmodified'
	| 'deleted'   // was in history, is now absent
	| 'absent';   // never appeared in history

/** One side's (local or remote) view of a file. */
export interface FileSide {
	path: string;
	mtime: number;  // epoch ms; 0 = unknown
	size: number;
}

/** Per-file sync record stored in IDB. */
export interface SyncRecord {
	path: string;
	driveFileId: string;
	localMtime: number;
	remoteMtime: number;
	localSize: number;
	remoteSize: number;
	syncedAt: number;
}

/** Joins local file info, remote file info, and stored history for one path. */
export interface MixedEntry {
	path: string;
	local?: FileSide;
	remote?: FileSide & { driveFileId: string };
	record?: SyncRecord;
}

export type SyncActionType =
	| 'push'          // local → remote
	| 'pull'          // remote → local
	| 'deleteRemote'  // delete from Drive
	| 'deleteLocal'   // delete from local vault
	| 'conflict'
	| 'noOp';

export interface SyncAction {
	type: SyncActionType;
	path: string;
	local?: FileSide;
	remote?: FileSide & { driveFileId: string };
	record?: SyncRecord;
}

/**
 * A planned sync action that has been deferred for manual user review.
 *
 * Stores only the minimal fields needed for auto-revocation (mtime comparison) and
 * manual review (driveFileId to fetch the group vault file). Persisted in IndexedDB
 * on the local device and never shared to other vaults.
 */
export interface DeferredCandidate {
	/** Vault path; used as the IndexedDB key. */
	path: string;
	/** The operation that bulk sync planned when this candidate was deferred. */
	actionType: SyncActionType;
	/** Local file mtime at deferral time; 0 if the local file was absent. */
	localMtime: number;
	/** Remote file mtime at deferral time; 0 if the remote file was absent. */
	remoteMtime: number;
	/** Drive file ID at deferral time; undefined if the remote file was absent. */
	driveFileId?: string;
	/** Epoch ms when the candidate was deferred. */
	deferredAt: number;
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
