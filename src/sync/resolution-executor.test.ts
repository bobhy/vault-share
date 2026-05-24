import { describe, it, expect, beforeEach } from 'vitest';
import { App } from 'obsidian';
import type { SyncContext, SyncRecord, FileSide } from './types';
import type { LocalFs } from './local-fs';
import type { DriveFsAdapter, DriveFileSide } from './drive-fs';
import type { SyncStore } from './store';
import type { StatsTracker } from './stats-tracker';
import type { Logger } from '../logger';
import { mockSettings } from '../__mocks__/sync-test-helpers';
import { MARKER_LOCAL } from './merge';
import {
	executeAction,
	executeBackOut,
	executeMerge,
	executeKeepLocal,
	executeKeepGroupVault,
	executeDeleteBoth,
	executeConflictBackOut,
	computeMerge,
	writeResolvedMerge,
} from './resolution-executor';
import type { ViewCandidate } from './types';

// ---------------------------------------------------------------------------
// Minimal in-memory mocks (same pattern as file-syncer.test.ts)
// ---------------------------------------------------------------------------

type LocalFileEntry = { content: ArrayBuffer; mtime: number; size: number };

function makeLocalFs(): { localFs: LocalFs; files: Map<string, LocalFileEntry> } {
	const files = new Map<string, LocalFileEntry>();
	const localFs = {
		stat(path: string): FileSide | null {
			const f = files.get(path);
			return f ? { path, mtime: f.mtime, size: f.size } : null;
		},
		async read(path: string): Promise<ArrayBuffer> {
			const f = files.get(path);
			if (!f) throw new Error(`Local file not found: ${path}`);
			return f.content;
		},
		async write(path: string, content: ArrayBuffer): Promise<void> {
			files.set(path, { content, mtime: Date.now(), size: content.byteLength });
		},
		async rename(oldPath: string, newPath: string): Promise<void> {
			const f = files.get(oldPath);
			if (!f) throw new Error(`Local file not found: ${oldPath}`);
			files.delete(oldPath);
			files.set(newPath, f);
		},
		async delete(path: string): Promise<void> {
			files.delete(path);
		},
	} as unknown as LocalFs;
	return { localFs, files };
}

type DriveFileEntry = { driveFileId: string; content: ArrayBuffer; mtime: number };

function makeDriveFs(): { driveFs: DriveFsAdapter; files: Map<string, DriveFileEntry> } {
	const files = new Map<string, DriveFileEntry>();
	let nextId = 1;

	const driveFs = {
		async stat(_rootId: string, path: string): Promise<DriveFileSide | null> {
			const f = files.get(path);
			return f ? { path, driveFileId: f.driveFileId, mtime: f.mtime, size: f.content.byteLength } : null;
		},
		async readBinary(fileId: string): Promise<ArrayBuffer> {
			for (const f of files.values()) {
				if (f.driveFileId === fileId) return f.content;
			}
			throw new Error(`Drive file not found: ${fileId}`);
		},
		async write(
			_rootId: string,
			path: string,
			content: ArrayBuffer,
		): Promise<DriveFileSide> {
			const existing = files.get(path);
			const driveFileId = existing?.driveFileId ?? `drive-id-${nextId++}`;
			const mtime = Date.now();
			files.set(path, { driveFileId, content, mtime });
			return { path, driveFileId, mtime, size: content.byteLength };
		},
		async delete(fileId: string): Promise<void> {
			for (const [path, f] of files) {
				if (f.driveFileId === fileId) { files.delete(path); return; }
			}
		},
	} as unknown as DriveFsAdapter;
	return { driveFs, files };
}

function makeSyncStore(): {
	store: SyncStore;
	records: Map<string, SyncRecord>;
	contents: Map<string, ArrayBuffer>;
} {
	const records = new Map<string, SyncRecord>();
	const contents = new Map<string, ArrayBuffer>();
	const store = {
		async getRecord(path: string) { return records.get(path); },
		async putRecord(r: SyncRecord) { records.set(r.path, r); },
		async deleteRecord(path: string) { records.delete(path); },
		async getContent(path: string) { return contents.get(path); },
		async putContent(path: string, content: ArrayBuffer) { contents.set(path, content); },
	} as unknown as SyncStore;
	return { store, records, contents };
}

const stubStats = {
	recordPush: () => { /* noop */ },
	recordPull: () => { /* noop */ },
	recordMerge: () => { /* noop */ },
	recordContentConflict: () => { /* noop */ },
	recordDeleteConflict: () => { /* noop */ },
	recordAPIResponseTime: () => { /* noop */ },
	recordClockSkew: () => { /* noop */ },
} as unknown as StatsTracker;

