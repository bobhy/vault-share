/**
 * One-shot action handlers wired to the per-row buttons in the Sharing Status
 * panel and the Pending List modal.
 *
 * Each `execute*` function performs exactly the action its button promises
 * (Proceed, Back out, Merge, Keep local/group vault, Delete both) and updates
 * the {@link CandidateStore} so the next planning pass observes the new
 * state. None of these functions touch the threshold guard or coalesce with
 * the scheduler — they are user-initiated overrides.
 *
 * @packageDocumentation
 */
import type { Candidate, SyncContext } from './types';
import type { CandidateStore } from './candidate-store';
import { syncOneFile } from './file-syncer';
import { reconcileText } from './nway-merge';

/** Pre-populated merge preview for the editable panel in PendingListModal. */
export interface MergePreview {
	/** The merged text to seed the editor (N-way markers when unresolved). */
	content: string;
	/** True when the preview still contains unresolved conflict markers. */
	hasConflicts: boolean;
}

/**
 * Execute the planned action for a candidate immediately.
 * Used by the **Proceed** button for push / pull / deleteLocal / deleteRemote candidates.
 *
 * Updates {@link CandidateStore} on success so the next planning pass does not
 * re-plan the same file.
 */
export async function executeAction(
	candidate: Candidate,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
	// Snapshot actionType before applyFileResult mutates the shared candidate.
	const actionType = candidate.actionType;
	const result = await syncOneFile(candidate, ctx, true);
	await candidateStore.applyFileResult(candidate.path, actionType, result);
}

/**
 * Execute the reverse of the planned action, discarding one side's version.
 * Used by the **Back out** button for non-conflict candidates.
 *
 * | Planned | Reverse |
 * |---------|---------|
 * | push    | Trash the local file and remove the candidate |
 * | pull    | Delete the Drive file and remove the candidate |
 * | deleteLocal | Restore the file from Drive to local |
 * | deleteRemote | Re-upload the local file to Drive |
 */
