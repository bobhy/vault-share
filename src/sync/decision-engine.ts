import type { Candidate, FileSide, SyncActionType } from './types';

/**
 * One side's status relative to a candidate's last-sync record.
 *
 * Only meaningful for candidates that have actually been synced
 * (`candidate.syncedAt > 0`).  Brand-new candidates with no history are
 * classified by `planAction` directly from presence (see the no-history path
 * below) and never pass through `classifyStatus`.
 */
export type FileStatus =
	| 'modified'    // file exists and its mtime/size differ from the record
	| 'unmodified'  // file exists and its mtime/size match the record
	| 'deleted';    // file does not exist; the record says it once did

/**
 * Classify one side's status relative to a synced candidate's last-sync record.
 *
 * Precondition: the caller has already established that the candidate has a
 * sync record (`candidate.syncedAt > 0`).  {@link planAction} is the only
 * production caller and gates this check itself.
 */
export function classifyStatus(
	side: FileSide | undefined,
	syncedMtime: number,
	syncedSize: number,
): FileStatus {
	if (!side) return 'deleted';
	if (side.mtime === syncedMtime && side.size === syncedSize) return 'unmodified';
	return 'modified';
}

/**
 * Determine the sharing action for a single candidate given the current
 * local and remote file state and the candidate's last-sync history.
 *
 * This is the pure decision function used by {@link CandidateStore.reconcile}.
 * It is exported primarily for unit testing; production callers should invoke
 * it only through `CandidateStore`.
 *
 * @param candidate - Existing candidate record, or `null` for a brand-new path.
 * @param local     - Current local file metadata, or `undefined` if absent.
 * @param remote    - Current remote file metadata, or `undefined` if absent.
 * @param vaultHasHistory - Whether any candidate has been synced at least once.
 */
export function planAction(
	candidate: Candidate | null,
	local: FileSide | undefined,
	remote: (FileSide & { driveFileId: string }) | undefined,
	vaultHasHistory: boolean,
): SyncActionType {
	const wasSynced = (candidate?.syncedAt ?? 0) > 0;

	if (!vaultHasHistory || !wasSynced) {
		// No-history path: decide purely on presence.
		if (local && !remote) return 'push';
		if (!local && remote) return 'pull';
		if (local && remote) return 'conflict';
		return 'noOp';
	}

	// With-history path: compare against the candidate's last-sync record.
	const syncedLocalMtime  = candidate?.syncedLocalMtime  ?? 0;
	const syncedLocalSize   = candidate?.syncedLocalSize   ?? 0;
	const syncedRemoteMtime = candidate?.syncedRemoteMtime ?? 0;
	const syncedRemoteSize  = candidate?.syncedRemoteSize  ?? 0;

	const localStatus  = classifyStatus(local,  syncedLocalMtime,  syncedLocalSize);
	const remoteStatus = classifyStatus(remote, syncedRemoteMtime, syncedRemoteSize);

	if (localStatus === 'modified'  && remoteStatus === 'unmodified') return 'push';
	if (localStatus === 'unmodified' && remoteStatus === 'modified')   return 'pull';
	if (localStatus === 'deleted'   && remoteStatus === 'unmodified') return 'deleteRemote';
	if (localStatus === 'unmodified' && remoteStatus === 'deleted')    return 'deleteLocal';
	// Both sides deleted: clean up the orphaned record.
	if (localStatus === 'deleted'   && remoteStatus === 'deleted')     return 'deleteLocal';
	if (
		(localStatus === 'deleted'  && remoteStatus === 'modified') ||
		(localStatus === 'modified' && remoteStatus === 'deleted')  ||
		(localStatus === 'modified' && remoteStatus === 'modified')
	) return 'conflict';

	// (unmodified, unmodified) — both sides match the record. No action needed.
	return 'noOp';
}
