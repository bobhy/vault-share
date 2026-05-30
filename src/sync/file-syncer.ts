import type { Candidate, SyncContext, SyncFileResult } from './types';
import { resolveConflict } from './conflict-resolver';

/**
 * Execute one sync action end-to-end:
 * 1. Execute push / pull / delete / conflict per the candidate's `actionType`
 * 2. Cache merge-base content in `sync-content` for future conflict resolution
 *
 * Returns the outcome.  For push / pull / conflict resolutions, `syncedState`
 * carries the post-sync file metadata so the caller can call
 * `candidateStore.markSynced()` without this function needing a store reference.
 * For delete actions and no-ops, `syncedState` is `undefined`.
 */
export async function syncOneFile(
	candidate: Candidate,
	ctx: SyncContext,
	_hasHistory: boolean,
): Promise<SyncFileResult> {
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };

	switch (candidate.actionType) {
		case 'noOp':
			return { changed: false, merged: false, hadConflictMarkers: false };

		case 'push': {
			const content = await ctx.localFs.read(candidate.path);
			const driveSide = await ctx.driveFs.write(rootFolderId, candidate.path, content, ctx.statsTracker, sampler);
			ctx.statsTracker.recordPush();
			const localSide = candidate.local ?? ctx.localFs.stat(candidate.path);
			await ctx.store.putContent(candidate.path, content);
			return {
				changed: true,
				merged: false,
				hadConflictMarkers: false,
				syncedState: {
					driveFileId: driveSide.driveFileId,
					localMtime: localSide?.mtime ?? 0,
					remoteMtime: driveSide.mtime,
					localSize: localSide?.size ?? 0,
					remoteSize: driveSide.size,
					syncedAt: Date.now(),
				},
			};
		}

		case 'pull': {
			const driveFileId = candidate.remote?.driveFileId
				?? (await ctx.driveFs.stat(rootFolderId, candidate.path))?.driveFileId;
			if (!driveFileId) {
				ctx.logger.warning(`pull: Drive file not found for ${candidate.path}`);
				return { changed: false, merged: false, hadConflictMarkers: false };
			}
			const content = await ctx.driveFs.readBinary(driveFileId);
			await ctx.localFs.write(candidate.path, content);
			ctx.statsTracker.recordPull();
			// Re-stat after write: size and mtime must reflect the written content, not
			// candidate.local which carries pre-pull values and would cause a false push
			// on the next poll when the pulled file is a different size.
			const localSide = ctx.localFs.stat(candidate.path);
			const remoteSide = candidate.remote;
			await ctx.store.putContent(candidate.path, content);
			return {
				changed: true,
				merged: false,
				hadConflictMarkers: false,
				syncedState: {
					driveFileId: remoteSide?.driveFileId ?? driveFileId,
					localMtime: localSide?.mtime ?? 0,
					localSize: localSide?.size ?? 0,
					remoteMtime: remoteSide?.mtime ?? 0,
					remoteSize: remoteSide?.size ?? 0,
					syncedAt: Date.now(),
				},
			};
		}

		case 'deleteRemote': {
			const driveFileId = candidate.remote?.driveFileId
				?? (await ctx.driveFs.stat(rootFolderId, candidate.path))?.driveFileId;
			if (driveFileId) await ctx.driveFs.delete(driveFileId);
			await ctx.store.deleteContent(candidate.path);
			return { changed: true, merged: false, hadConflictMarkers: false };
		}

		case 'deleteLocal': {
			await ctx.localFs.delete(candidate.path);
			await ctx.store.deleteContent(candidate.path);
			return { changed: true, merged: false, hadConflictMarkers: false };
		}

		case 'conflict': {
			const { fileConflict, textFileConflict } = ctx.settings();
			const conflictResult = await resolveConflict(candidate, fileConflict, textFileConflict, ctx);
			// "In place" = the original path now has coherent content on both
			// sides and the caller should build a `syncedState` for it.
			//   - Merge: `merged` is true.
			//   - Use Newer: no `newSyncedFiles`.
			//   - Modify-delete (item 14): `restoredOriginal` is true and a
			//     placeholder is in `newSyncedFiles`. Both must be processed.
			// Keep Both is the only remaining case — it renames the original
			// aside and leaves nothing at `candidate.path`, so we fall through
			// to the else branch.
			const resolvedInPlace = conflictResult.merged
				|| conflictResult.restoredOriginal
				|| !conflictResult.newSyncedFiles?.length;
			if (resolvedInPlace) {
				// Re-stat Drive to get the post-write mtime; candidate.remote carries the
				// pre-write value and would make remote appear modified on the next poll.
				const content = await ctx.localFs.read(candidate.path);
				const localSide = ctx.localFs.stat(candidate.path);
				const freshRemote = await ctx.driveFs.stat(rootFolderId, candidate.path);
				await ctx.store.putContent(candidate.path, content);
				return {
					changed: true,
					merged: conflictResult.merged,
					hadConflictMarkers: conflictResult.hadConflictMarkers,
					syncedState: {
						driveFileId: freshRemote?.driveFileId ?? candidate.remote?.driveFileId ?? candidate.driveFileId,
						localMtime: localSide?.mtime ?? 0,
						remoteMtime: freshRemote?.mtime ?? 0,
						localSize: localSide?.size ?? 0,
						remoteSize: freshRemote?.size ?? 0,
						syncedAt: Date.now(),
					},
					// `undefined` for Merge / Use Newer (resolver returned no
					// new files), the placeholder for delete-conflict.
					newSyncedFiles: conflictResult.newSyncedFiles,
				};
			}
			// Keep Both: original path is gone; conflict-copy files are
			// recorded via newSyncedFiles so the next pass won't re-plan them.
			await ctx.store.deleteContent(candidate.path);
			return {
				changed: true,
				merged: conflictResult.merged,
				hadConflictMarkers: conflictResult.hadConflictMarkers,
				newSyncedFiles: conflictResult.newSyncedFiles,
			};
		}
	}
}
