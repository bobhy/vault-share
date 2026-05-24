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
	// init — warms both caches
	// -------------------------------------------------------------------------

	describe('init', () => {
		it('warms cachedPaused so isPausedSync() returns false when store is false', async () => {
			await manager.init();
			expect(manager.isPausedSync()).toBe(false);
		});

		it('warms cachedPaused so isPausedSync() returns true when store is true', async () => {
			await deferralStore.setPaused(true);
			await manager.init();
			expect(manager.isPausedSync()).toBe(true);
		});

		it('warms cachedDeferredPaths so isDeferredPathSync() works immediately', async () => {
			// Pre-load a candidate directly into the store before init.
			await deferralStore.putCandidate({ path: 'pre.md', actionType: 'push', localMtime: 1, remoteMtime: 0, deferredAt: 0 });
			await manager.init();
			expect(manager.isDeferredPathSync('pre.md')).toBe(true);
			expect(manager.isDeferredPathSync('other.md')).toBe(false);
		});
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

	describe('isPausedSync', () => {
		it('returns false before the cache is warmed', () => {
			// A brand-new manager has not yet read from IndexedDB.
			expect(manager.isPausedSync()).toBe(false);
		});

		it('returns false after isPaused() resolves to false', async () => {
			await manager.isPaused(); // warms cache
			expect(manager.isPausedSync()).toBe(false);
		});

		it('reflects true immediately after setPaused(true)', async () => {
			await manager.setPaused(true);
			expect(manager.isPausedSync()).toBe(true);
		});

		it('reflects false immediately after setPaused(false)', async () => {
			await manager.setPaused(true);
			await manager.setPaused(false);
			expect(manager.isPausedSync()).toBe(false);
		});

		it('reflects true immediately after deferAllAndPause', async () => {
			await manager.deferAllAndPause([makeAction('a.md')]);
			expect(manager.isPausedSync()).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// isDeferredPathSync
	// -------------------------------------------------------------------------

	describe('isDeferredPathSync', () => {
		it('returns false before the cache is warmed', () => {
			expect(manager.isDeferredPathSync('a.md')).toBe(false);
		});

		it('returns false after init() when no candidates are deferred', async () => {
			await manager.init();
			expect(manager.isDeferredPathSync('a.md')).toBe(false);
		});

		it('returns true immediately after deferAllAndPause', async () => {
			await manager.deferAllAndPause([makeAction('a.md'), makeAction('b.md')]);
			expect(manager.isDeferredPathSync('a.md')).toBe(true);
			expect(manager.isDeferredPathSync('b.md')).toBe(true);
			expect(manager.isDeferredPathSync('c.md')).toBe(false);
		});

		it('returns false for released paths after releaseByPath', async () => {
			await manager.deferAllAndPause([makeAction('a.md'), makeAction('b.md')]);
			await manager.releaseByPath(['a.md']);
			expect(manager.isDeferredPathSync('a.md')).toBe(false);
			expect(manager.isDeferredPathSync('b.md')).toBe(true);
		});

		it('returns false for all paths after releaseAll', async () => {
			await manager.deferAllAndPause([makeAction('a.md'), makeAction('b.md')]);
			await manager.releaseAll();
			expect(manager.isDeferredPathSync('a.md')).toBe(false);
			expect(manager.isDeferredPathSync('b.md')).toBe(false);
		});

		it('reflects stale-candidate removal after reconcile', async () => {
			await manager.deferAllAndPause([makeAction('a.md', { local: { path: 'a.md', mtime: 1000, size: 100 } })]);
			expect(manager.isDeferredPathSync('a.md')).toBe(true);

			// Mtime changed → reconcile drops the candidate.
			await manager.reconcile([makeEntry('a.md', 9999)]);
			expect(manager.isDeferredPathSync('a.md')).toBe(false);
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
			expect((await deferralStore.getAllCandidates()).length).toBe(2);
		});

		it('stores correct mtimes from the action', async () => {
			const action = makeAction('notes/x.md', {
				local: { path: 'notes/x.md', mtime: 3000, size: 200 },
			});
			await manager.deferAllAndPause([action]);
			const candidates = await deferralStore.getAllCandidates();
			const candidate = candidates.find(c => c.path === 'notes/x.md');
			expect(candidate?.localMtime).toBe(3000);
			expect(candidate?.remoteMtime).toBe(0);
		});

		it('stores driveFileId for remote actions', async () => {
			const action = makeAction('r.md', {
				type: 'pull',
				local: undefined,
				remote: { path: 'r.md', mtime: 5000, size: 10, driveFileId: 'drive-xyz' },
			});
			await manager.deferAllAndPause([action]);
			const candidates = await deferralStore.getAllCandidates();
			const candidate = candidates.find(c => c.path === 'r.md');
			expect(candidate?.driveFileId).toBe('drive-xyz');
		});

		it('replaces existing candidates when called again', async () => {
			await manager.deferAllAndPause([makeAction('old.md')]);
			await manager.deferAllAndPause([makeAction('new.md')]);
			const candidates = await deferralStore.getAllCandidates();
			expect(candidates.length).toBe(1);
			expect(candidates[0]!.path).toBe('new.md');
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
			expect((await deferralStore.getAllCandidates()).length).toBe(0);
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
			expect((await deferralStore.getAllCandidates()).length).toBe(0);
		});

		it('drops candidate when file is absent (rename/delete)', async () => {
			await manager.deferAllAndPause([makeAction('gone.md')]);
			onChangedMock.mockClear();

			// Path does not appear in current entries at all.
			const result = await manager.reconcile([makeEntry('other.md', 500)]);

			expect(result.has('gone.md')).toBe(false);
			expect((await deferralStore.getAllCandidates()).length).toBe(0);
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
			expect((await deferralStore.getAllCandidates()).length).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// addDeferred
	// -------------------------------------------------------------------------

	describe('addDeferred', () => {
		it('adds candidates to the deferred set and fires onChanged', async () => {
			await manager.addDeferred([
				{ path: 'a.md', actionType: 'push', localMtime: 1000, remoteMtime: 0, deferredAt: 0 },
				{ path: 'b.md', actionType: 'pull', localMtime: 0, remoteMtime: 2000, deferredAt: 0 },
			]);

			expect((await deferralStore.getAllCandidates()).length).toBe(2);
			expect(onChangedMock).toHaveBeenCalledOnce();
		});

		it('updates isDeferredPathSync cache immediately', async () => {
			await manager.init();
			await manager.addDeferred([
				{ path: 'new.md', actionType: 'push', localMtime: 1000, remoteMtime: 0, deferredAt: 0 },
			]);

			expect(manager.isDeferredPathSync('new.md')).toBe(true);
		});

		it('does not pause sharing', async () => {
			await manager.addDeferred([
				{ path: 'x.md', actionType: 'push', localMtime: 1000, remoteMtime: 0, deferredAt: 0 },
			]);

			expect(await manager.isPaused()).toBe(false);
		});

		it('adds to existing deferred candidates without replacing them', async () => {
			await manager.deferAllAndPause([makeAction('existing.md')]);
			onChangedMock.mockClear();

			await manager.addDeferred([
				{ path: 'new.md', actionType: 'push', localMtime: 1000, remoteMtime: 0, deferredAt: 0 },
			]);

			const all = await deferralStore.getAllCandidates();
			expect(all.length).toBe(2);
			expect(all.some(c => c.path === 'existing.md')).toBe(true);
			expect(all.some(c => c.path === 'new.md')).toBe(true);
		});

		it('is a no-op for an empty array', async () => {
			await manager.addDeferred([]);
			expect(onChangedMock).not.toHaveBeenCalled();
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

			const remaining = await deferralStore.getAllCandidates();
			expect(remaining.length).toBe(1);
			expect(remaining[0]!.path).toBe('b.md');
			expect(onChangedMock).toHaveBeenCalledOnce();
		});

		it('is a no-op for an empty array', async () => {
			await manager.deferAllAndPause([makeAction('x.md')]);
			onChangedMock.mockClear();

			await manager.releaseByPath([]);

			expect((await deferralStore.getAllCandidates()).length).toBe(1);
			expect(onChangedMock).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// releaseAll
	// -------------------------------------------------------------------------

	describe('releaseAll', () => {
		it('removes all deferred candidates', async () => {
			await manager.deferAllAndPause([makeAction('a.md'), makeAction('b.md'), makeAction('c.md')]);
			onChangedMock.mockClear();

			await manager.releaseAll();

			expect((await deferralStore.getAllCandidates()).length).toBe(0);
			expect(onChangedMock).toHaveBeenCalledOnce();
		});

		it('is a no-op when nothing is deferred', async () => {
			await manager.releaseAll();
			expect((await deferralStore.getAllCandidates()).length).toBe(0);
			// onChanged still fires (callers may rely on it to update the UI).
			expect(onChangedMock).toHaveBeenCalledOnce();
		});
	});
});
