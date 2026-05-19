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

/** Result of a single bulk sync pass. */
export interface SyncPassResult {
	downloaded: number;
	uploaded: number;
	deleted: number;
	conflicts: number;
	merges: number;
	abortedByUser: boolean;
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

	/** Epoch ms when stats were last reset; 0 = never. */
	statsResetAt: number;

	/** Google Drive API call counts (one counter per public GDriveApi method). */
	driveListChildren: number;
	driveGetFile: number;
	driveReadFile: number;
	driveReadFileBinary: number;
	driveWriteFile: number;
	driveDeleteFile: number;
	driveCreateFolder: number;
	driveResolveFolder: number;
	driveFindFolder: number;
	driveFindFile: number;
}

/** Snapshot of what a bulk-sync pass would do at a given moment. */
export interface SyncPreviewResult {
	/** Drive-side changes (files pushed to the group vault). */
	groupNew: number;
	groupUpdated: number;
	groupDeleted: number;

	/** Local-side changes (files pulled to this vault). */
	localNew: number;
	localUpdated: number;
	localDeleted: number;

	/** Conflict breakdown. */
	contentConflicts: number;
	deleteConflicts: number;
	/** Content conflicts on .md/.txt files where the Merge strategy applies. */
	textMergeFiles: number;

	/** Epoch ms when this snapshot was taken. */
	collectedAt: number;
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
