import type { FileSide, MixedEntry, SyncRecord, FileStatus } from './types';
import type { DriveFileSide } from './drive-fs';

/**
 * Join local file listing, remote Drive listing, and stored sync records
 * into a per-path MixedEntry array. Directories are omitted (callers pass
 * only file listings, not directory entries).
 */
export function buildMixedEntries(
	localFiles: FileSide[],
	remoteFiles: DriveFileSide[],
	records: SyncRecord[],
): MixedEntry[] {
	const byPath = new Map<string, MixedEntry>();

	const getOrCreate = (path: string): MixedEntry => {
		let e = byPath.get(path);
		if (!e) {
			e = { path };
			byPath.set(path, e);
		}
		return e;
	};

	for (const f of localFiles) {
		getOrCreate(f.path).local = f;
	}

	for (const f of remoteFiles) {
		const entry = getOrCreate(f.path);
		entry.remote = f;
	}

	for (const r of records) {
		getOrCreate(r.path).record = r;
	}

	return Array.from(byPath.values());
}

/**
 * Classify one side's status relative to the stored sync record.
 *
 * - 'absent'     — file does not exist and there is no sync record
 * - 'deleted'    — file does not exist but has a sync record (was once present)
 * - 'unmodified' — file exists and its mtime/size match the record
 * - 'modified'   — file exists and differs from the record
 */
export function classifyStatus(
	side: FileSide | undefined,
	record: SyncRecord | undefined,
	isLocal: boolean,
): FileStatus {
	if (!side) {
		return record ? 'deleted' : 'absent';
	}
	if (!record) {
		return 'modified'; // present but no history — treat as modified (new)
	}
	const recordMtime = isLocal ? record.localMtime : record.remoteMtime;
	const recordSize = isLocal ? record.localSize : record.remoteSize;

	if (side.mtime === recordMtime && side.size === recordSize) {
		return 'unmodified';
	}
	return 'modified';
}
