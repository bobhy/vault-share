import { describe, it, expect } from 'vitest';
import type { FileSide, SyncRecord } from './types';
import type { DriveFileSide } from './drive-fs';
import { buildMixedEntries, classifyStatus } from './change-detector';

function makeLocal(path: string, mtime = 1000, size = 100): FileSide {
	return { path, mtime, size };
}

function makeRemote(path: string, mtime = 2000, size = 200): DriveFileSide {
	return { path, driveFileId: `id-${path}`, mtime, size };
}

function makeRecord(path: string, localMtime = 1000, remoteMtime = 2000, localSize = 100, remoteSize = 200): SyncRecord {
	return { path, driveFileId: `id-${path}`, localMtime, remoteMtime, localSize, remoteSize, syncedAt: 0 };
}

describe('buildMixedEntries', () => {
	it('produces one entry per unique path across all three inputs', () => {
		const entries = buildMixedEntries(
			[makeLocal('a.md'), makeLocal('b.md')],
			[makeRemote('b.md'), makeRemote('c.md')],
			[makeRecord('c.md'), makeRecord('d.md')],
		);
		const paths = entries.map(e => e.path).sort();
		expect(paths).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
	});

	it('attaches local, remote, and record to the correct entry', () => {
		const local = makeLocal('note.md', 1111, 10);
		const remote = makeRemote('note.md', 2222, 20);
		const record = makeRecord('note.md', 1111, 2222, 10, 20);

		const [entry] = buildMixedEntries([local], [remote], [record]);
		expect(entry!.local).toEqual(local);
		expect(entry!.remote).toEqual(remote);
		expect(entry!.record).toEqual(record);
	});

	it('sets only local when file is local-only', () => {
		const [entry] = buildMixedEntries([makeLocal('local-only.md')], [], []);
		expect(entry!.local).toBeDefined();
		expect(entry!.remote).toBeUndefined();
		expect(entry!.record).toBeUndefined();
	});

	it('sets only remote when file is remote-only', () => {
		const [entry] = buildMixedEntries([], [makeRemote('remote-only.md')], []);
		expect(entry!.local).toBeUndefined();
		expect(entry!.remote).toBeDefined();
		expect(entry!.record).toBeUndefined();
	});

	it('sets only record when file is in history only', () => {
		const [entry] = buildMixedEntries([], [], [makeRecord('ghost.md')]);
		expect(entry!.local).toBeUndefined();
		expect(entry!.remote).toBeUndefined();
		expect(entry!.record).toBeDefined();
	});

	it('returns empty array for empty inputs', () => {
		expect(buildMixedEntries([], [], [])).toEqual([]);
	});
});

describe('classifyStatus', () => {
	it('returns absent when no side and no record exist', () => {
		expect(classifyStatus(undefined, undefined, true)).toBe('absent');
	});

	it('returns deleted when no side but a record exists', () => {
		expect(classifyStatus(undefined, makeRecord('f.md'), true)).toBe('deleted');
		expect(classifyStatus(undefined, makeRecord('f.md'), false)).toBe('deleted');
	});

	it('returns modified for a new file with no sync record', () => {
		expect(classifyStatus(makeLocal('new.md'), undefined, true)).toBe('modified');
		expect(classifyStatus(makeRemote('new.md'), undefined, false)).toBe('modified');
	});

	it('returns unmodified when local mtime and size match the record', () => {
		const local = makeLocal('f.md', 500, 42);
		const record = makeRecord('f.md', 500, 999, 42, 0);
		expect(classifyStatus(local, record, true)).toBe('unmodified');
	});

	it('returns modified when local mtime differs from the record', () => {
		const local = makeLocal('f.md', 999, 42);
		const record = makeRecord('f.md', 500, 999, 42, 0);
		expect(classifyStatus(local, record, true)).toBe('modified');
	});

	it('returns unmodified when remote mtime and size match the record', () => {
		const remote = makeRemote('f.md', 800, 55);
		const record = makeRecord('f.md', 0, 800, 0, 55);
		expect(classifyStatus(remote, record, false)).toBe('unmodified');
	});

	it('uses the remote fields of the record when isLocal is false', () => {
		const remote = makeRemote('f.md', 800, 55);
		// remoteMtime matches but remoteSize does not → modified
		const record = makeRecord('f.md', 0, 800, 0, 99);
		expect(classifyStatus(remote, record, false)).toBe('modified');
	});
});
