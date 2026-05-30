import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from 'obsidian';
import type { Candidate, SyncContext, FileSide, SyncActionType, SyncedFileState } from './types';
import type { CandidateStore } from './candidate-store';
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
	contents: Map<string, ArrayBuffer>;
} {
	const contents = new Map<string, ArrayBuffer>();
	const store = {
		async getContent(path: string) { return contents.get(path); },
		async putContent(path: string, content: ArrayBuffer) { contents.set(path, content); },
		async deleteContent(path: string) { contents.delete(path); },
	} as unknown as SyncStore;
	return { store, contents };
}

/**
 * Create a CandidateStore mock that exposes spy references as top-level members.
 * Using spy references directly (rather than accessing them as methods) avoids the
 * @typescript-eslint/unbound-method rule.
 */
function makeCandidateStore() {
	const markSynced = vi.fn<(path: string, state: SyncedFileState) => Promise<void>>().mockResolvedValue(undefined);
	const remove = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
	const insertSynced = vi.fn<(path: string, state: SyncedFileState) => Promise<void>>().mockResolvedValue(undefined);
	// Mirror CandidateStore.applyFileResult so the existing markSynced /
	// remove / insertSynced assertions still see the same calls.
	const applyFileResult = async (
		path: string,
		actionType: string,
		fileResult: { changed: boolean; syncedState?: SyncedFileState; newSyncedFiles?: Array<{ path: string } & SyncedFileState> },
	): Promise<void> => {
		if (!fileResult.changed) return;
		const isDelete = actionType === 'deleteLocal' || actionType === 'deleteRemote';
		if (isDelete || !fileResult.syncedState) {
			await remove(path);
		} else {
			await markSynced(path, fileResult.syncedState);
		}
		if (fileResult.newSyncedFiles) {
			for (const f of fileResult.newSyncedFiles) {
				const { path: newPath, ...state } = f;
				await insertSynced(newPath, state);
			}
		}
	};
	const store = { markSynced, remove, insertSynced, applyFileResult } as unknown as CandidateStore;
	return { store, markSynced, remove, insertSynced };
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
	actionType: SyncActionType,
	driveFileId?: string,
): Candidate {
	return {
		path,
		state: 'Default',
		actionType,
		driveFileId: driveFileId ?? '',
		syncedLocalMtime: 0,
		syncedRemoteMtime: 0,
		syncedLocalSize: 0,
		syncedRemoteSize: 0,
		syncedAt: 0,
		deferredAt: 0,
		deferredLocalMtime: 0,
		deferredRemoteMtime: 0,
		remote: driveFileId ? { path, driveFileId, mtime: 0, size: 0 } : undefined,
	};
}

// ---------------------------------------------------------------------------
// Shared test context factory
// ---------------------------------------------------------------------------

function makeCtx(): {
	ctx: SyncContext;
	localFiles: Map<string, LocalFileEntry>;
	driveFiles: Map<string, DriveFileEntry>;
	contents: Map<string, ArrayBuffer>;
} {
	const { localFs, files: localFiles } = makeLocalFs();
	const { driveFs, files: driveFiles } = makeDriveFs();
	const { store, contents } = makeSyncStore();
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
	return { ctx, localFiles, driveFiles, contents };
}

// ---------------------------------------------------------------------------
// executeAction
// ---------------------------------------------------------------------------

describe('executeAction', () => {
	let ctx: SyncContext;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFiles: Map<string, DriveFileEntry>;

	beforeEach(() => {
		({ ctx, localFiles, driveFiles } = makeCtx());
	});

	it('push: writes local content to Drive and calls markSynced', async () => {
		localFiles.set('note.md', { content: enc('hello'), mtime: 2000, size: 5 });
		const { store: candidateStore, markSynced } = makeCandidateStore();

		await executeAction(makeCandidate('note.md', 'push'), ctx, candidateStore);

		expect(driveFiles.has('note.md')).toBe(true);
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[0]).toBe('note.md');
		expect(markSynced.mock.lastCall?.[1]?.driveFileId).toBeTruthy();
	});

	it('pull: writes Drive content to local and calls markSynced with driveFileId', async () => {
		driveFiles.set('note.md', { driveFileId: 'drive-1', content: enc('remote'), mtime: 3000 });
		const { store: candidateStore, markSynced } = makeCandidateStore();

		await executeAction(makeCandidate('note.md', 'pull', 'drive-1'), ctx, candidateStore);

		expect(localFiles.has('note.md')).toBe(true);
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[1]?.driveFileId).toBe('drive-1');
	});

	it('deleteLocal: removes local file and calls remove', async () => {
		localFiles.set('gone.md', { content: enc('bye'), mtime: 1000, size: 3 });
		const { store: candidateStore, remove } = makeCandidateStore();

		await executeAction(makeCandidate('gone.md', 'deleteLocal'), ctx, candidateStore);

		expect(localFiles.has('gone.md')).toBe(false);
		expect(remove).toHaveBeenCalledWith('gone.md');
	});

	it('deleteRemote: removes Drive file and calls remove', async () => {
		driveFiles.set('old.md', { driveFileId: 'drive-o', content: enc('old'), mtime: 1000 });
		const { store: candidateStore, remove } = makeCandidateStore();

		await executeAction(makeCandidate('old.md', 'deleteRemote', 'drive-o'), ctx, candidateStore);

		expect(driveFiles.has('old.md')).toBe(false);
		expect(remove).toHaveBeenCalledWith('old.md');
	});
});

