import type { SyncAction, SyncActionType, SyncContext, ViewCandidate } from './types';
import { syncOneFile } from './file-syncer';
import { threeWayMerge, type MergeResult } from './merge';

/**
 * Reconstruct a full {@link SyncAction} from a {@link ViewCandidate} by looking up
 * the current local stat and sync record.  Used by all resolution functions to avoid
 * re-running the full planning pass.
 *
 * @param overrideType - When supplied, replaces `candidate.actionType` in the returned
 *   action (e.g. pass `'push'` to implement "Keep local" for a binary conflict).
 */
async function reconstructAction(
	candidate: ViewCandidate,
	ctx: SyncContext,
	overrideType?: Exclude<SyncActionType, 'noOp'>,
): Promise<SyncAction> {
	const record = await ctx.store.getRecord(candidate.path);
	const local = ctx.localFs.stat(candidate.path) ?? undefined;
	const driveFileId = candidate.driveFileId ?? record?.driveFileId;
	const remote = driveFileId
		? {
			path: candidate.path,
			driveFileId,
			mtime: record?.remoteMtime ?? 0,
			size: record?.remoteSize ?? 0,
		}
		: undefined;
	return {
		type: overrideType ?? candidate.actionType,
		path: candidate.path,
		local,
		remote,
		record,
	};
}

/**
 * Execute the planned action for a candidate immediately.
 * Used by the **Proceed** button for push / pull / deleteLocal / deleteRemote candidates.
 */
export async function executeAction(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const action = await reconstructAction(candidate, ctx);
	await syncOneFile(action, ctx, true);
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

	switch (candidate.actionType) {
		case 'push': {
			// Local has unsaved changes; back out = discard local.
			await ctx.localFs.delete(candidate.path);
			await ctx.store.deleteRecord(candidate.path);
			return;
		}

		case 'pull': {
			// Drive has a newer file we don't want; back out = delete from Drive.
			const record = await ctx.store.getRecord(candidate.path);
			const driveFileId = candidate.driveFileId ?? record?.driveFileId;
			if (driveFileId) await ctx.driveFs.delete(driveFileId);
			await ctx.store.deleteRecord(candidate.path);
			return;
		}

		case 'deleteLocal': {
			// Remote deleted; back out = restore it from Drive.
			const record = await ctx.store.getRecord(candidate.path);
			const driveFileId = candidate.driveFileId ?? record?.driveFileId;
			if (!driveFileId) throw new Error(`No Drive file ID available to restore ${candidate.path}`);
			const content = await ctx.driveFs.readBinary(driveFileId);
			await ctx.localFs.write(candidate.path, content);
			const localSide = ctx.localFs.stat(candidate.path);
			const remoteMtime = record?.remoteMtime ?? 0;
			const remoteSize = record?.remoteSize ?? 0;
			await ctx.store.putRecord({
				path: candidate.path,
				driveFileId,
				localMtime: localSide?.mtime ?? 0,
				localSize: localSide?.size ?? 0,
				remoteMtime,
				remoteSize,
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
			throw new Error(`executeBackOut: unsupported action type '${candidate.actionType}'`);
	}
}

/**
 * Resolve a text-file conflict by running a diff3 three-way merge regardless of the
 * current `textFileConflict` setting.
 * Used by the **Merge** button for text-file conflict candidates.
 */
export async function executeMerge(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const action = await reconstructAction(candidate, ctx, 'conflict');
	const mergeCtx: SyncContext = {
		...ctx,
		settings: () => ({ ...ctx.settings(), textFileConflict: 'Merge' }),
	};
	await syncOneFile(action, mergeCtx, true);
}

/**
 * Resolve a binary conflict by keeping the local version (push local to Drive).
 * Used by the **Keep local** button for non-text-file conflict candidates.
 */
export async function executeKeepLocal(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const action = await reconstructAction(candidate, ctx, 'push');
	await syncOneFile(action, ctx, true);
}

/**
 * Resolve a binary conflict by keeping the group vault version (pull Drive to local).
 * Used by the **Keep group vault** button for non-text-file conflict candidates.
 */
export async function executeKeepGroupVault(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const action = await reconstructAction(candidate, ctx, 'pull');
	await syncOneFile(action, ctx, true);
}

/**
 * Resolve a conflict by deleting both sides and the sync record.
 * Used by the **Delete both** button for non-text-file conflict candidates.
 */
export async function executeDeleteBoth(candidate: ViewCandidate, ctx: SyncContext): Promise<void> {
	const record = await ctx.store.getRecord(candidate.path);
	const driveFileId = candidate.driveFileId ?? record?.driveFileId;
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
	const record = await ctx.store.getRecord(candidate.path);
	const driveFileId = candidate.driveFileId ?? record?.driveFileId;

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
