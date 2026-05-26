import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from 'obsidian';
import type { Candidate, SyncContext, FileSide } from './types';
import type { LocalFs } from './local-fs';
import type { DriveFsAdapter, DriveFileSide } from './drive-fs';
import type { SyncStore } from './store';
import type { StatsTracker } from './stats-tracker';
import type { Logger } from '../logger';
import { syncOneFile } from './file-syncer';
import { mockSettings } from '../__mocks__/sync-test-helpers';

// ---------------------------------------------------------------------------
// Minimal in-memory mocks
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
			return f ? { path, driveFileId: f.driveFileId, mtime: f.mtime, size: 0 } : null;
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
			return { path, driveFileId, mtime, size: 0 };
		},
		async delete(fileId: string): Promise<void> {
			for (const [path, f] of files) {
				if (f.driveFileId === fileId) { files.delete(path); return; }
			}
		},
	} as unknown as DriveFsAdapter;
	return { driveFs, files };
}

/** Simplified store mock — no record methods; only content cache. */
function makeSyncStore(): { store: SyncStore; contents: Map<string, ArrayBuffer> } {
	const contents = new Map<string, ArrayBuffer>();
	const store = {
		async getContent(path: string) { return contents.get(path); },
		async putContent(path: string, content: ArrayBuffer) { contents.set(path, content); },
		async deleteContent(path: string) { contents.delete(path); },
	} as unknown as SyncStore;
	return { store, contents };
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

/** Build a Candidate for tests. */
function makeCandidate(overrides: Partial<Candidate> & { path: string; actionType: Candidate['actionType'] }): Candidate {
	return {
		state: 'Default',
		driveFileId: '',
		syncedLocalMtime: 0,
		syncedRemoteMtime: 0,
		syncedLocalSize: 0,
		syncedRemoteSize: 0,
		syncedAt: 0,
		deferredAt: 0,
		deferredLocalMtime: 0,
		deferredRemoteMtime: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests: conflict handling (Keep Both strategy)
// ---------------------------------------------------------------------------

describe('syncOneFile conflict handling', () => {
	let localFs: LocalFs;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFs: DriveFsAdapter;
	let driveFiles: Map<string, DriveFileEntry>;
	let store: SyncStore;
	let ctx: SyncContext;

	beforeEach(() => {
		({ localFs, files: localFiles } = makeLocalFs());
		({ driveFs, files: driveFiles } = makeDriveFs());
		({ store } = makeSyncStore());

		ctx = {
			app: new App(),
			localFs,
			driveFs,
			store,
			statsTracker: stubStats,
			settings: () => mockSettings({ fileConflict: 'Keep Both', textFileConflict: 'Keep Both' }),
			clientId: 'abcd1234-0000-0000-0000-000000000000',
			driveFolderId: () => 'root-folder-id',
			logger: stubLogger,
		};

		// Populate: local has newer version, Drive has older version.
		localFiles.set('Welcome.md', { content: enc('local content'), mtime: 2000, size: 13 });
		driveFiles.set('Welcome.md', { driveFileId: 'drive-orig-1', content: enc('drive content'), mtime: 1000 });
	});

	const makeConflictCandidate = (): Candidate => makeCandidate({
		path: 'Welcome.md',
		actionType: 'conflict',
		driveFileId: 'drive-orig-1',
		local:  { path: 'Welcome.md', mtime: 2000, size: 13 },
		remote: { path: 'Welcome.md', mtime: 1000, size: 12, driveFileId: 'drive-orig-1' },
	});

	describe('Keep Both strategy', () => {
		it('does not return syncedState for original path; returns newSyncedFiles with conflict copies', async () => {
			const result = await syncOneFile(makeConflictCandidate(), ctx, false);

			expect(result.changed).toBe(true);
			expect(result.syncedState).toBeUndefined();
			expect(result.newSyncedFiles).toHaveLength(2);
		});

		it('newSyncedFiles: local conflict path has driveFileId and syncedAt', async () => {
			const result = await syncOneFile(makeConflictCandidate(), ctx, false);

			const conflictFiles = result.newSyncedFiles ?? [];
			const localConflict = conflictFiles.find(f => f.path.includes('abcd1234'));
			expect(localConflict).toBeDefined();
			expect(localConflict?.driveFileId).toBeTruthy();
			expect(localConflict?.syncedAt).toBeGreaterThan(0);
		});

		it('newSyncedFiles: remote conflict path has driveFileId and syncedAt', async () => {
			const result = await syncOneFile(makeConflictCandidate(), ctx, false);

			const conflictFiles = result.newSyncedFiles ?? [];
			const groupConflict = conflictFiles.find(f => f.path.includes('-conflict-group-'));
			expect(groupConflict).toBeDefined();
			expect(groupConflict?.driveFileId).toBeTruthy();
			expect(groupConflict?.syncedAt).toBeGreaterThan(0);
		});

		it('conflict files in newSyncedFiles have non-zero syncedAt (safe to markSynced)', async () => {
			const result = await syncOneFile(makeConflictCandidate(), ctx, false);

			for (const f of result.newSyncedFiles ?? []) {
				expect(f.syncedAt).toBeGreaterThan(0);
				expect(f.driveFileId).toBeTruthy();
			}
		});
	});

	describe('Use Newer strategy', () => {
		beforeEach(() => {
			ctx = { ...ctx, settings: () => mockSettings({ fileConflict: 'Use Newer', textFileConflict: 'Use Newer' }) };
		});

		it('returns syncedState (resolved in-place) with no newSyncedFiles', async () => {
			// Local is newer (mtime 2000 > 1000); Use Newer pushes local to Drive.
			const result = await syncOneFile(makeConflictCandidate(), ctx, false);

			expect(result.changed).toBe(true);
			expect(result.syncedState).toBeDefined();
			expect(result.newSyncedFiles).toBeUndefined();
		});

		it('does not create any conflict files on Drive', async () => {
			await syncOneFile(makeConflictCandidate(), ctx, false);

			const conflictPaths = [...driveFiles.keys()].filter(k => k.includes('-conflict-'));
			expect(conflictPaths).toHaveLength(0);
		});
	});
});

// ---------------------------------------------------------------------------
// Tests: syncedState mtime/size correctness
// ---------------------------------------------------------------------------

describe('syncOneFile syncedState mtime correctness', () => {
	let localFs: LocalFs;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFs: DriveFsAdapter;
	let driveFiles: Map<string, DriveFileEntry>;
	let store: SyncStore;
	let ctx: SyncContext;

	beforeEach(() => {
		({ localFs, files: localFiles } = makeLocalFs());
		({ driveFs, files: driveFiles } = makeDriveFs());
		({ store } = makeSyncStore());

		ctx = {
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

		localFiles.set('note.md', { content: enc('local text'), mtime: 2000, size: 10 });
		driveFiles.set('note.md', { driveFileId: 'drive-note-1', content: enc('old text'), mtime: 1000 });
	});

	const pushCandidate = (): Candidate => makeCandidate({
		path: 'note.md',
		actionType: 'push',
		driveFileId: 'drive-note-1',
		local:  { path: 'note.md', mtime: 2000, size: 10 },
		remote: { path: 'note.md', mtime: 1000, size: 8, driveFileId: 'drive-note-1' },
	});

	it('push: syncedState.localMtime matches the pre-write local OS mtime, not the Drive write timestamp', async () => {
		const result = await syncOneFile(pushCandidate(), ctx, true);

		// If this stores Drive server time instead of 2000, the next poll sees
		// local as "modified" and loops forever.
		expect(result.syncedState?.localMtime).toBe(2000);
	});

	it('push: syncedState.remoteMtime is post-write Drive mtime, not the pre-write value', async () => {
		const result = await syncOneFile(pushCandidate(), ctx, true);

		// If this stores the stale pre-write 1000 instead of the new Drive mtime,
		// the next poll sees remote as "modified" and triggers a conflict loop.
		expect(result.syncedState?.remoteMtime).not.toBe(1000);
		expect(result.syncedState?.remoteMtime).toBeGreaterThan(0);
	});

	it('pull: syncedState.localSize is post-write local size, not the pre-pull value', async () => {
		// Remote has larger content (size 10) than the local file (size 8).
		// If we store action.local.size (8) instead of the post-write size (10),
		// the next poll sees a size mismatch and pushes the file back.
		const pullCandidate: Candidate = makeCandidate({
			path: 'note.md',
			actionType: 'pull',
			driveFileId: 'drive-note-1',
			local:  { path: 'note.md', mtime: 1000, size: 8 },
			remote: { path: 'note.md', mtime: 2000, size: 10, driveFileId: 'drive-note-1' },
		});

		const result = await syncOneFile(pullCandidate, ctx, true);

		expect(result.syncedState).toBeDefined();
		// localSize must match the pulled content (remote size = 10), not the stale pre-pull size (8).
		expect(result.syncedState?.localSize).toBe(localFiles.get('note.md')!.content.byteLength);
	});

	it('merge: syncedState.remoteMtime is post-write Drive mtime, not the pre-write value', async () => {
		ctx = { ...ctx, settings: () => mockSettings({ textFileConflict: 'Merge' }) };

		const conflictCandidate: Candidate = makeCandidate({
			path: 'note.md',
			actionType: 'conflict',
			driveFileId: 'drive-note-1',
			local:  { path: 'note.md', mtime: 2000, size: 10 },
			remote: { path: 'note.md', mtime: 1000, size: 8, driveFileId: 'drive-note-1' },
		});

		const result = await syncOneFile(conflictCandidate, ctx, true);

		expect(result.syncedState).toBeDefined();
		expect(result.syncedState?.remoteMtime).not.toBe(1000);
		expect(result.syncedState?.remoteMtime).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// noOp and pull edge-cases
// ---------------------------------------------------------------------------

describe('syncOneFile noOp and pull edge-cases', () => {
	let ctx: SyncContext;

	beforeEach(() => {
		const { localFs } = makeLocalFs();
		const { driveFs } = makeDriveFs();
		const { store } = makeSyncStore();
		ctx = {
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
	});

	it('noOp: returns changed=false without touching any store or fs', async () => {
		const candidate = makeCandidate({ path: 'untracked.md', actionType: 'noOp' });
		const result = await syncOneFile(candidate, ctx, false);
		expect(result).toEqual({ changed: false, merged: false, hadConflictMarkers: false });
	});

	it('pull: returns changed=false and logs a warning when the Drive file is gone', async () => {
		const warnFn = vi.fn();
		const localLogger = { ...stubLogger, warning: warnFn } as unknown as Logger;
		ctx = { ...ctx, logger: localLogger };
		const candidate = makeCandidate({
			path: 'gone.md',
			actionType: 'pull',
			// No driveFileId in remote, and driveFs.stat will return null for unknown path.
			remote: undefined,
		});
		const result = await syncOneFile(candidate, ctx, false);
		expect(result.changed).toBe(false);
		expect(warnFn).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Delete action tests
// ---------------------------------------------------------------------------

describe('syncOneFile delete actions', () => {
	let localFs: LocalFs;
	let localFiles: Map<string, { content: ArrayBuffer; mtime: number; size: number }>;
	let driveFs: DriveFsAdapter;
	let driveFiles: Map<string, { driveFileId: string; content: ArrayBuffer; mtime: number }>;
	let store: SyncStore;
	let ctx: SyncContext;

	beforeEach(() => {
		({ localFs, files: localFiles } = makeLocalFs());
		({ driveFs, files: driveFiles } = makeDriveFs());
		({ store } = makeSyncStore());

		ctx = {
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

		localFiles.set('note.md', { content: enc('local text'), mtime: 1000, size: 10 });
		driveFiles.set('note.md', { driveFileId: 'drive-note-1', content: enc('local text'), mtime: 1000 });
	});

	it('deleteRemote: removes the file from Drive and returns changed=true', async () => {
		const candidate: Candidate = makeCandidate({
			path: 'note.md',
			actionType: 'deleteRemote',
			driveFileId: 'drive-note-1',
			remote: { path: 'note.md', mtime: 1000, size: 10, driveFileId: 'drive-note-1' },
		});

		const result = await syncOneFile(candidate, ctx, true);

		expect(result.changed).toBe(true);
		expect(driveFiles.has('note.md')).toBe(false);
		// Local file is untouched.
		expect(localFiles.has('note.md')).toBe(true);
		// Caller (BulkSync / resolution-executor) handles candidateStore.remove().
		expect(result.syncedState).toBeUndefined();
	});

	it('deleteRemote: returns changed=true even when Drive file is already gone', async () => {
		// Remote file disappeared between planning and execution.
		driveFiles.clear();

		const candidate: Candidate = makeCandidate({
			path: 'note.md',
			actionType: 'deleteRemote',
			driveFileId: '',
			remote: undefined, // no driveFileId; stat will return null
		});

		const result = await syncOneFile(candidate, ctx, true);

		// deleteContent still called → changed: true so caller can remove the candidate.
		expect(result.changed).toBe(true);
	});

	it('deleteLocal: removes the local file and returns changed=true', async () => {
		const candidate: Candidate = makeCandidate({
			path: 'note.md',
			actionType: 'deleteLocal',
			driveFileId: 'drive-note-1',
			local: { path: 'note.md', mtime: 1000, size: 10 },
		});

		const result = await syncOneFile(candidate, ctx, true);

		expect(result.changed).toBe(true);
		expect(localFiles.has('note.md')).toBe(false);
		// Drive file is untouched.
		expect(driveFiles.has('note.md')).toBe(true);
	});

	it('deleteLocal: calls localFs.delete even when local is already gone (both-deleted race)', async () => {
		// Simulate the race: local was already deleted before syncOneFile runs.
		localFiles.delete('note.md');

		const deleteSpy = vi.spyOn(localFs, 'delete');

		const candidate: Candidate = makeCandidate({
			path: 'note.md',
			actionType: 'deleteLocal',
			driveFileId: 'drive-note-1',
			local: undefined, // file gone on local side
		});

		const result = await syncOneFile(candidate, ctx, true);

		expect(result.changed).toBe(true);
		// localFs.delete called (it is a no-op when the TFile is absent in real Obsidian).
		expect(deleteSpy).toHaveBeenCalledWith('note.md');
	});
});