// ---------------------------------------------------------------------------
// executeBackOut
// ---------------------------------------------------------------------------

describe('executeBackOut', () => {
	let ctx: SyncContext;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFiles: Map<string, DriveFileEntry>;

	beforeEach(() => {
		({ ctx, localFiles, driveFiles } = makeCtx());
	});

	it('push: deletes local file and calls remove; Drive is untouched', async () => {
		localFiles.set('new.md', { content: enc('new'), mtime: 2000, size: 3 });
		driveFiles.set('new.md', { driveFileId: 'drive-n', content: enc('old'), mtime: 1000 });
		const { store: candidateStore, remove } = makeCandidateStore();

		await executeBackOut(makeCandidate('new.md', 'push'), ctx, candidateStore);

		expect(localFiles.has('new.md')).toBe(false);
		expect(driveFiles.has('new.md')).toBe(true);
		expect(remove).toHaveBeenCalledWith('new.md');
	});

	it('pull: deletes Drive file and calls remove; local is untouched', async () => {
		localFiles.set('remote.md', { content: enc('local'), mtime: 1000, size: 5 });
		driveFiles.set('remote.md', { driveFileId: 'drive-r', content: enc('remote'), mtime: 3000 });
		const { store: candidateStore, remove } = makeCandidateStore();

		await executeBackOut(makeCandidate('remote.md', 'pull', 'drive-r'), ctx, candidateStore);

		expect(driveFiles.has('remote.md')).toBe(false);
		expect(localFiles.has('remote.md')).toBe(true);
		expect(remove).toHaveBeenCalledWith('remote.md');
	});

	it('deleteLocal: restores local file from Drive and calls markSynced', async () => {
		driveFiles.set('restore.md', { driveFileId: 'drive-x', content: enc('content'), mtime: 2000 });
		const { store: candidateStore, markSynced } = makeCandidateStore();

		await executeBackOut(makeCandidate('restore.md', 'deleteLocal', 'drive-x'), ctx, candidateStore);

		expect(localFiles.has('restore.md')).toBe(true);
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[1]?.driveFileId).toBe('drive-x');
	});

	it('deleteRemote: re-uploads local file to Drive and calls markSynced with positive remoteMtime', async () => {
		localFiles.set('backup.md', { content: enc('local content'), mtime: 1500, size: 13 });
		const { store: candidateStore, markSynced } = makeCandidateStore();

		await executeBackOut(makeCandidate('backup.md', 'deleteRemote'), ctx, candidateStore);

		expect(driveFiles.has('backup.md')).toBe(true);
		expect(markSynced).toHaveBeenCalled();
		const syncedArg = markSynced.mock.lastCall?.[1];
		expect(syncedArg?.remoteMtime).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// executeMerge
// ---------------------------------------------------------------------------

describe('executeMerge', () => {
	it('text conflict: writes merged content to both vaults and calls markSynced', async () => {
		const { ctx, localFiles, driveFiles } = makeCtx();
		const { store: candidateStore, markSynced } = makeCandidateStore();

		localFiles.set('note.md', { content: enc('local version\n'), mtime: 2000, size: 14 });
		driveFiles.set('note.md', { driveFileId: 'drive-m', content: enc('remote version\n'), mtime: 1000 });

		await executeMerge(makeCandidate('note.md', 'conflict', 'drive-m'), ctx, candidateStore);

		// Both sides should now exist and markSynced should be called.
		expect(localFiles.has('note.md')).toBe(true);
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[0]).toBe('note.md');
		const syncedArg = markSynced.mock.lastCall?.[1];
		expect(syncedArg?.remoteMtime).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// executeKeepLocal
// ---------------------------------------------------------------------------

describe('executeKeepLocal', () => {
	it('pushes local content to Drive and calls markSynced', async () => {
		const { ctx, localFiles, driveFiles } = makeCtx();
		const { store: candidateStore, markSynced } = makeCandidateStore();

		localFiles.set('img.png', { content: enc('local-bytes'), mtime: 2000, size: 11 });
		driveFiles.set('img.png', { driveFileId: 'drive-p', content: enc('remote-bytes'), mtime: 1000 });

		await executeKeepLocal(makeCandidate('img.png', 'conflict', 'drive-p'), ctx, candidateStore);

		// Drive should now have local content.
		const driveCopy = driveFiles.get('img.png');
		expect(driveCopy).toBeDefined();
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[0]).toBe('img.png');
	});
});

// ---------------------------------------------------------------------------
// executeKeepGroupVault
// ---------------------------------------------------------------------------

describe('executeKeepGroupVault', () => {
	it('pulls Drive content to local and calls markSynced with driveFileId', async () => {
		const { ctx, localFiles, driveFiles } = makeCtx();
		const { store: candidateStore, markSynced } = makeCandidateStore();

		localFiles.set('img.png', { content: enc('local-bytes'), mtime: 2000, size: 11 });
		driveFiles.set('img.png', { driveFileId: 'drive-q', content: enc('remote-bytes'), mtime: 3000 });

		await executeKeepGroupVault(makeCandidate('img.png', 'conflict', 'drive-q'), ctx, candidateStore);

		expect(localFiles.has('img.png')).toBe(true);
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[1]?.driveFileId).toBe('drive-q');
	});
});

// ---------------------------------------------------------------------------
// executeDeleteBoth
// ---------------------------------------------------------------------------

describe('executeDeleteBoth', () => {
	it('deletes local file, Drive file, and calls remove', async () => {
		const { ctx, localFiles, driveFiles } = makeCtx();
		const { store: candidateStore, remove } = makeCandidateStore();

		localFiles.set('dup.md', { content: enc('both'), mtime: 1000, size: 4 });
		driveFiles.set('dup.md', { driveFileId: 'drive-d', content: enc('both'), mtime: 1000 });

		await executeDeleteBoth(makeCandidate('dup.md', 'conflict', 'drive-d'), ctx, candidateStore);

		expect(localFiles.has('dup.md')).toBe(false);
		expect(driveFiles.has('dup.md')).toBe(false);
		expect(remove).toHaveBeenCalledWith('dup.md');
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
	it('writes the resolved content to both vaults and calls markSynced', async () => {
		const { ctx, localFiles, driveFiles, contents } = makeCtx();
		const { store: candidateStore, markSynced } = makeCandidateStore();

		localFiles.set('note.md', { content: enc('old local'), mtime: 1000, size: 9 });
		driveFiles.set('note.md', { driveFileId: 'drive-wr', content: enc('old remote'), mtime: 1000 });

		await writeResolvedMerge(makeCandidate('note.md', 'conflict', 'drive-wr'), 'resolved content', ctx, candidateStore);

		const dec = new TextDecoder();
		expect(dec.decode(localFiles.get('note.md')?.content)).toBe('resolved content');
		expect(dec.decode(driveFiles.get('note.md')?.content)).toBe('resolved content');
		// Base content cache should be updated.
		expect(dec.decode(contents.get('note.md'))).toBe('resolved content');
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[0]).toBe('note.md');
		expect(markSynced.mock.lastCall?.[1]?.driveFileId).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// executeConflictBackOut
// ---------------------------------------------------------------------------

describe('executeConflictBackOut', () => {
	it('restores both sides to the cached base and calls markSynced', async () => {
		const { ctx, localFiles, driveFiles, contents } = makeCtx();
		const { store: candidateStore, markSynced } = makeCandidateStore();
		const base = enc('base content\n');

		localFiles.set('shared.md', { content: enc('local edits\n'), mtime: 2000, size: 12 });
		driveFiles.set('shared.md', { driveFileId: 'drive-b', content: enc('remote edits\n'), mtime: 1500 });
		contents.set('shared.md', base);

		await executeConflictBackOut(makeCandidate('shared.md', 'conflict', 'drive-b'), ctx, candidateStore);

		// Both sides should now have base content.
		const localEntry = localFiles.get('shared.md');
		const driveEntry = driveFiles.get('shared.md');
		expect(new TextDecoder().decode(localEntry?.content)).toBe('base content\n');
		expect(new TextDecoder().decode(driveEntry?.content)).toBe('base content\n');
		expect(markSynced).toHaveBeenCalled();
		expect(markSynced.mock.lastCall?.[0]).toBe('shared.md');
	});

	it('throws when no cached base content is available', async () => {
		const { ctx } = makeCtx();
		const { store: candidateStore } = makeCandidateStore();
		// No content seeded in store.

		await expect(
			executeConflictBackOut(makeCandidate('missing.md', 'conflict'), ctx, candidateStore),
		).rejects.toThrow('No cached base content');
	});
});
