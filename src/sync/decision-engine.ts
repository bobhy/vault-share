import type { Candidate, FileSide, SyncActionType } from './types';

/** File status relative to the last known sync record. */
export type FileStatus =
	| 'modified'
	| 'unmodified'
	| 'deleted'   // was in history, is now absent
	| 'absent';   // never appeared in history

/**
 * Classify one side's status relative to the candidate's last-sync record.
 *
 * - `absent`     — file does not exist and was never synced (`wasSynced = false`)
 * - `deleted`    — file does not exist but has a sync record (`wasSynced = true`)
 * - `unmodified` — file exists and its mtime/size match the record
 * - `modified`   — file exists and differs from the record
 */
export function classifyStatus(
	side: FileSide | undefined,
	syncedMtime: number,
	syncedSize: number,
	wasSynced: boolean,  // = candidate.syncedAt > 0
): FileStatus {
	if (!side) {
		return wasSynced ? 'deleted' : 'absent';
	}
	if (!wasSynced) {
		return 'modified'; // present but no history — treat as modified (new)
	}
	if (side.mtime === syncedMtime && side.size === syncedSize) {
		return 'unmodified';
	}
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

	const localStatus  = classifyStatus(local,  syncedLocalMtime,  syncedLocalSize,  wasSynced);
	const remoteStatus = classifyStatus(remote, syncedRemoteMtime, syncedRemoteSize, wasSynced);

	if (localStatus === 'modified' && (remoteStatus === 'absent' || remoteStatus === 'unmodified')) return 'push';
	if ((localStatus === 'absent' || localStatus === 'unmodified') && remoteStatus === 'modified') return 'pull';
	if (localStatus === 'deleted' && remoteStatus === 'unmodified') return 'deleteRemote';
	if (localStatus === 'unmodified' && remoteStatus === 'deleted') return 'deleteLocal';
	// Both sides deleted: clean up the orphaned record.
	if (localStatus === 'deleted' && remoteStatus === 'deleted') return 'deleteLocal';
	if (
		(localStatus === 'deleted'   && remoteStatus === 'modified') ||
		(localStatus === 'modified'  && remoteStatus === 'deleted')  ||
		(localStatus === 'modified'  && remoteStatus === 'modified')
	) return 'conflict';

	// unmodified | unmodified, absent | absent, etc.
	return 'noOp';
}
