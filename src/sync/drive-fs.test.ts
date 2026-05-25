import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DriveFile, GDriveApi } from '../gdrive/api';
import type { StatsTracker } from './stats-tracker';
import { DriveFsAdapter } from './drive-fs';

const ROOT_ID = 'root-folder-id';
const EMPTY_CONTENT = new ArrayBuffer(4);
const clockSkewSampled = { value: false };

function makeFolder(id: string, name: string): DriveFile {
	return { id, name, mimeType: 'application/vnd.google-apps.folder' };
}

function makeFile(id: string, name: string): DriveFile {
	return { id, name, mimeType: 'text/plain', modifiedTime: new Date().toISOString() };
}

describe('DriveFsAdapter.write', () => {
	beforeEach(() => {
		clockSkewSampled.value = false;
	});

	it('creates intermediate folder under rootFolderId, not Drive root', async () => {
		const createdFolder = makeFolder('sub-id', 'subdir');
		const writtenFile = makeFile('file-id', 'note.md');
		const findFolder = vi.fn().mockResolvedValue(null);
		const createFolder = vi.fn().mockResolvedValue(createdFolder);
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const adapter = new DriveFsAdapter({ findFolder, createFolder, writeFile } as unknown as GDriveApi);

		await adapter.write(ROOT_ID, 'subdir/note.md', EMPTY_CONTENT, null, clockSkewSampled);

		expect(findFolder).toHaveBeenCalledWith(ROOT_ID, 'subdir');
		expect(createFolder).toHaveBeenCalledWith(ROOT_ID, 'subdir');
		expect(writeFile).toHaveBeenCalledWith('sub-id', 'note.md', expect.any(Uint8Array));
	});

	it('reuses existing subfolder without creating a duplicate', async () => {
		const existingFolder = makeFolder('existing-sub-id', 'subdir');
		const writtenFile = makeFile('file-id', 'note.md');
		const findFolder = vi.fn().mockResolvedValue(existingFolder);
		const createFolder = vi.fn();
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const adapter = new DriveFsAdapter({ findFolder, createFolder, writeFile } as unknown as GDriveApi);

		await adapter.write(ROOT_ID, 'subdir/note.md', EMPTY_CONTENT, null, clockSkewSampled);

		expect(createFolder).not.toHaveBeenCalled();
		expect(writeFile).toHaveBeenCalledWith('existing-sub-id', 'note.md', expect.any(Uint8Array));
	});

	it('traverses multi-level path using correct parent IDs at each level', async () => {
		const folderA = makeFolder('a-id', 'a');
		const folderB = makeFolder('b-id', 'b');
		const writtenFile = makeFile('file-id', 'note.md');
		const findFolder = vi.fn()
			.mockResolvedValueOnce(folderA)  // finds 'a' under ROOT_ID
			.mockResolvedValueOnce(null);    // 'b' not found under 'a'
		const createFolder = vi.fn().mockResolvedValue(folderB);
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const adapter = new DriveFsAdapter({ findFolder, createFolder, writeFile } as unknown as GDriveApi);

		await adapter.write(ROOT_ID, 'a/b/note.md', EMPTY_CONTENT, null, clockSkewSampled);

		expect(findFolder.mock.calls[0]).toEqual([ROOT_ID, 'a']);
		expect(findFolder.mock.calls[1]).toEqual(['a-id', 'b']);
		expect(createFolder).toHaveBeenCalledWith('a-id', 'b');
		expect(writeFile).toHaveBeenCalledWith('b-id', 'note.md', expect.any(Uint8Array));
	});

	it('writes a root-level file without touching folder APIs', async () => {
		const writtenFile = makeFile('file-id', 'note.md');
		const findFolder = vi.fn();
		const createFolder = vi.fn();
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const adapter = new DriveFsAdapter({ findFolder, createFolder, writeFile } as unknown as GDriveApi);

		await adapter.write(ROOT_ID, 'note.md', EMPTY_CONTENT, null, clockSkewSampled);

		expect(findFolder).not.toHaveBeenCalled();
		expect(createFolder).not.toHaveBeenCalled();
		expect(writeFile).toHaveBeenCalledWith(ROOT_ID, 'note.md', expect.any(Uint8Array));
	});

	it('records API response time via statsTracker', async () => {
		const writtenFile = makeFile('file-id', 'note.md');
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const statsTracker = { recordAPIResponseTime: vi.fn(), recordClockSkew: vi.fn() };
		const adapter = new DriveFsAdapter({ writeFile } as unknown as GDriveApi);

		await adapter.write(ROOT_ID, 'note.md', EMPTY_CONTENT, statsTracker as unknown as StatsTracker, clockSkewSampled);

		expect(statsTracker.recordAPIResponseTime).toHaveBeenCalledWith(expect.any(Number));
	});

	it('records clock skew on first write when modifiedTime is present', async () => {
		const writtenFile = makeFile('file-id', 'note.md');
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const statsTracker = { recordAPIResponseTime: vi.fn(), recordClockSkew: vi.fn() };
		const adapter = new DriveFsAdapter({ writeFile } as unknown as GDriveApi);
		const sampler = { value: false };

		await adapter.write(ROOT_ID, 'note.md', EMPTY_CONTENT, statsTracker as unknown as StatsTracker, sampler);

		expect(statsTracker.recordClockSkew).toHaveBeenCalledWith(expect.any(Number));
		expect(sampler.value).toBe(true);
	});

	it('does not record clock skew on subsequent writes (sampler already true)', async () => {
		const writtenFile = makeFile('file-id', 'note.md');
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const statsTracker = { recordAPIResponseTime: vi.fn(), recordClockSkew: vi.fn() };
		const adapter = new DriveFsAdapter({ writeFile } as unknown as GDriveApi);
		const sampler = { value: true };

		await adapter.write(ROOT_ID, 'note.md', EMPTY_CONTENT, statsTracker as unknown as StatsTracker, sampler);

		expect(statsTracker.recordClockSkew).not.toHaveBeenCalled();
	});

	it('does not record clock skew when result has no modifiedTime', async () => {
		const writtenFile: DriveFile = { id: 'file-id', name: 'note.md', mimeType: 'text/plain' };
		const writeFile = vi.fn().mockResolvedValue(writtenFile);
		const statsTracker = { recordAPIResponseTime: vi.fn(), recordClockSkew: vi.fn() };
		const adapter = new DriveFsAdapter({ writeFile } as unknown as GDriveApi);
		const sampler = { value: false };

		await adapter.write(ROOT_ID, 'note.md', EMPTY_CONTENT, statsTracker as unknown as StatsTracker, sampler);

		expect(statsTracker.recordClockSkew).not.toHaveBeenCalled();
		expect(sampler.value).toBe(false);
	});
});

