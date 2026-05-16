import type { SyncAction, SyncContext } from './types';
import { resolveConflict } from './conflict-resolver';

export interface FileSyncResult {
	changed: boolean;
	conflictLocalPath?: string;
	conflictRemotePath?: string;
	merged: boolean;
	hadConflictMarkers: boolean;
}

/**
 * Execute one sync action end-to-end:
 * 1. Execute push / pull / delete / conflict per the action type
 * 2. Update sync-records and sync-content in the store
 * Returns the outcome for the caller to display or handle.
 */
export async function syncOneFile(
	action: SyncAction,
	ctx: SyncContext,
	_hasHistory: boolean,
): Promise<FileSyncResult> {
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };

	switch (action.type) {
		case 'noOp':
			return { changed: false, merged: false, hadConflictMarkers: false };

		case 'push': {
			const content = await ctx.localFs.read(action.path);
			const driveSide = await ctx.driveFs.write(rootFolderId, action.path, content, ctx.statsTracker, sampler);
			ctx.statsTracker.recordPush();
			const localSide = action.local ?? ctx.localFs.stat(action.path);
			await ctx.store.putRecord({
				path: action.path,
				driveFileId: driveSide.driveFileId,
				localMtime: localSide?.mtime ?? 0,
				remoteMtime: driveSide.mtime,
				localSize: localSide?.size ?? 0,
				remoteSize: driveSide.size,
				syncedAt: Date.now(),
			});
			await ctx.store.putContent(action.path, content);
			return { changed: true, merged: false, hadConflictMarkers: false };
		}

		case 'pull': {
			const driveFileId = action.remote?.driveFileId
				?? (await ctx.driveFs.stat(rootFolderId, action.path))?.driveFileId;
			if (!driveFileId) {
				ctx.logger.warning(`pull: Drive file not found for ${action.path}`);
				return { changed: false, merged: false, hadConflictMarkers: false };
			}
			const content = await ctx.driveFs.readBinary(driveFileId);
			await ctx.localFs.write(action.path, content);
			ctx.statsTracker.recordPull();
			// Re-stat after write: size and mtime must reflect the written content, not
			// action.local which carries pre-pull values and would cause a false push on
			// the next poll when the pulled file is a different size.
			const localSide = ctx.localFs.stat(action.path);
			const remoteSide = action.remote;
			await ctx.store.putRecord({
				path: action.path,
				driveFileId: remoteSide?.driveFileId ?? driveFileId,
				localMtime: localSide?.mtime ?? 0,
				localSize: localSide?.size ?? 0,
				remoteMtime: remoteSide?.mtime ?? 0,
				remoteSize: remoteSide?.size ?? 0,
				syncedAt: Date.now(),
			});
			await ctx.store.putContent(action.path, content);
			return { changed: true, merged: false, hadConflictMarkers: false };
		}

		case 'deleteRemote': {
			const driveFileId = action.remote?.driveFileId
				?? (await ctx.driveFs.stat(rootFolderId, action.path))?.driveFileId;
			if (driveFileId) await ctx.driveFs.delete(driveFileId);
			await ctx.store.deleteRecord(action.path);
			return { changed: true, merged: false, hadConflictMarkers: false };
		}

		case 'deleteLocal': {
			await ctx.localFs.delete(action.path);
			await ctx.store.deleteRecord(action.path);
			return { changed: true, merged: false, hadConflictMarkers: false };
		}

		case 'conflict': {
			const { fileConflict, textFileConflict } = ctx.settings();
			const conflictResult = await resolveConflict(action, fileConflict, textFileConflict, ctx);
			const resolvedInPlace = conflictResult.merged
				|| (!conflictResult.localConflictPath && !conflictResult.remoteConflictPath);
			if (resolvedInPlace) {
				// Merged or Use Newer: both sides now agree on the original path.
				// Re-stat Drive to get the post-write mtime; action.remote carries the
				// pre-write value and would make remote appear modified on the next poll.
				const content = await ctx.localFs.read(action.path);
				const localSide = ctx.localFs.stat(action.path);
				const freshRemote = await ctx.driveFs.stat(rootFolderId, action.path);
				await ctx.store.putRecord({
					path: action.path,
					driveFileId: freshRemote?.driveFileId ?? action.remote?.driveFileId ?? '',
					localMtime: localSide?.mtime ?? 0,
					remoteMtime: freshRemote?.mtime ?? 0,
					localSize: localSide?.size ?? 0,
					remoteSize: freshRemote?.size ?? 0,
					syncedAt: Date.now(),
				});
				await ctx.store.putContent(action.path, content);
			} else {
				// Keep Both or delete-conflict: original path is gone; conflict files
				// already have their own records written by resolveConflict.
				await ctx.store.deleteRecord(action.path);
			}
			return {
				changed: true,
				conflictLocalPath: conflictResult.localConflictPath,
				conflictRemotePath: conflictResult.remoteConflictPath,
				merged: conflictResult.merged,
				hadConflictMarkers: conflictResult.hadConflictMarkers,
			};
		}
	}
}


