import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SyncStore } from './store';
import { DeferralStore } from './deferral-store';
import type { DeferredCandidate } from './types';

beforeEach(() => {
	// eslint-disable-next-line obsidianmd/prefer-active-doc -- test env setup, not production UI code
	globalThis.indexedDB = new IDBFactory();
});

function makeCandidate(path: string, overrides: Partial<DeferredCandidate> = {}): DeferredCandidate {
	return {
		path,
		actionType: 'push',
		localMtime: 1000,
		remoteMtime: 0,
		driveFileId: undefined,
		deferredAt: 5000,
		...overrides,
	};
}

describe('DeferralStore', () => {
	let syncStore: SyncStore;
	let store: DeferralStore;

	beforeEach(async () => {
		syncStore = new SyncStore('test-vault');
		await syncStore.open();
		store = new DeferralStore(syncStore.getIdb());
	});

	afterEach(() => {
		syncStore.close();
	});

	// -------------------------------------------------------------------------
	// deferred-candidates store
	// -------------------------------------------------------------------------

	describe('deferred candidates', () => {
		it('returns empty array when no candidates exist', async () => {
			expect(await store.getAllCandidates()).toEqual([]);
		});

		it('round-trips a single candidate', async () => {
			const c = makeCandidate('notes/foo.md');
			await store.putCandidate(c);
			expect(await store.getAllCandidates()).toEqual([c]);
		});

		it('overwrites a candidate with the same path', async () => {
			await store.putCandidate(makeCandidate('a.md', { localMtime: 100 }));
			await store.putCandidate(makeCandidate('a.md', { localMtime: 999 }));
			const all = await store.getAllCandidates();
			expect(all).toHaveLength(1);
			expect(all[0]!.localMtime).toBe(999);
		});

		it('putCandidates stores multiple candidates in one call', async () => {
			const inputs = [
				makeCandidate('a.md'),
				makeCandidate('b.md', { actionType: 'pull' }),
				makeCandidate('c.md', { actionType: 'deleteRemote' }),
			];
			await store.putCandidates(inputs);
			const all = await store.getAllCandidates();
			expect(all).toHaveLength(3);
			expect(all.map(c => c.path).sort()).toEqual(['a.md', 'b.md', 'c.md']);
		});

		it('putCandidates is a no-op for an empty array', async () => {
			await expect(store.putCandidates([])).resolves.toBeUndefined();
			expect(await store.getAllCandidates()).toEqual([]);
		});

		it('deleteCandidate removes the candidate', async () => {
			await store.putCandidate(makeCandidate('x.md'));
			await store.deleteCandidate('x.md');
			expect(await store.getAllCandidates()).toEqual([]);
		});

		it('deleteCandidate is a no-op for an unknown path', async () => {
			await expect(store.deleteCandidate('ghost.md')).resolves.toBeUndefined();
		});

		it('deleteCandidates removes multiple candidates in one call', async () => {
			await store.putCandidates([makeCandidate('a.md'), makeCandidate('b.md'), makeCandidate('c.md')]);
			await store.deleteCandidates(['a.md', 'c.md']);
			const all = await store.getAllCandidates();
			expect(all).toHaveLength(1);
			expect(all[0]!.path).toBe('b.md');
		});

		it('deleteCandidates is a no-op for an empty array', async () => {
			await store.putCandidate(makeCandidate('z.md'));
			await store.deleteCandidates([]);
			expect(await store.getAllCandidates()).toHaveLength(1);
		});

		it('clearCandidates removes all candidates', async () => {
			await store.putCandidates([makeCandidate('a.md'), makeCandidate('b.md')]);
			await store.clearCandidates();
			expect(await store.getAllCandidates()).toEqual([]);
		});

		it('stores driveFileId when present', async () => {
			const c = makeCandidate('pull.md', { actionType: 'pull', remoteMtime: 2000, driveFileId: 'drive-abc' });
			await store.putCandidate(c);
			const all = await store.getAllCandidates();
			expect(all).toHaveLength(1);
			expect(all[0]!.driveFileId).toBe('drive-abc');
		});
	});

	// -------------------------------------------------------------------------
	// sync-state store (paused flag)
	// -------------------------------------------------------------------------

	describe('paused flag', () => {
		it('returns false when not yet set', async () => {
			expect(await store.isPaused()).toBe(false);
		});

		it('round-trips paused = true', async () => {
			await store.setPaused(true);
			expect(await store.isPaused()).toBe(true);
		});

		it('round-trips paused = false', async () => {
			await store.setPaused(true);
			await store.setPaused(false);
			expect(await store.isPaused()).toBe(false);
		});
	});
});