describe('DriveFsAdapter.listAll', () => {
	it('returns empty files array and zero duplicates for an empty root folder', async () => {
		const listChildren = vi.fn().mockResolvedValue([]);
		const adapter = new DriveFsAdapter({ listChildren } as unknown as GDriveApi);

		const result = await adapter.listAll(ROOT_ID);
		expect(result.files).toEqual([]);
		expect(result.duplicatePathsFound).toBe(0);
	});

	it('returns flat files at root with correct paths and IDs', async () => {
		const file1 = makeFile('id1', 'a.md');
		const file2 = makeFile('id2', 'b.md');
		const listChildren = vi.fn().mockResolvedValue([file1, file2]);
		const adapter = new DriveFsAdapter({ listChildren } as unknown as GDriveApi);

		const { files } = await adapter.listAll(ROOT_ID);
		expect(files.map(r => r.path)).toEqual(['a.md', 'b.md']);
		expect(files.map(r => r.driveFileId)).toEqual(['id1', 'id2']);
	});

	it('recursively walks subfolders and builds correct vault-relative paths', async () => {
		const sub = makeFolder('sub-id', 'sub');
		const child = makeFile('child-id', 'note.md');
		const listChildren = vi.fn()
			.mockResolvedValueOnce([sub])    // root listing
			.mockResolvedValueOnce([child]); // sub listing
		const adapter = new DriveFsAdapter({ listChildren } as unknown as GDriveApi);

		const { files } = await adapter.listAll(ROOT_ID);
		expect(files).toHaveLength(1);
		expect(files[0]?.path).toBe('sub/note.md');
		expect(files[0]?.driveFileId).toBe('child-id');
	});

	it('skips folders and only returns files', async () => {
		const sub = makeFolder('sub-id', 'sub');
		const listChildren = vi.fn()
			.mockResolvedValueOnce([sub])
			.mockResolvedValueOnce([]);
		const adapter = new DriveFsAdapter({ listChildren } as unknown as GDriveApi);

		const { files } = await adapter.listAll(ROOT_ID);
		expect(files).toHaveLength(0);
	});

	it('deduplicates same-path files, keeping the one with the higher mtime', async () => {
		const older: DriveFile = { id: 'old-id', name: 'note.md', mimeType: 'text/plain', modifiedTime: new Date(1000).toISOString() };
		const newer: DriveFile = { id: 'new-id', name: 'note.md', mimeType: 'text/plain', modifiedTime: new Date(2000).toISOString() };
		const listChildren = vi.fn().mockResolvedValue([newer, older]); // newest-first (Drive orderBy)
		const adapter = new DriveFsAdapter({ listChildren } as unknown as GDriveApi);

		const { files, duplicatePathsFound } = await adapter.listAll(ROOT_ID);
		expect(files).toHaveLength(1);
		expect(files[0]?.driveFileId).toBe('new-id');
		expect(duplicatePathsFound).toBe(1);
	});

	it('counts each affected path once even with three duplicates', async () => {
		const f1: DriveFile = { id: 'id1', name: 'note.md', mimeType: 'text/plain', modifiedTime: new Date(3000).toISOString() };
		const f2: DriveFile = { id: 'id2', name: 'note.md', mimeType: 'text/plain', modifiedTime: new Date(2000).toISOString() };
		const f3: DriveFile = { id: 'id3', name: 'note.md', mimeType: 'text/plain', modifiedTime: new Date(1000).toISOString() };
		const listChildren = vi.fn().mockResolvedValue([f1, f2, f3]);
		const adapter = new DriveFsAdapter({ listChildren } as unknown as GDriveApi);

		const { files, duplicatePathsFound } = await adapter.listAll(ROOT_ID);
		expect(files).toHaveLength(1);
		expect(files[0]?.driveFileId).toBe('id1');
		expect(duplicatePathsFound).toBe(1); // one path affected, not two
	});

	it('reports zero duplicatePathsFound when all paths are unique', async () => {
		const file1 = makeFile('id1', 'a.md');
		const file2 = makeFile('id2', 'b.md');
		const listChildren = vi.fn().mockResolvedValue([file1, file2]);
		const adapter = new DriveFsAdapter({ listChildren } as unknown as GDriveApi);

		const { duplicatePathsFound } = await adapter.listAll(ROOT_ID);
		expect(duplicatePathsFound).toBe(0);
	});
});