const stubLogger = {
	debug: () => { /* noop */ },
	info: () => { /* noop */ },
	warning: () => { /* noop */ },
	error: () => { /* noop */ },
} as unknown as Logger;

function enc(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

function makeCandidate(
	path: string,
	actionType: ViewCandidate['actionType'],
	driveFileId?: string,
): ViewCandidate {
	return { path, actionType, isDeferred: false, driveFileId };
}

// ---------------------------------------------------------------------------
// Shared test context factory
// ---------------------------------------------------------------------------

function makeCtx(): {
	ctx: SyncContext;
	localFiles: Map<string, LocalFileEntry>;
	driveFiles: Map<string, DriveFileEntry>;
	records: Map<string, SyncRecord>;
	contents: Map<string, ArrayBuffer>;
} {
	const { localFs, files: localFiles } = makeLocalFs();
	const { driveFs, files: driveFiles } = makeDriveFs();
	const { store, records, contents } = makeSyncStore();
	const ctx: SyncContext = {
		app: new App(),
		localFs,
		driveFs,
		store,
		statsTracker: stubStats,
		settings: () => mockSettings(),
		clientId: 'abcd1234-0000-0000-0000-000000000000',
		driveFolderId: () => 'root-folder-id',
		logger: stubLogger,
	};
	return { ctx, localFiles, driveFiles, records, contents };
}

// ---------------------------------------------------------------------------
// executeAction
// ---------------------------------------------------------------------------

describe('executeAction', () => {
	let ctx: SyncContext;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFiles: Map<string, DriveFileEntry>;
	let records: Map<string, SyncRecord>;

	beforeEach(() => {
		({ ctx, localFiles, driveFiles, records } = makeCtx());
	});

	it('push: writes local content to Drive and stores a sync record', async () => {
		localFiles.set('note.md', { content: enc('hello'), mtime: 2000, size: 5 });
		const candidate = makeCandidate('note.md', 'push');

		await executeAction(candidate, ctx);

		expect(driveFiles.has('note.md')).toBe(true);
		expect(records.has('note.md')).toBe(true);
	});

	it('pull: writes Drive content to local and stores a sync record', async () => {
		driveFiles.set('note.md', { driveFileId: 'drive-1', content: enc('remote'), mtime: 3000 });
		const candidate = makeCandidate('note.md', 'pull', 'drive-1');

		await executeAction(candidate, ctx);

		expect(localFiles.has('note.md')).toBe(true);
		const rec = records.get('note.md');
		expect(rec?.driveFileId).toBe('drive-1');
	});

	it('deleteLocal: removes local file and deletes the sync record', async () => {
		localFiles.set('gone.md', { content: enc('bye'), mtime: 1000, size: 3 });
		records.set('gone.md', {
			path: 'gone.md', driveFileId: 'drive-g',
			localMtime: 1000, remoteMtime: 1000, localSize: 3, remoteSize: 3, syncedAt: 0,
		});
		const candidate = makeCandidate('gone.md', 'deleteLocal');

		await executeAction(candidate, ctx);

		expect(localFiles.has('gone.md')).toBe(false);
		expect(records.has('gone.md')).toBe(false);
	});

	it('deleteRemote: removes Drive file and deletes the sync record', async () => {
		driveFiles.set('old.md', { driveFileId: 'drive-o', content: enc('old'), mtime: 1000 });
		records.set('old.md', {
			path: 'old.md', driveFileId: 'drive-o',
			localMtime: 1000, remoteMtime: 1000, localSize: 3, remoteSize: 3, syncedAt: 0,
		});
		const candidate = makeCandidate('old.md', 'deleteRemote', 'drive-o');

		await executeAction(candidate, ctx);

		expect(driveFiles.has('old.md')).toBe(false);
		expect(records.has('old.md')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// executeBackOut
// ---------------------------------------------------------------------------

describe('executeBackOut', () => {
	let ctx: SyncContext;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFiles: Map<string, DriveFileEntry>;
	let records: Map<string, SyncRecord>;

	beforeEach(() => {
		({ ctx, localFiles, driveFiles, records } = makeCtx());
	});

	it('push: deletes local file and sync record; Drive is untouched', async () => {
		localFiles.set('new.md', { content: enc('new'), mtime: 2000, size: 3 });
		driveFiles.set('new.md', { driveFileId: 'drive-n', content: enc('old'), mtime: 1000 });

		await executeBackOut(makeCandidate('new.md', 'push'), ctx);

		expect(localFiles.has('new.md')).toBe(false);
		expect(driveFiles.has('new.md')).toBe(true);
		expect(records.has('new.md')).toBe(false);
	});

	it('pull: deletes Drive file and sync record; local is untouched', async () => {
		localFiles.set('remote.md', { content: enc('local'), mtime: 1000, size: 5 });
		driveFiles.set('remote.md', { driveFileId: 'drive-r', content: enc('remote'), mtime: 3000 });
		records.set('remote.md', {
			path: 'remote.md', driveFileId: 'drive-r',
			localMtime: 1000, remoteMtime: 3000, localSize: 5, remoteSize: 6, syncedAt: 0,
		});

		await executeBackOut(makeCandidate('remote.md', 'pull', 'drive-r'), ctx);

		expect(driveFiles.has('remote.md')).toBe(false);
		expect(localFiles.has('remote.md')).toBe(true);
		expect(records.has('remote.md')).toBe(false);
	});

	it('deleteLocal: restores local file from Drive and updates sync record', async () => {
		driveFiles.set('restore.md', { driveFileId: 'drive-x', content: enc('content'), mtime: 2000 });
		records.set('restore.md', {
			path: 'restore.md', driveFileId: 'drive-x',
			localMtime: 2000, remoteMtime: 2000, localSize: 7, remoteSize: 7, syncedAt: 0,
		});

		await executeBackOut(makeCandidate('restore.md', 'deleteLocal', 'drive-x'), ctx);

		expect(localFiles.has('restore.md')).toBe(true);
		expect(records.has('restore.md')).toBe(true);
		expect(records.get('restore.md')?.driveFileId).toBe('drive-x');
	});

	it('deleteRemote: re-uploads local file to Drive and updates sync record', async () => {
		localFiles.set('backup.md', { content: enc('local content'), mtime: 1500, size: 13 });

		await executeBackOut(makeCandidate('backup.md', 'deleteRemote'), ctx);

		expect(driveFiles.has('backup.md')).toBe(true);
		expect(records.has('backup.md')).toBe(true);
		expect(records.get('backup.md')?.remoteMtime).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// executeMerge
// ---------------------------------------------------------------------------

describe('executeMerge', () => {
	it('text conflict: writes merged content to both vaults and updates record', async () => {
		const { ctx, localFiles, driveFiles, records } = makeCtx();

		localFiles.set('note.md', { content: enc('local version\n'), mtime: 2000, size: 14 });
		driveFiles.set('note.md', { driveFileId: 'drive-m', content: enc('remote version\n'), mtime: 1000 });

		await executeMerge(makeCandidate('note.md', 'conflict', 'drive-m'), ctx);

		// Both sides should now exist and the record should be updated.
		expect(localFiles.has('note.md')).toBe(true);
		expect(records.has('note.md')).toBe(true);
		expect(records.get('note.md')?.remoteMtime).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// executeKeepLocal
// ---------------------------------------------------------------------------

describe('executeKeepLocal', () => {
	it('pushes local content to Drive and stores a record', async () => {
		const { ctx, localFiles, driveFiles, records } = makeCtx();

		localFiles.set('img.png', { content: enc('local-bytes'), mtime: 2000, size: 11 });
		driveFiles.set('img.png', { driveFileId: 'drive-p', content: enc('remote-bytes'), mtime: 1000 });

		await executeKeepLocal(makeCandidate('img.png', 'conflict', 'drive-p'), ctx);

		// Drive should now have local content.
		const driveCopy = driveFiles.get('img.png');
		expect(driveCopy).toBeDefined();
		expect(records.has('img.png')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// executeKeepGroupVault
// ---------------------------------------------------------------------------

describe('executeKeepGroupVault', () => {
	it('pulls Drive content to local and stores a record', async () => {
		const { ctx, localFiles, driveFiles, records } = makeCtx();

		localFiles.set('img.png', { content: enc('local-bytes'), mtime: 2000, size: 11 });
		driveFiles.set('img.png', { driveFileId: 'drive-q', content: enc('remote-bytes'), mtime: 3000 });

		await executeKeepGroupVault(makeCandidate('img.png', 'conflict', 'drive-q'), ctx);

		expect(localFiles.has('img.png')).toBe(true);
		expect(records.has('img.png')).toBe(true);
		expect(records.get('img.png')?.driveFileId).toBe('drive-q');
	});
});

// ---------------------------------------------------------------------------
// executeDeleteBoth
// ---------------------------------------------------------------------------

describe('executeDeleteBoth', () => {
	it('deletes local file, Drive file, and sync record', async () => {
		const { ctx, localFiles, driveFiles, records } = makeCtx();

		localFiles.set('dup.md', { content: enc('both'), mtime: 1000, size: 4 });
		driveFiles.set('dup.md', { driveFileId: 'drive-d', content: enc('both'), mtime: 1000 });
		records.set('dup.md', {
			path: 'dup.md', driveFileId: 'drive-d',
			localMtime: 1000, remoteMtime: 1000, localSize: 4, remoteSize: 4, syncedAt: 0,
		});

		await executeDeleteBoth(makeCandidate('dup.md', 'conflict', 'drive-d'), ctx);

		expect(localFiles.has('dup.md')).toBe(false);
		expect(driveFiles.has('dup.md')).toBe(false);
		expect(records.has('dup.md')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// computeMerge
// ---------------------------------------------------------------------------

describe('computeMerge', () => {
	it('returns a clean merge when only one side changed', async () => {
		const { ctx, localFiles, driveFiles, contents } = makeCtx();

		localFiles.set('note.md', { content: enc('base\nlocal-edit\n'), mtime: 2000, size: 16 });
		driveFiles.set('note.md', { driveFileId: 'drive-c', content: enc('base\nunchanged\n'), mtime: 1000 });
		contents.set('note.md', enc('base\nunchanged\n'));

		const result = await computeMerge(makeCandidate('note.md', 'conflict', 'drive-c'), ctx);

		expect(result.hasConflicts).toBe(false);
		expect(result.content).toContain('local-edit');
	});

	it('returns a conflicted merge when both sides changed the same line', async () => {
		const { ctx, localFiles, driveFiles, contents } = makeCtx();

		localFiles.set('note.md', { content: enc('LOCAL'), mtime: 2000, size: 5 });
		driveFiles.set('note.md', { driveFileId: 'drive-c2', content: enc('REMOTE'), mtime: 1000 });
		contents.set('note.md', enc('BASE'));

		const result = await computeMerge(makeCandidate('note.md', 'conflict', 'drive-c2'), ctx);

		expect(result.hasConflicts).toBe(true);
		expect(result.content).toContain(MARKER_LOCAL);
		expect(result.content).toContain('LOCAL');
		expect(result.content).toContain('REMOTE');
	});

	it('uses empty string for base when no cached content exists', async () => {
		const { ctx, localFiles, driveFiles } = makeCtx();

		localFiles.set('new.md', { content: enc('local text'), mtime: 2000, size: 10 });
		driveFiles.set('new.md', { driveFileId: 'drive-c3', content: enc('local text'), mtime: 1000 });
		// No content seeded → base is ''

		const result = await computeMerge(makeCandidate('new.md', 'conflict', 'drive-c3'), ctx);

		// Both sides identical → clean merge.
		expect(result.hasConflicts).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// writeResolvedMerge
// ---------------------------------------------------------------------------

describe('writeResolvedMerge', () => {
	it('writes the resolved content to both vaults and updates the sync record', async () => {
		const { ctx, localFiles, driveFiles, records, contents } = makeCtx();

		localFiles.set('note.md', { content: enc('old local'), mtime: 1000, size: 9 });
		driveFiles.set('note.md', { driveFileId: 'drive-wr', content: enc('old remote'), mtime: 1000 });

		await writeResolvedMerge(makeCandidate('note.md', 'conflict', 'drive-wr'), 'resolved content', ctx);

		const dec = new TextDecoder();
		expect(dec.decode(localFiles.get('note.md')?.content)).toBe('resolved content');
		expect(dec.decode(driveFiles.get('note.md')?.content)).toBe('resolved content');
		const rec = records.get('note.md');
		expect(rec).toBeDefined();
		expect(rec?.driveFileId).toBeTruthy();
		// Base content cache should be updated.
		expect(dec.decode(contents.get('note.md'))).toBe('resolved content');
	});
});

// ---------------------------------------------------------------------------
// executeConflictBackOut
// ---------------------------------------------------------------------------

describe('executeConflictBackOut', () => {
	it('restores both sides to the cached base and updates the record', async () => {
		const { ctx, localFiles, driveFiles, records, contents } = makeCtx();
		const base = enc('base content\n');

		localFiles.set('shared.md', { content: enc('local edits\n'), mtime: 2000, size: 12 });
		driveFiles.set('shared.md', { driveFileId: 'drive-b', content: enc('remote edits\n'), mtime: 1500 });
		contents.set('shared.md', base);

		await executeConflictBackOut(makeCandidate('shared.md', 'conflict', 'drive-b'), ctx);

		// Both sides should now have base content.
		const localEntry = localFiles.get('shared.md');
		const driveEntry = driveFiles.get('shared.md');
		expect(new TextDecoder().decode(localEntry?.content)).toBe('base content\n');
		expect(new TextDecoder().decode(driveEntry?.content)).toBe('base content\n');
		expect(records.has('shared.md')).toBe(true);
	});

	it('throws when no cached base content is available', async () => {
		const { ctx } = makeCtx();
		// No content seeded in store.

		await expect(
			executeConflictBackOut(makeCandidate('missing.md', 'conflict'), ctx),
		).rejects.toThrow('No cached base content');
	});
});
