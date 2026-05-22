import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SyncStore } from './store';
import { DeferralStore } from './deferral-store';
import { DeferralManager } from './deferral-manager';
import type { MixedEntry, SyncAction } from './types';

beforeEach(() => {
	// eslint-disable-next-line obsidianmd/prefer-active-doc -- test env setup, not production UI code
	globalThis.indexedDB = new IDBFactory();
});

function makeAction(path: string, overrides: Partial<SyncAction> = {}): SyncAction {
	return {
		type: 'push',
		path,
		local: { path, mtime: 1000, size: 100 },
		...overrides,
	};
}

function makeEntry(path: string, localMtime?: number, remoteMtime?: number): MixedEntry {
	return {
		path,
		local: localMtime !== undefined ? { path, mtime: localMtime, size: 100 } : undefined,
		remote: remoteMtime !== undefined ? { path, mtime: remoteMtime, size: 100, driveFileId: `drive-${path}` } : undefined,
	};
}

describe('DeferralManager', () => {
	let syncStore: SyncStore;
	let deferralStore: DeferralStore;
	let onChangedMock: ReturnType<typeof vi.fn<() => void>>;
	let manager: DeferralManager;

	beforeEach(async () => {
		syncStore = new SyncStore('test-vault');
		await syncStore.open();
		deferralStore = new DeferralStore(syncStore.getIdb());
		onChangedMock = vi.fn<() => void>();
		manager = new DeferralManager(deferralStore, onChangedMock);
	});

	afterEach(() => {
		syncStore.close();
	});

	// -------------------------------------------------------------------------
	// paused flag delegation
	// -------------------------------------------------------------------------

	describe('isPaused / setPaused', () => {
		it('returns false initially', async () => {
			expect(await manager.isPaused()).toBe(false);
		});

		it('persists paused = true and fires onChangedMock', async () => {
			await manager.setPaused(true);
			expect(await manager.isPaused()).toBe(true);
			expect(onChangedMock).toHaveBeenCalledOnce();
		});

		it('persists paused = false and fires onChangedMock', async () => {
			await manager.setPaused(true);
			onChangedMock.mockClear();
			await manager.setPaused(false);
			expect(await manager.isPaused()).toBe(false);
			expect(onChangedMock).toHaveBeenCalledOnce();
		});
	});

	// -------------------------------------------------------------------------
	// deferAllAndPause
	// -------------------------------------------------------------------------

	describe('deferAllAndPause', () => {
		it('defers all actions and sets paused', async () => {
			const actions = [
				makeAction('a.md'),
				makeAction('b.md', { type: 'pull', local: undefined, remote: { path: 'b.md', mtime: 2000, size: 50, driveFileId: 'drive-b' } }),
			];
			await manager.deferAllAndPause(actions);

			expect(await manager.isPaused()).toBe(true);
			expect(await manager.getTotalCount()).toBe(2);
		});

		it('stores correct mtimes from the action', async () => {
			const action = makeAction('notes/x.md', {
				local: { path: 'notes/x.md', mtime: 3000, size: 200 },
			});
			await manager.deferAllAndPause([action]);
			const grouped = await manager.getGroupedByType();
			const candidates = grouped.get('push') ?? [];
			expect(candidates).toHaveLength(1);
			expect(candidates[0]!.localMtime).toBe(3000);
			expect(candidates[0]!.remoteMtime).toBe(0);
		});

		it('stores driveFileId for remote actions', async () => {
			const action = makeAction('r.md', {
				type: 'pull',
				local: undefined,
				remote: { path: 'r.md', mtime: 5000, size: 10, driveFileId: 'drive-xyz' },
			});
			await manager.deferAllAndPause([action]);
			const grouped = await manager.getGroupedByType();
			const candidates = grouped.get('pull') ?? [];
			expect(candidates).toHaveLength(1);
			expect(candidates[0]!.driveFileId).toBe('drive-xyz');
		});

		it('replaces existing candidates when called again', async () => {
			await manager.deferAllAndPause([makeAction('old.md')]);
			await manager.deferAllAndPause([makeAction('new.md')]);
			expect(await manager.getTotalCount()).toBe(1);
			const grouped = await manager.getGroupedByType();
			const pushCandidates = grouped.get('push') ?? [];
			expect(pushCandidates).toHaveLength(1);
			expect(pushCandidates[0]!.path).toBe('new.md');
		});

		it('fires onChangedMock', async () => {
			await manager.deferAllAndPause([makeAction('x.md')]);
			expect(onChangedMock).toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// reconcile
	// -------------------------------------------------------------------------

	describe('reconcile', () => {
		it('returns empty set when no candidates are deferred', async () => {
			const result = await manager.reconcile([makeEntry('a.md', 1000)]);
			expect(result.size).toBe(0);
		});

		it('keeps candidate when both mtimes still match', async () => {
			await manager.deferAllAndPause([makeAction('a.md', { local: { path: 'a.md', mtime: 1000, size: 100 } })]);
			onChangedMock.mockClear();

			const result = await manager.reconcile([makeEntry('a.md', 1000)]);

			expect(result.has('a.md')).toBe(true);
			expect(onChangedMock).not.toHaveBeenCalled();
		});

		it('drops candidate when local mtime changes', async () => {
			await manager.deferAllAndPause([makeAction('a.md', { local: { path: 'a.md', mtime: 1000, size: 100 } })]);
			onChangedMock.mockClear();

			const result = await manager.reconcile([makeEntry('a.md', 9999)]);

			expect(result.has('a.md')).toBe(false);
			expect(await manager.getTotalCount()).toBe(0);
			expect(onChangedMock).toHaveBeenCalledOnce();
		});

		it('drops candidate when remote mtime changes', async () => {
			const action = makeAction('b.md', {
				type: 'conflict',
				local: { path: 'b.md', mtime: 1000, size: 100 },
				remote: { path: 'b.md', mtime: 2000, size: 100, driveFileId: 'drive-b' },
			});
			await manager.deferAllAndPause([action]);
			onChangedMock.mockClear();

			// Remote mtime changed to 3000.
			const result = await manager.reconcile([makeEntry('b.md', 1000, 3000)]);

			expect(result.has('b.md')).toBe(false);
			expect(await manager.getTotalCount()).toBe(0);
		});

		it('drops candidate when file is absent (rename/delete)', async () => {
			await manager.deferAllAndPause([makeAction('gone.md')]);
			onChangedMock.mockClear();

			// Path does not appear in current entries at all.
			const result = await manager.reconcile([makeEntry('other.md', 500)]);

			expect(result.has('gone.md')).toBe(false);
			expect(await manager.getTotalCount()).toBe(0);
		});

		it('handles mix of kept and dropped candidates', async () => {
			await manager.deferAllAndPause([
				makeAction('keep.md', { local: { path: 'keep.md', mtime: 100, size: 10 } }),
				makeAction('drop.md', { local: { path: 'drop.md', mtime: 200, size: 10 } }),
			]);
			onChangedMock.mockClear();

			const result = await manager.reconcile([
				makeEntry('keep.md', 100),   // unchanged → keep
				makeEntry('drop.md', 999),   // changed → drop
			]);

			expect(result.has('keep.md')).toBe(true);
			expect(result.has('drop.md')).toBe(false);
			expect(await manager.getTotalCount()).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// releaseByPath
	// -------------------------------------------------------------------------

	describe('releaseByPath', () => {
		it('removes specified paths from the deferred list', async () => {
			await manager.deferAllAndPause([makeAction('a.md'), makeAction('b.md'), makeAction('c.md')]);
			onChangedMock.mockClear();

			await manager.releaseByPath(['a.md', 'c.md']);

			expect(await manager.getTotalCount()).toBe(1);
			const grouped = await manager.getGroupedByType();
			const remaining = grouped.get('push') ?? [];
			expect(remaining).toHaveLength(1);
			expect(remaining[0]!.path).toBe('b.md');
			expect(onChangedMock).toHaveBeenCalledOnce();
		});

		it('is a no-op for an empty array', async () => {
			await manager.deferAllAndPause([makeAction('x.md')]);
			onChangedMock.mockClear();

			await manager.releaseByPath([]);

			expect(await manager.getTotalCount()).toBe(1);
			expect(onChangedMock).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// getGroupedByType
	// -------------------------------------------------------------------------

	describe('getGroupedByType', () => {
		it('returns empty map when no candidates exist', async () => {
			expect((await manager.getGroupedByType()).size).toBe(0);
		});

		it('groups candidates by actionType', async () => {
			await manager.deferAllAndPause([
				makeAction('a.md', { type: 'push' }),
				makeAction('b.md', { type: 'push' }),
				makeAction('c.md', { type: 'pull', local: undefined, remote: { path: 'c.md', mtime: 1, size: 1, driveFileId: 'x' } }),
				makeAction('d.md', { type: 'conflict' }),
			]);

			const grouped = await manager.getGroupedByType();
			expect(grouped.get('push')).toHaveLength(2);
			expect(grouped.get('pull')).toHaveLength(1);
			expect(grouped.get('conflict')).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// getTotalCount
	// -------------------------------------------------------------------------

	describe('getTotalCount', () => {
		it('returns 0 when no candidates exist', async () => {
			expect(await manager.getTotalCount()).toBe(0);
		});

		it('returns the correct total', async () => {
			await manager.deferAllAndPause([makeAction('a.md'), makeAction('b.md'), makeAction('c.md')]);
			expect(await manager.getTotalCount()).toBe(3);
		});
	});
});
