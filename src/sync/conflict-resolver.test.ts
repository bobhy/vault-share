import { describe, it, expect, vi } from 'vitest';
import type { SyncContext } from './types';
import type { DriveFileSide } from './drive-fs';
import { buildConflictFilename, resolveConflict } from './conflict-resolver';

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

function makeDriveSide(overrides: Partial<DriveFileSide> = {}): DriveFileSide {
	return { path: 'test.md', driveFileId: 'drive-id', mtime: 1000, size: 0, ...overrides };
}

function makeMockCtx(): SyncContext & {
	localFs: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; stat: ReturnType<typeof vi.fn>; rename: ReturnType<typeof vi.fn> };
	driveFs: { write: ReturnType<typeof vi.fn>; stat: ReturnType<typeof vi.fn>; readBinary: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
	store: { getContent: ReturnType<typeof vi.fn>; putRecord: ReturnType<typeof vi.fn> };
	statsTracker: { recordPush: ReturnType<typeof vi.fn>; recordPull: ReturnType<typeof vi.fn>; recordMerge: ReturnType<typeof vi.fn>; recordContentConflict: ReturnType<typeof vi.fn>; recordDeleteConflict: ReturnType<typeof vi.fn>; recordAPIResponseTime: ReturnType<typeof vi.fn>; recordClockSkew: ReturnType<typeof vi.fn> };
} {
	const localFs = {
		read: vi.fn().mockResolvedValue(new TextEncoder().encode('local content').buffer),
		write: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockReturnValue({ path: 'test.md', mtime: 500, size: 12 }),
		rename: vi.fn().mockResolvedValue(undefined),
	};
	const driveFs = {
		write: vi.fn().mockResolvedValue(makeDriveSide()),
		stat: vi.fn().mockResolvedValue(makeDriveSide()),
		readBinary: vi.fn().mockResolvedValue(new TextEncoder().encode('remote content').buffer),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	const store = {
		getContent: vi.fn().mockResolvedValue(null),
		putRecord: vi.fn().mockResolvedValue(undefined),
	};
	const statsTracker = {
		recordPush: vi.fn(),
		recordPull: vi.fn(),
		recordMerge: vi.fn(),
		recordContentConflict: vi.fn(),
		recordDeleteConflict: vi.fn(),
		recordAPIResponseTime: vi.fn(),
		recordClockSkew: vi.fn(),
	};
	return {
		localFs,
		driveFs,
		store,
		statsTracker,
		clientId: 'abc12345-0000-0000-0000-000000000000',
		driveFolderId: () => 'root-id',
		settings: vi.fn(),
		app: {} as never,
		logger: {} as never,
	} as unknown as ReturnType<typeof makeMockCtx>;
}

// ---------------------------------------------------------------------------
// buildConflictFilename
// ---------------------------------------------------------------------------

describe('buildConflictFilename', () => {
	const now = new Date('2024-01-15T12:30:00.000');

	it('inserts conflict segment before the extension', () => {
		const result = buildConflictFilename('notes/todo.md', 'abc12345', now);
		expect(result).toBe('notes/todo-conflict-abc12345-2024-01-15T12-30-00.000.md');
	});

	it('appends conflict segment when there is no extension', () => {
		const result = buildConflictFilename('notes/todo', 'abc12345', now);
		expect(result).toBe('notes/todo-conflict-abc12345-2024-01-15T12-30-00.000');
	});

	it('treats a dot only in the directory name as no extension on the file', () => {
		const result = buildConflictFilename('dir.ext/file', 'abc12345', now);
		expect(result).toBe('dir.ext/file-conflict-abc12345-2024-01-15T12-30-00.000');
	});

	it('handles a root-level file with an extension', () => {
		const result = buildConflictFilename('note.md', 'xyz99999', now);
		expect(result).toBe('note-conflict-xyz99999-2024-01-15T12-30-00.000.md');
	});
});

// ---------------------------------------------------------------------------
// resolveConflict — Use Newer
// ---------------------------------------------------------------------------

describe('resolveConflict: Use Newer', () => {
	it('pushes local content to Drive when local is newer', async () => {
		const ctx = makeMockCtx();
		const action = {
			type: 'conflict' as const,
			path: 'test.md',
			local: { path: 'test.md', mtime: 2000, size: 10 },
			remote: { path: 'test.md', mtime: 1000, size: 10, driveFileId: 'remote-id' },
		};

		const result = await resolveConflict(action, 'Keep Both', 'Use Newer', ctx);

		expect(ctx.localFs.read).toHaveBeenCalledWith('test.md');
		expect(ctx.driveFs.write).toHaveBeenCalledWith('root-id', 'test.md', expect.anything(), expect.anything(), expect.anything());
		expect(ctx.statsTracker.recordPush).toHaveBeenCalled();
		expect(result).toEqual({ merged: false, hadConflictMarkers: false });
	});

	it('pulls remote content to local when remote is newer', async () => {
		const ctx = makeMockCtx();
		ctx.driveFs.stat.mockResolvedValue(makeDriveSide({ driveFileId: 'remote-id' }));
		const action = {
			type: 'conflict' as const,
			path: 'test.md',
			local: { path: 'test.md', mtime: 500, size: 10 },
			remote: { path: 'test.md', mtime: 2000, size: 10, driveFileId: 'remote-id' },
		};

		const result = await resolveConflict(action, 'Keep Both', 'Use Newer', ctx);

		expect(ctx.driveFs.stat).toHaveBeenCalledWith('root-id', 'test.md');
		expect(ctx.driveFs.readBinary).toHaveBeenCalledWith('remote-id');
		expect(ctx.localFs.write).toHaveBeenCalledWith('test.md', expect.anything());
		expect(ctx.statsTracker.recordPull).toHaveBeenCalled();
		expect(result).toEqual({ merged: false, hadConflictMarkers: false });
	});
});

// ---------------------------------------------------------------------------
// resolveConflict — Keep Both
// ---------------------------------------------------------------------------

describe('resolveConflict: Keep Both', () => {
	it('renames local file, writes remote locally, pushes both to Drive, and deletes original', async () => {
		const ctx = makeMockCtx();
		ctx.driveFs.stat.mockResolvedValue(makeDriveSide({ driveFileId: 'original-drive-id' }));
		const action = {
			type: 'conflict' as const,
			path: 'note.md',
			local: { path: 'note.md', mtime: 2000, size: 10 },
			remote: { path: 'note.md', mtime: 1000, size: 10, driveFileId: 'original-drive-id' },
		};

		const result = await resolveConflict(action, 'Keep Both', 'Keep Both', ctx);

		expect(ctx.localFs.rename).toHaveBeenCalled();
		expect(ctx.localFs.write).toHaveBeenCalled();
		expect(ctx.driveFs.write).toHaveBeenCalledTimes(2);
		expect(ctx.driveFs.delete).toHaveBeenCalledWith('original-drive-id');
		expect(ctx.store.putRecord).toHaveBeenCalledTimes(2);
		expect(ctx.statsTracker.recordContentConflict).toHaveBeenCalled();
		expect(result.merged).toBe(false);
		expect(result.localConflictPath).toMatch(/note-conflict-/);
		expect(result.remoteConflictPath).toMatch(/note-conflict-group-/);
	});
});

// ---------------------------------------------------------------------------
// resolveConflict — Merge
// ---------------------------------------------------------------------------

describe('resolveConflict: Merge', () => {
	it('writes the merged result to both sides for a clean merge', async () => {
		const ctx = makeMockCtx();
		ctx.localFs.read.mockResolvedValue(new TextEncoder().encode('line1\nline2\n').buffer);
		ctx.driveFs.stat.mockResolvedValue(makeDriveSide({ driveFileId: 'remote-id' }));
		ctx.driveFs.readBinary.mockResolvedValue(new TextEncoder().encode('line1\nline2\n').buffer);
		const action = {
			type: 'conflict' as const,
			path: 'note.md',
			local: { path: 'note.md', mtime: 2000, size: 10 },
			remote: { path: 'note.md', mtime: 1000, size: 10, driveFileId: 'remote-id' },
		};

		const result = await resolveConflict(action, 'Keep Both', 'Merge', ctx);

		expect(ctx.localFs.write).toHaveBeenCalledWith('note.md', expect.anything());
		expect(ctx.driveFs.write).toHaveBeenCalledWith('root-id', 'note.md', expect.anything(), expect.anything(), expect.anything());
		expect(ctx.statsTracker.recordMerge).toHaveBeenCalled();
		expect(result.merged).toBe(true);
	});

	it('records content conflict when merge produces conflict markers', async () => {
		const ctx = makeMockCtx();
		ctx.localFs.read.mockResolvedValue(new TextEncoder().encode('local only line\n').buffer);
		ctx.driveFs.stat.mockResolvedValue(makeDriveSide({ driveFileId: 'remote-id' }));
		// Remote has different content and base is empty (store returns null) → conflict
		ctx.driveFs.readBinary.mockResolvedValue(new TextEncoder().encode('remote only line\n').buffer);
		const action = {
			type: 'conflict' as const,
			path: 'note.md',
			local: { path: 'note.md', mtime: 2000, size: 10 },
			remote: { path: 'note.md', mtime: 1000, size: 10, driveFileId: 'remote-id' },
		};

		await resolveConflict(action, 'Keep Both', 'Merge', ctx);

		expect(ctx.statsTracker.recordContentConflict).toHaveBeenCalled();
	});

	it('treats a disappeared remote as a push (race condition)', async () => {
		const ctx = makeMockCtx();
		ctx.driveFs.stat.mockResolvedValue(null); // remote vanished between planning and merge
		const action = {
			type: 'conflict' as const,
			path: 'note.md',
			local: { path: 'note.md', mtime: 2000, size: 10 },
			remote: { path: 'note.md', mtime: 1000, size: 10, driveFileId: 'remote-id' },
		};

		const result = await resolveConflict(action, 'Keep Both', 'Merge', ctx);

		expect(ctx.driveFs.write).toHaveBeenCalled();
		expect(ctx.statsTracker.recordPush).toHaveBeenCalled();
		expect(result).toEqual({ merged: false, hadConflictMarkers: false });
	});

	it('uses stored base content when a sync record provides one', async () => {
		const ctx = makeMockCtx();
		ctx.localFs.read.mockResolvedValue(new TextEncoder().encode('base\nlocal change\n').buffer);
		ctx.driveFs.stat.mockResolvedValue(makeDriveSide({ driveFileId: 'remote-id' }));
		ctx.driveFs.readBinary.mockResolvedValue(new TextEncoder().encode('base\nremote change\n').buffer);
		ctx.store.getContent.mockResolvedValue(new TextEncoder().encode('base\n').buffer);
		const action = {
			type: 'conflict' as const,
			path: 'note.md',
			local: { path: 'note.md', mtime: 2000, size: 10 },
			remote: { path: 'note.md', mtime: 1000, size: 10, driveFileId: 'remote-id' },
			record: { path: 'note.md', driveFileId: 'remote-id', localMtime: 0, remoteMtime: 0, localSize: 0, remoteSize: 0, syncedAt: 0 },
		};

		await resolveConflict(action, 'Keep Both', 'Merge', ctx);

		expect(ctx.store.getContent).toHaveBeenCalledWith('note.md');
	});

	it('uses fileStrategy (Keep Both) for non-eligible file extensions even when textStrategy is Merge', async () => {
		const ctx = makeMockCtx();
		ctx.driveFs.stat.mockResolvedValue(makeDriveSide({ driveFileId: 'original-id' }));
		const action = {
			type: 'conflict' as const,
			path: 'image.png',
			local: { path: 'image.png', mtime: 2000, size: 100 },
			remote: { path: 'image.png', mtime: 1000, size: 100, driveFileId: 'original-id' },
		};

		const result = await resolveConflict(action, 'Keep Both', 'Merge', ctx);

		// Keep Both path: renames local and writes remote copy
		expect(ctx.localFs.rename).toHaveBeenCalled();
		expect(ctx.driveFs.delete).toHaveBeenCalledWith('original-id');
		expect(result.merged).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// resolveConflict — Delete conflicts
// ---------------------------------------------------------------------------

describe('resolveConflict: delete conflicts', () => {
	it('creates a placeholder locally and on Drive when local was deleted', async () => {
		const ctx = makeMockCtx();
		const action = {
			type: 'conflict' as const,
			path: 'note.md',
			local: undefined,
			remote: { path: 'note.md', mtime: 2000, size: 10, driveFileId: 'remote-id' },
		};

		const result = await resolveConflict(action, 'Keep Both', 'Merge', ctx);

		expect(ctx.localFs.write).toHaveBeenCalled();
		expect(ctx.driveFs.write).toHaveBeenCalled();
		expect(ctx.store.putRecord).toHaveBeenCalled();
		expect(ctx.statsTracker.recordDeleteConflict).toHaveBeenCalled();
		expect(result).toEqual({ merged: false, hadConflictMarkers: false });
	});

	it('creates a placeholder on Drive when remote was deleted', async () => {
		const ctx = makeMockCtx();
		const action = {
			type: 'conflict' as const,
			path: 'note.md',
			local: { path: 'note.md', mtime: 2000, size: 10 },
			remote: undefined,
		};

		const result = await resolveConflict(action, 'Keep Both', 'Merge', ctx);

		expect(ctx.localFs.write).toHaveBeenCalled();
		expect(ctx.driveFs.write).toHaveBeenCalled();
		expect(ctx.store.putRecord).toHaveBeenCalled();
		expect(ctx.statsTracker.recordDeleteConflict).toHaveBeenCalled();
		expect(result).toEqual({ merged: false, hadConflictMarkers: false });
	});
});
