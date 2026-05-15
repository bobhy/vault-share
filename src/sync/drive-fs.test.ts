import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DriveFile, GDriveApi } from '../gdrive/api';
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
});