describe('DriveFsAdapter.repairDuplicates', () => {
	function makeFileWithMtime(id: string, name: string, mtime: number): DriveFile {
		return { id, name, mimeType: 'text/plain', modifiedTime: new Date(mtime).toISOString() };
	}

	function makeLogger() {
		return { info: vi.fn(), debug: vi.fn(), warning: vi.fn(), error: vi.fn() };
	}

	it('returns zero counts when no duplicates exist', async () => {
		const listChildren = vi.fn().mockResolvedValue([makeFile('id1', 'a.md'), makeFile('id2', 'b.md')]);
		const deleteFile = vi.fn();
		const adapter = new DriveFsAdapter({ listChildren, deleteFile } as unknown as GDriveApi);

		const result = await adapter.repairDuplicates(ROOT_ID, makeLogger() as unknown as import('../logger').Logger);
		expect(result).toEqual({ pathsWithDuplicates: 0, filesDeleted: 0 });
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it('deletes the older duplicate and keeps the newer one', async () => {
		const newer = makeFileWithMtime('new-id', 'note.md', 2000);
		const older = makeFileWithMtime('old-id', 'note.md', 1000);
		const listChildren = vi.fn().mockResolvedValue([newer, older]);
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		const adapter = new DriveFsAdapter({ listChildren, deleteFile } as unknown as GDriveApi);

		const result = await adapter.repairDuplicates(ROOT_ID, makeLogger() as unknown as import('../logger').Logger);
		expect(result).toEqual({ pathsWithDuplicates: 1, filesDeleted: 1 });
		expect(deleteFile).toHaveBeenCalledOnce();
		expect(deleteFile).toHaveBeenCalledWith('old-id');
	});

	it('deletes all but the newest when three duplicates exist', async () => {
		const f1 = makeFileWithMtime('id1', 'note.md', 3000);
		const f2 = makeFileWithMtime('id2', 'note.md', 2000);
		const f3 = makeFileWithMtime('id3', 'note.md', 1000);
		const listChildren = vi.fn().mockResolvedValue([f1, f2, f3]);
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		const adapter = new DriveFsAdapter({ listChildren, deleteFile } as unknown as GDriveApi);

		const result = await adapter.repairDuplicates(ROOT_ID, makeLogger() as unknown as import('../logger').Logger);
		expect(result).toEqual({ pathsWithDuplicates: 1, filesDeleted: 2 });
		expect(deleteFile).toHaveBeenCalledTimes(2);
		expect(deleteFile).not.toHaveBeenCalledWith('id1');
	});

	it('handles duplicates across multiple distinct paths independently', async () => {
		const a1 = makeFileWithMtime('a1', 'a.md', 2000);
		const a2 = makeFileWithMtime('a2', 'a.md', 1000);
		const b1 = makeFileWithMtime('b1', 'b.md', 2000);
		const b2 = makeFileWithMtime('b2', 'b.md', 1000);
		const listChildren = vi.fn().mockResolvedValue([a1, a2, b1, b2]);
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		const adapter = new DriveFsAdapter({ listChildren, deleteFile } as unknown as GDriveApi);

		const result = await adapter.repairDuplicates(ROOT_ID, makeLogger() as unknown as import('../logger').Logger);
		expect(result).toEqual({ pathsWithDuplicates: 2, filesDeleted: 2 });
		expect(deleteFile).toHaveBeenCalledWith('a2');
		expect(deleteFile).toHaveBeenCalledWith('b2');
	});
});

describe('DriveFsAdapter.stat', () => {
	it('returns DriveFileSide for a root-level file', async () => {
		const file = makeFile('file-id', 'note.md');
		const findFolder = vi.fn();
		const findFile = vi.fn().mockResolvedValue(file);
		const adapter = new DriveFsAdapter({ findFolder, findFile } as unknown as GDriveApi);

		const result = await adapter.stat(ROOT_ID, 'note.md');
		expect(result).not.toBeNull();
		expect(result!.path).toBe('note.md');
		expect(result!.driveFileId).toBe('file-id');
		expect(findFolder).not.toHaveBeenCalled();
	});

	it('traverses folder hierarchy and returns the correct DriveFileSide', async () => {
		const folder = makeFolder('sub-id', 'sub');
		const file = makeFile('file-id', 'note.md');
		const findFolder = vi.fn().mockResolvedValue(folder);
		const findFile = vi.fn().mockResolvedValue(file);
		const adapter = new DriveFsAdapter({ findFolder, findFile } as unknown as GDriveApi);

		const result = await adapter.stat(ROOT_ID, 'sub/note.md');
		expect(findFolder).toHaveBeenCalledWith(ROOT_ID, 'sub');
		expect(findFile).toHaveBeenCalledWith('sub-id', 'note.md');
		expect(result!.driveFileId).toBe('file-id');
	});

	it('returns null when an intermediate folder is missing', async () => {
		const findFolder = vi.fn().mockResolvedValue(null);
		const findFile = vi.fn();
		const adapter = new DriveFsAdapter({ findFolder, findFile } as unknown as GDriveApi);

		const result = await adapter.stat(ROOT_ID, 'missing/note.md');
		expect(result).toBeNull();
		expect(findFile).not.toHaveBeenCalled();
	});

	it('returns null when the file is not found', async () => {
		const folder = makeFolder('sub-id', 'sub');
		const findFolder = vi.fn().mockResolvedValue(folder);
		const findFile = vi.fn().mockResolvedValue(null);
		const adapter = new DriveFsAdapter({ findFolder, findFile } as unknown as GDriveApi);

		const result = await adapter.stat(ROOT_ID, 'sub/note.md');
		expect(result).toBeNull();
	});
});

describe('DriveFsAdapter.read', () => {
	it('converts text response to ArrayBuffer', async () => {
		const readFile = vi.fn().mockResolvedValue('hello world');
		const adapter = new DriveFsAdapter({ readFile } as unknown as GDriveApi);

		const result = await adapter.read('file-id');
		expect(new TextDecoder().decode(result)).toBe('hello world');
	});
});

describe('DriveFsAdapter.readBinary', () => {
	it('wraps Uint8Array bytes in a fresh ArrayBuffer', async () => {
		const bytes = new Uint8Array([10, 20, 30]);
		const readFileBinary = vi.fn().mockResolvedValue(bytes);
		const adapter = new DriveFsAdapter({ readFileBinary } as unknown as GDriveApi);

		const result = await adapter.readBinary('file-id');
		expect(new Uint8Array(result)).toEqual(bytes);
	});
});

describe('DriveFsAdapter.delete', () => {
	it('delegates to api.deleteFile with the given ID', async () => {
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		const adapter = new DriveFsAdapter({ deleteFile } as unknown as GDriveApi);

		await adapter.delete('target-id');
		expect(deleteFile).toHaveBeenCalledWith('target-id');
	});
});

// Suppress unused import lint warning — afterEach is imported for future use
void afterEach;
