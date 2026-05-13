import { describe, it, expect, beforeEach } from 'vitest';
import { App } from 'obsidian';
import type { SyncAction, SyncContext, SyncRecord, FileSide } from './types';
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

function makeSyncStore(): { store: SyncStore; records: Map<string, SyncRecord> } {
	const records = new Map<string, SyncRecord>();
	const contents = new Map<string, ArrayBuffer>();
	const store = {
		async getRecord(path: string) { return records.get(path); },
		async putRecord(r: SyncRecord) { records.set(r.path, r); },
		async deleteRecord(path: string) { records.delete(path); },
		async getContent(path: string) { return contents.get(path); },
		async putContent(path: string, content: ArrayBuffer) { contents.set(path, content); },
	} as unknown as SyncStore;
	return { store, records };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncOneFile conflict handling', () => {
	let localFs: LocalFs;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFs: DriveFsAdapter;
	let driveFiles: Map<string, DriveFileEntry>;
	let store: SyncStore;
	let records: Map<string, SyncRecord>;
	let ctx: SyncContext;

	beforeEach(() => {
		({ localFs, files: localFiles } = makeLocalFs());
		({ driveFs, files: driveFiles } = makeDriveFs());
		({ store, records } = makeSyncStore());

		ctx = {
			app: new App(),
			localFs,
			driveFs,
			store,
			statsTracker: stubStats,
			settings: () => mockSettings({ fileConflict: 'Keep Both' }),
			clientId: 'abcd1234-0000-0000-0000-000000000000',
			driveFolderId: () => 'root-folder-id',
			logger: stubLogger,
		};

		// Populate: local has newer version, Drive has older version.
		localFiles.set('Welcome.md', { content: enc('local content'), mtime: 2000, size: 13 });
		driveFiles.set('Welcome.md', { driveFileId: 'drive-orig-1', content: enc('drive content'), mtime: 1000 });
	});

	const conflictAction: SyncAction = {
		type: 'conflict',
		path: 'Welcome.md',
		local:  { path: 'Welcome.md', mtime: 2000, size: 13 },
		remote: { path: 'Welcome.md', mtime: 1000, size: 12, driveFileId: 'drive-orig-1' },
	};

	describe('Keep Both strategy', () => {
		it('removes the original sync record after resolving', async () => {
			// Pre-populate a record for Welcome.md so deleteRecord has something to remove.
			records.set('Welcome.md', {
				path: 'Welcome.md', driveFileId: 'drive-orig-1',
				localMtime: 500, remoteMtime: 500, localSize: 5, remoteSize: 5, syncedAt: 0,
			});

			await syncOneFile(conflictAction, ctx, true);

			expect(records.has('Welcome.md')).toBe(false);
		});

		it('stores a sync record for the local-side conflict file', async () => {
			await syncOneFile(conflictAction, ctx, false);

			const conflictPaths = [...records.keys()].filter(k => k.includes('-conflict-'));
			const localConflict = conflictPaths.find(k => k.includes('abcd1234'));
			expect(localConflict).toBeDefined();

			const rec = records.get(localConflict!)!;
			expect(rec.driveFileId).toBeTruthy();
			expect(rec.syncedAt).toBeGreaterThan(0);
		});

		it('stores a sync record for the group-side conflict file', async () => {
			await syncOneFile(conflictAction, ctx, false);

			const conflictPaths = [...records.keys()].filter(k => k.includes('-conflict-'));
			const groupConflict = conflictPaths.find(k => k.includes('-conflict-group-'));
			expect(groupConflict).toBeDefined();

			const rec = records.get(groupConflict!)!;
			expect(rec.driveFileId).toBeTruthy();
			expect(rec.syncedAt).toBeGreaterThan(0);
		});

		it('does not re-conflict on the next call for a conflict file', async () => {
			await syncOneFile(conflictAction, ctx, false);

			// Pick either conflict file that now exists on both sides.
			const conflictPath = [...records.keys()].find(k => k.includes('-conflict-'));
			expect(conflictPath).toBeDefined();

			// Simulate what the decision engine would produce for a file whose
			// local and remote versions match the stored record — a noOp.
			// If the record is missing, the decision engine would produce 'conflict'
			// (absent history + both sides present). Verify the record is there and
			// has a driveFileId, which is the prerequisite for a noOp decision.
			const rec = records.get(conflictPath!)!;
			expect(rec).toBeDefined();
			expect(rec.driveFileId).toBeTruthy();
		});
	});

	describe('Use Newer strategy', () => {
		beforeEach(() => {
			ctx = { ...ctx, settings: () => mockSettings({ fileConflict: 'Use Newer' }) };
		});

		it('retains a sync record for the original path after resolving in-place', async () => {
			// Local is newer (mtime 2000 > 1000); Use Newer should push local to Drive
			// and update (not delete) the record for Welcome.md.
			await syncOneFile(conflictAction, ctx, false);

			expect(records.has('Welcome.md')).toBe(true);
		});

		it('does not create any conflict files', async () => {
			await syncOneFile(conflictAction, ctx, false);

			const conflictPaths = [...records.keys()].filter(k => k.includes('-conflict-'));
			expect(conflictPaths).toHaveLength(0);
		});
	});
});

describe('syncOneFile record mtime correctness', () => {
	let localFs: LocalFs;
	let localFiles: Map<string, LocalFileEntry>;
	let driveFs: DriveFsAdapter;
	let driveFiles: Map<string, DriveFileEntry>;
	let store: SyncStore;
	let records: Map<string, SyncRecord>;
	let ctx: SyncContext;

	beforeEach(() => {
		({ localFs, files: localFiles } = makeLocalFs());
		({ driveFs, files: driveFiles } = makeDriveFs());
		({ store, records } = makeSyncStore());

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

	const pushAction: SyncAction = {
		type: 'push',
		path: 'note.md',
		local:  { path: 'note.md', mtime: 2000, size: 10 },
		remote: { path: 'note.md', mtime: 1000, size: 8, driveFileId: 'drive-note-1' },
	};

	it('push: stores local OS mtime as localMtime, not the Drive write timestamp', async () => {
		await syncOneFile(pushAction, ctx, true);

		const rec = records.get('note.md')!;
		// If this stores Drive server time instead of 2000, the next poll sees
		// local as "modified" and loops forever.
		expect(rec.localMtime).toBe(2000);
	});

	it('push: stores post-write Drive mtime as remoteMtime, not the pre-write value', async () => {
		await syncOneFile(pushAction, ctx, true);

		const rec = records.get('note.md')!;
		// If this stores the stale pre-write 1000 instead of the new Drive mtime,
		// the next poll sees remote as "modified" and triggers a conflict loop.
		expect(rec.remoteMtime).not.toBe(1000);
		expect(rec.remoteMtime).toBeGreaterThan(0);
	});

	it('merge: stores post-write Drive mtime as remoteMtime, not the pre-write value', async () => {
		ctx = { ...ctx, settings: () => mockSettings({ fileConflict: 'Merge' }) };

		const conflictAction: SyncAction = {
			type: 'conflict',
			path: 'note.md',
			local:  { path: 'note.md', mtime: 2000, size: 10 },
			remote: { path: 'note.md', mtime: 1000, size: 8, driveFileId: 'drive-note-1' },
		};

		await syncOneFile(conflictAction, ctx, true);

		const rec = records.get('note.md')!;
		expect(rec).toBeDefined();
		expect(rec.remoteMtime).not.toBe(1000);
		expect(rec.remoteMtime).toBeGreaterThan(0);
	});
});
