import type { SyncContext, ViewCandidate } from './types';
import { syncOneFile } from './file-syncer';
import { threeWayMerge, type MergeResult } from './merge';

/**
 * Execute the planned action for a candidate immediately.
 * Used by the **Proceed** button for push / pull / deleteLocal / deleteRemote candidates.
 *
 * Since {@link ViewCandidate} extends {@link SyncAction}, the candidate is passed
 * directly to {@link syncOneFile} without any reconstruction step.
 */
export async function executeAction(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	await syncOneFile(candidate, ctx, true);
}

/**
 * Execute the reverse of the planned action, discarding one side's version.
 * Used by the **Back out** button for non-conflict candidates.
 *
 * | Planned | Reverse |
 * |---------|---------|
 * | push    | Trash the local file and delete the sync record |
 * | pull    | Delete the Drive file and delete the sync record |
 * | deleteLocal | Restore the file from Drive to local |
 * | deleteRemote | Re-upload the local file to Drive |
 */
export async function executeBackOut(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };

	switch (candidate.type) {
		case 'push': {
			// Local has unsaved changes; back out = discard local.
			await ctx.localFs.delete(candidate.path);
			await ctx.store.deleteRecord(candidate.path);
			return;
		}

		case 'pull': {
			// Drive has a newer file we don't want; back out = delete from Drive.
			const driveFileId = candidate.remote?.driveFileId ?? candidate.record?.driveFileId;
			if (driveFileId) await ctx.driveFs.delete(driveFileId);
			await ctx.store.deleteRecord(candidate.path);
			return;
		}

		case 'deleteLocal': {
			// Remote deleted; back out = restore it from Drive.
			const driveFileId = candidate.remote?.driveFileId ?? candidate.record?.driveFileId;
			if (!driveFileId) throw new Error(`No Drive file ID available to restore ${candidate.path}`);
			const content = await ctx.driveFs.readBinary(driveFileId);
			await ctx.localFs.write(candidate.path, content);
			const localSide = ctx.localFs.stat(candidate.path);
			await ctx.store.putRecord({
				path: candidate.path,
				driveFileId,
				localMtime: localSide?.mtime ?? 0,
				localSize: localSide?.size ?? 0,
				remoteMtime: candidate.remote?.mtime ?? 0,
				remoteSize: candidate.remote?.size ?? 0,
				syncedAt: Date.now(),
			});
			return;
		}

		case 'deleteRemote': {
			// Local deleted; back out = restore it to Drive from local.
			const content = await ctx.localFs.read(candidate.path);
			const driveSide = await ctx.driveFs.write(rootFolderId, candidate.path, content, ctx.statsTracker, sampler);
			const localSide = ctx.localFs.stat(candidate.path);
			await ctx.store.putRecord({
				path: candidate.path,
				driveFileId: driveSide.driveFileId,
				localMtime: localSide?.mtime ?? 0,
				localSize: localSide?.size ?? 0,
				remoteMtime: driveSide.mtime,
				remoteSize: driveSide.size,
				syncedAt: Date.now(),
			});
			return;
		}

		default:
			throw new Error(`executeBackOut: unsupported action type '${candidate.type}'`);
	}
}

/**
 * Resolve a text-file conflict by running a diff3 three-way merge regardless of the
 * current `textFileConflict` setting.
 * Used by the **Merge** button for text-file conflict candidates.
 */
export async function executeMerge(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const mergeCtx: SyncContext = {
		...ctx,
		settings: () => ({ ...ctx.settings(), textFileConflict: 'Merge' }),
	};
	await syncOneFile({ ...candidate, type: 'conflict' }, mergeCtx, true);
}

/**
 * Resolve a binary conflict by keeping the local version (push local to Drive).
 * Used by the **Keep local** button for non-text-file conflict candidates.
 */
export async function executeKeepLocal(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	await syncOneFile({ ...candidate, type: 'push' }, ctx, true);
}

