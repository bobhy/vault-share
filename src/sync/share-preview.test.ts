import { describe, it, expect } from 'vitest';
import { classifyActions } from './share-preview';
import { mockSettings } from '../__mocks__/sync-test-helpers';
import type { SyncAction, SyncRecord, FileSide } from './types';

// Shared fixtures — represent a file that has a sync history.
const REC: SyncRecord = {
	path: 'file.md', driveFileId: 'id1',
	localMtime: 1000, remoteMtime: 1000,
	localSize: 50, remoteSize: 50,
	syncedAt: 500,
};

const LOCAL: FileSide = { path: 'file.md', mtime: 2000, size: 100 };
const REMOTE: FileSide & { driveFileId: string } = { path: 'file.md', mtime: 2000, size: 100, driveFileId: 'id1' };

// Content conflict: both sides modified relative to record.
const CONFLICT_LOCAL: FileSide = { path: 'file.md', mtime: 3000, size: 200 };
const CONFLICT_REMOTE: FileSide & { driveFileId: string } = { path: 'file.md', mtime: 2500, size: 150, driveFileId: 'id1' };

describe('classifyActions', () => {
	// ── push ─────────────────────────────────────────────────────────────────

	it('push without remote → groupNew', () => {
		const result = classifyActions([{ type: 'push', path: 'a.md' }], mockSettings());
		expect(result.groupNew).toBe(1);
		expect(result.groupUpdated).toBe(0);
	});

	it('push with remote → groupUpdated', () => {
		const result = classifyActions([{ type: 'push', path: 'a.md', remote: REMOTE }], mockSettings());
		expect(result.groupUpdated).toBe(1);
		expect(result.groupNew).toBe(0);
	});

	// ── pull ─────────────────────────────────────────────────────────────────

	it('pull without local → localNew', () => {
		const result = classifyActions([{ type: 'pull', path: 'a.md' }], mockSettings());
		expect(result.localNew).toBe(1);
		expect(result.localUpdated).toBe(0);
	});

	it('pull with local → localUpdated', () => {
		const result = classifyActions([{ type: 'pull', path: 'a.md', local: LOCAL }], mockSettings());
		expect(result.localUpdated).toBe(1);
		expect(result.localNew).toBe(0);
	});

	// ── delete ───────────────────────────────────────────────────────────────

	it('deleteRemote → groupDeleted + groupDeletedPaths', () => {
		const result = classifyActions([{ type: 'deleteRemote', path: 'a.md' }], mockSettings());
		expect(result.groupDeleted).toBe(1);
		expect(result.groupDeletedPaths).toEqual(['a.md']);
	});

	it('deleteLocal → localDeleted + localDeletedPaths', () => {
		const result = classifyActions([{ type: 'deleteLocal', path: 'a.md' }], mockSettings());
		expect(result.localDeleted).toBe(1);
		expect(result.localDeletedPaths).toEqual(['a.md']);
	});

	// ── conflict: delete ─────────────────────────────────────────────────────

	it('conflict with deleted local side → deleteConflicts + deleteConflictPaths', () => {
		const action: SyncAction = { type: 'conflict', path: 'a.md', local: undefined, remote: REMOTE, record: REC };
		const result = classifyActions([action], mockSettings());
		expect(result.deleteConflicts).toBe(1);
		expect(result.deleteConflictPaths).toEqual(['a.md']);
		expect(result.contentConflicts).toBe(0);
	});

	it('conflict with deleted remote side → deleteConflicts + deleteConflictPaths', () => {
		const action: SyncAction = { type: 'conflict', path: 'a.md', local: LOCAL, remote: undefined, record: REC };
		const result = classifyActions([action], mockSettings());
		expect(result.deleteConflicts).toBe(1);
		expect(result.deleteConflictPaths).toEqual(['a.md']);
		expect(result.contentConflicts).toBe(0);
	});

	// ── conflict: content ─────────────────────────────────────────────────────

	it('.md conflict with Merge strategy → contentConflicts + textMergeFiles + both paths', () => {
		const action: SyncAction = { type: 'conflict', path: 'note.md', local: CONFLICT_LOCAL, remote: CONFLICT_REMOTE, record: REC };
		const result = classifyActions([action], mockSettings({ textFileConflict: 'Merge' }));
		expect(result.contentConflicts).toBe(1);
		expect(result.contentConflictPaths).toEqual(['note.md']);
		expect(result.textMergeFiles).toBe(1);
		expect(result.textMergeFilePaths).toEqual(['note.md']);
		expect(result.deleteConflicts).toBe(0);
	});

	it('.txt conflict with Merge strategy → contentConflicts + textMergeFiles', () => {
		const action: SyncAction = { type: 'conflict', path: 'notes.txt', local: CONFLICT_LOCAL, remote: CONFLICT_REMOTE, record: { ...REC, path: 'notes.txt' } };
		const result = classifyActions([action], mockSettings({ textFileConflict: 'Merge' }));
		expect(result.contentConflicts).toBe(1);
		expect(result.textMergeFiles).toBe(1);
	});

	it('.md conflict with Keep Both strategy → contentConflicts + path, no textMergeFiles', () => {
		const action: SyncAction = { type: 'conflict', path: 'note.md', local: CONFLICT_LOCAL, remote: CONFLICT_REMOTE, record: REC };
		const result = classifyActions([action], mockSettings({ textFileConflict: 'Keep Both' }));
		expect(result.contentConflicts).toBe(1);
		expect(result.contentConflictPaths).toEqual(['note.md']);
		expect(result.textMergeFiles).toBe(0);
		expect(result.textMergeFilePaths).toEqual([]);
	});

	it('binary file conflict with Merge strategy → contentConflicts only, no textMergeFiles', () => {
		const binLocal: FileSide = { path: 'image.png', mtime: 3000, size: 200 };
		const binRemote: FileSide & { driveFileId: string } = { path: 'image.png', mtime: 2500, size: 150, driveFileId: 'id2' };
		const action: SyncAction = { type: 'conflict', path: 'image.png', local: binLocal, remote: binRemote, record: { ...REC, path: 'image.png' } };
		const result = classifyActions([action], mockSettings({ textFileConflict: 'Merge' }));
		expect(result.contentConflicts).toBe(1);
		expect(result.textMergeFiles).toBe(0);
	});

	// ── noOp ─────────────────────────────────────────────────────────────────

	it('noOp is silently ignored', () => {
		const result = classifyActions([{ type: 'noOp', path: 'a.md' }], mockSettings());
		expect(result.groupNew).toBe(0);
		expect(result.localNew).toBe(0);
		expect(result.groupDeleted).toBe(0);
		expect(result.localDeleted).toBe(0);
		expect(result.contentConflicts).toBe(0);
	});

	// ── accumulation ──────────────────────────────────────────────────────────

	it('accumulates counts across mixed action types', () => {
		const actions: SyncAction[] = [
			{ type: 'push', path: 'a.md' },
			{ type: 'push', path: 'b.md' },
			{ type: 'pull', path: 'c.md', local: LOCAL },
			{ type: 'deleteLocal', path: 'd.md' },
			{ type: 'deleteRemote', path: 'e.md' },
		];
		const result = classifyActions(actions, mockSettings());
		expect(result.groupNew).toBe(2);
		expect(result.localUpdated).toBe(1);
		expect(result.localDeleted).toBe(1);
		expect(result.groupDeleted).toBe(1);
	});

	// ── collectedAt ───────────────────────────────────────────────────────────

	it('sets collectedAt to a current timestamp', () => {
		const before = Date.now();
		const result = classifyActions([], mockSettings());
		const after = Date.now();
		expect(result.collectedAt).toBeGreaterThanOrEqual(before);
		expect(result.collectedAt).toBeLessThanOrEqual(after);
	});
});
