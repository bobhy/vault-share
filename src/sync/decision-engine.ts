import type { MixedEntry, SyncAction, SyncActionType, FileStatus } from './types';
import { classifyStatus } from './change-detector';

/**
 * Produce a sync action for each mixed entry.
 * When hasHistory is false, uses the no-history table from the spec.
 * When hasHistory is true, uses the with-history table.
 * 'noOp' entries are included; callers may filter them.
 */
export function planActions(entries: MixedEntry[], hasHistory: boolean): SyncAction[] {
	return entries.map(entry => hasHistory
		? planWithHistory(entry)
		: planWithoutHistory(entry),
	);
}

/** No-history decision table (spec §"No sync history"). */
function planWithoutHistory(entry: MixedEntry): SyncAction {
	const { local, remote } = entry;

	if (local && !remote) {
		return action('push', entry);
	}
	if (!local && remote) {
		return action('pull', entry);
	}
	if (local && remote) {
		return action('conflict', entry);
	}
	// Neither side present — can happen if a record exists for a path now gone everywhere.
	return action('noOp', entry);
}

/** With-history decision table (spec §"With sync history"). */
function planWithHistory(entry: MixedEntry): SyncAction {
	const { local, remote, record } = entry;
	const localStatus: FileStatus = classifyStatus(local, record, true);
	const remoteStatus: FileStatus = classifyStatus(remote, record, false);

	// modified | absent or unmodified → push
	if (localStatus === 'modified' && (remoteStatus === 'absent' || remoteStatus === 'unmodified')) {
		return action('push', entry);
	}
	// absent or unmodified | modified → pull
	if ((localStatus === 'absent' || localStatus === 'unmodified') && remoteStatus === 'modified') {
		return action('pull', entry);
	}
	// deleted | unmodified → delete remote
	if (localStatus === 'deleted' && remoteStatus === 'unmodified') {
		return action('deleteRemote', entry);
	}
	// unmodified | deleted → delete local
	if (localStatus === 'unmodified' && remoteStatus === 'deleted') {
		return action('deleteLocal', entry);
	}
	// deleted | deleted → both gone simultaneously; clean up the orphaned record.
	// localFs.delete is a no-op when the file is already absent.
	if (localStatus === 'deleted' && remoteStatus === 'deleted') {
		return action('deleteLocal', entry);
	}
	// deleted | modified  or  modified | deleted → conflict
	if (
		(localStatus === 'deleted' && remoteStatus === 'modified') ||
		(localStatus === 'modified' && remoteStatus === 'deleted')
	) {
		return action('conflict', entry);
	}
	// modified | modified → conflict
	if (localStatus === 'modified' && remoteStatus === 'modified') {
		return action('conflict', entry);
	}
	// unmodified | unmodified, absent | absent, etc.
	return action('noOp', entry);
}

function action(type: SyncActionType, entry: MixedEntry): SyncAction {
	return {
		type,
		path: entry.path,
		local: entry.local,
		remote: entry.remote,
		record: entry.record,
	};
}