/**
 * Resolve a binary conflict by keeping the group vault version (pull Drive to local).
 * Used by the **Keep group vault** button for non-text-file conflict candidates.
 */
export async function executeKeepGroupVault(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	await syncOneFile({ ...candidate, type: 'pull' }, ctx, true);
}

/**
 * Resolve a conflict by deleting both sides and the sync record.
 * Used by the **Delete both** button for non-text-file conflict candidates.
 */
export async function executeDeleteBoth(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const driveFileId = candidate.remote?.driveFileId ?? candidate.record?.driveFileId;
	await ctx.localFs.delete(candidate.path);
	if (driveFileId) await ctx.driveFs.delete(driveFileId);
	await ctx.store.deleteRecord(candidate.path);
}

/**
 * Compute the three-way merge result for a text-file conflict candidate.
 * Used to pre-populate the editable panel in PendingListModal before the user edits.
 * Does not write to either vault side.
 */
export async function computeMerge(candidate: ViewCandidate, ctx: SyncContext): Promise<MergeResult> {
	const dec = new TextDecoder();
	const driveFileId = candidate.remote?.driveFileId ?? candidate.record?.driveFileId;

	const localBytes = await ctx.localFs.read(candidate.path);
	const localText = dec.decode(localBytes);

	let remoteText = '';
	if (driveFileId) {
		const remoteBytes = await ctx.driveFs.readBinary(driveFileId);
		remoteText = dec.decode(remoteBytes);
	}

	let baseText = '';
	const baseBytes = await ctx.store.getContent(candidate.path);
	if (baseBytes) baseText = dec.decode(baseBytes);

	return threeWayMerge(baseText, localText, remoteText);
}

/**
 * Write a pre-resolved merge result to both the local vault and Drive.
 * Used by the **Merge** button in PendingListModal after the user has edited the
 * merged content and confirmed there are no remaining conflict markers.
 */
export async function writeResolvedMerge(
	candidate: ViewCandidate,
	mergedContent: string,
	ctx: SyncContext,
): Promise<void> {
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	const mergedBytes = new TextEncoder().encode(mergedContent).buffer;

	await ctx.localFs.write(candidate.path, mergedBytes);
	const driveSide = await ctx.driveFs.write(rootFolderId, candidate.path, mergedBytes, ctx.statsTracker, sampler);
	const localSide = ctx.localFs.stat(candidate.path);
	await ctx.store.putRecord({
		path: candidate.path,
		driveFileId: driveSide.driveFileId,
		localMtime: localSide?.mtime ?? 0,
		localSize: localSide?.size ?? 0,
		remoteMtime: driveSide.mtime,
		remoteSize: driveSide.size,
		syncedAt: Date.now(),
	});
	await ctx.store.putContent(candidate.path, mergedBytes);
	ctx.statsTracker.recordMerge();
}

/**
 * Resolve a text-file conflict by restoring both sides to the last-synced common base.
 * Requires a cached base in the sync-content store; throws if none is available.
 * Used by the **Back out** button for text-file conflict candidates.
 */
export async function executeConflictBackOut(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const baseContent = await ctx.store.getContent(candidate.path);
	if (!baseContent) {
		throw new Error(
			`No cached base content for ${candidate.path} — cannot restore common base`,
		);
	}
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	await ctx.localFs.write(candidate.path, baseContent);
	const driveSide = await ctx.driveFs.write(rootFolderId, candidate.path, baseContent, ctx.statsTracker, sampler);
	const localSide = ctx.localFs.stat(candidate.path);
	await ctx.store.putRecord({
		path: candidate.path,
		driveFileId: driveSide.driveFileId,
		localMtime: localSide?.mtime ?? 0,
		localSize: localSide?.size ?? 0,
		remoteMtime: driveSide.mtime,
		remoteSize: driveSide.size,
		syncedAt: Date.now(),
	});
	await ctx.store.putContent(candidate.path, baseContent);
}