export async function executeBackOut(
	candidate: Candidate,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	const driveFileId = candidate.remote?.driveFileId ?? candidate.driveFileId;

	switch (candidate.actionType) {
		case 'push': {
			// Local has unsaved changes; back out = discard local.
			await ctx.localFs.delete(candidate.path);
			await candidateStore.remove(candidate.path);
			return;
		}

		case 'pull': {
			// Drive has a newer file we don't want; back out = delete from Drive.
			if (driveFileId) await ctx.driveFs.delete(driveFileId);
			await candidateStore.remove(candidate.path);
			return;
		}

		case 'deleteLocal': {
			// Remote deleted; back out = restore it from Drive.
			const fid = driveFileId;
			if (!fid) throw new Error(`No Drive file ID available to restore ${candidate.path}`);
			const content = await ctx.driveFs.readBinary(fid);
			await ctx.localFs.write(candidate.path, content);
			const localSide = ctx.localFs.stat(candidate.path);
			await candidateStore.markSynced(candidate.path, {
				driveFileId: fid,
				localMtime: localSide?.mtime ?? 0,
				localSize: localSide?.size ?? 0,
				remoteMtime: candidate.remote?.mtime ?? candidate.syncedRemoteMtime,
				remoteSize: candidate.remote?.size ?? candidate.syncedRemoteSize,
				syncedAt: Date.now(),
			});
			return;
		}

		case 'deleteRemote': {
			// Local deleted; back out = restore it to Drive from local.
			const content = await ctx.localFs.read(candidate.path);
			const driveSide = await ctx.driveFs.write(rootFolderId, candidate.path, content, ctx.statsTracker, sampler);
			const localSide = ctx.localFs.stat(candidate.path);
			await candidateStore.markSynced(candidate.path, {
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
export async function executeMerge(
	candidate: Candidate,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
	const mergeCtx: SyncContext = {
		...ctx,
		settings: () => ({ ...ctx.settings(), textFileConflict: 'Merge' }),
	};
	const forMerge: Candidate = { ...candidate, actionType: 'conflict' };
	const result = await syncOneFile(forMerge, mergeCtx, true);
	await candidateStore.applyFileResult(candidate.path, 'conflict', result);
}

/**
 * Resolve a binary conflict by keeping the local version (push local to Drive).
 * Used by the **Keep local** button for non-text-file conflict candidates.
 */
export async function executeKeepLocal(
	candidate: Candidate,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
	const forPush: Candidate = { ...candidate, actionType: 'push' };
	const result = await syncOneFile(forPush, ctx, true);
	await candidateStore.applyFileResult(candidate.path, 'push', result);
}

/**
 * Resolve a binary conflict by keeping the group vault version (pull Drive to local).
 * Used by the **Keep group vault** button for non-text-file conflict candidates.
 */
export async function executeKeepGroupVault(
	candidate: Candidate,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
	const forPull: Candidate = { ...candidate, actionType: 'pull' };
	const result = await syncOneFile(forPull, ctx, true);
	await candidateStore.applyFileResult(candidate.path, 'pull', result);
}

/**
 * Resolve a conflict by deleting both sides and removing the candidate.
 * Used by the **Delete both** button for non-text-file conflict candidates.
 */
export async function executeDeleteBoth(
	candidate: Candidate,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
	const driveFileId = candidate.remote?.driveFileId ?? candidate.driveFileId;
	await ctx.localFs.delete(candidate.path);
	if (driveFileId) await ctx.driveFs.delete(driveFileId);
	await candidateStore.remove(candidate.path);
}

/**
 * Compute the three-way merge result for a text-file conflict candidate.
 * Used to pre-populate the editable panel in PendingListModal before the user edits.
 * Does not write to either vault side.
 */
export async function computeMerge(candidate: Candidate, ctx: SyncContext): Promise<MergePreview> {
	const dec = new TextDecoder();
	const driveFileId = candidate.remote?.driveFileId ?? candidate.driveFileId;

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

	const result = reconcileText(baseText, localText, remoteText);
	// keep-both has no merged text to preview — fall back to local so the user
	// still sees content; the actual Merge action resolves it via resolveKeepBoth.
	if (result.kind === 'keepBoth') return { content: localText, hasConflicts: true };
	return { content: result.content, hasConflicts: result.kind === 'folded' };
}

/**
 * Write a pre-resolved merge result to both the local vault and Drive.
 * Used by the **Merge** button in PendingListModal after the user has edited the
 * merged content and confirmed there are no remaining conflict markers.
 */
export async function writeResolvedMerge(
	candidate: Candidate,
	mergedContent: string,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	const mergedBytes = new TextEncoder().encode(mergedContent).buffer;

	await ctx.localFs.write(candidate.path, mergedBytes);
	const driveSide = await ctx.driveFs.write(rootFolderId, candidate.path, mergedBytes, ctx.statsTracker, sampler);
	const localSide = ctx.localFs.stat(candidate.path);
	await ctx.store.putContent(candidate.path, mergedBytes);
	await candidateStore.markSynced(candidate.path, {
		driveFileId: driveSide.driveFileId,
		localMtime: localSide?.mtime ?? 0,
		localSize: localSide?.size ?? 0,
		remoteMtime: driveSide.mtime,
		remoteSize: driveSide.size,
		syncedAt: Date.now(),
	});
	ctx.statsTracker.recordMerge();
}

/**
 * Resolve a text-file conflict by restoring both sides to the last-synced common base.
 * Requires a cached base in the sync-content store; throws if none is available.
 * Used by the **Back out** button for text-file conflict candidates.
 */
export async function executeConflictBackOut(
	candidate: Candidate,
	ctx: SyncContext,
	candidateStore: CandidateStore,
): Promise<void> {
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
	await ctx.store.putContent(candidate.path, baseContent);
	await candidateStore.markSynced(candidate.path, {
		driveFileId: driveSide.driveFileId,
		localMtime: localSide?.mtime ?? 0,
		localSize: localSide?.size ?? 0,
		remoteMtime: driveSide.mtime,
		remoteSize: driveSide.size,
		syncedAt: Date.now(),
	});
}
