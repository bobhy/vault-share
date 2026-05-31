/**
 * Unit tests for CandidateStore.
 *
 * Uses fake-indexeddb for IDB and SyncStore.getIdb() to share the schema setup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SyncStore } from './store';
import { CandidateStore } from './candidate-store';
import type { FileSide } from './types';
import type { DriveFileSide } from './drive-fs';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const LOCAL_A: FileSide     = { path: 'a.md', mtime: 1000, size: 10 };
const REMOTE_A: DriveFileSide = { path: 'a.md', mtime: 1000, size: 10, driveFileId: 'drive-a' };

const LOCAL_B: FileSide     = { path: 'b.md', mtime: 2000, size: 20 };
const _REMOTE_B: DriveFileSide = { path: 'b.md', mtime: 2000, size: 20, driveFileId: 'drive-b' };

function syncedState(overrides = {}) {
	return {
		driveFileId: 'drive-x',
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 10,
		remoteSize: 10,
		syncedAt: 500,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Harness: SyncStore + CandidateStore pair backed by fake-indexeddb
// ---------------------------------------------------------------------------

beforeEach(() => {
	// eslint-disable-next-line obsidianmd/prefer-active-doc -- test env setup, not production UI code
	globalThis.indexedDB = new IDBFactory();
});

async function makeStore(): Promise<{ store: SyncStore; cs: CandidateStore }> {
	const store = new SyncStore('test-vault');
	await store.open();
	const cs = new CandidateStore(store.getIdb());
	await cs.init();
	return { store, cs };
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('CandidateStore.init', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('starts with an empty cache and paused=false', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();
		expect(cs.getAll()).toEqual([]);
		expect(cs.isPausedSync()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// reconcile — basic insertion
// ---------------------------------------------------------------------------

describe('CandidateStore.reconcile: insertion', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('creates a Default push candidate for local-only file in empty vault', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);

		const all = cs.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ path: 'a.md', state: 'Default', actionType: 'push' });
	});

	it('creates a Default pull candidate for remote-only file in empty vault', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([], [REMOTE_A]);

		const all = cs.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ path: 'a.md', state: 'Default', actionType: 'pull' });
	});

	it('does NOT create a candidate when both sides are absent', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([], []);

		expect(cs.getAll()).toHaveLength(0);
	});

	it('creates a Synced candidate when both sides are present and sizes match (rebaseline)', async () => {
		// The pluginReset and fresh-install-joining-vault scenarios:
		// reconcile sees a file on both sides with no candidate record.
		// Size equality is the rebaseline signal — record as Synced at the
		// current mtime/size so future edits classify correctly, rather than
		// forcing a conflict workflow that, under default settings, would
		// also duplicate every binary attachment via Keep Both.
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], [REMOTE_A]);

		const all = cs.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			path: 'a.md',
			state: 'Synced',
			actionType: 'noOp',
			driveFileId: 'drive-a',
			syncedLocalMtime: LOCAL_A.mtime,
			syncedLocalSize: LOCAL_A.size,
			syncedRemoteMtime: REMOTE_A.mtime,
			syncedRemoteSize: REMOTE_A.size,
		});
		expect(all[0]?.syncedAt).toBeGreaterThan(0);
	});

	it('creates a Default conflict candidate when both sides are present and sizes differ', async () => {
		// Size mismatch is the strong "content differs" signal — fall back to
		// the conflict path so the user actually reviews / resolves.
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		const remoteBiggerSize: DriveFileSide = { ...REMOTE_A, size: REMOTE_A.size + 1 };
		await cs.reconcile([LOCAL_A], [remoteBiggerSize]);

		const all = cs.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ path: 'a.md', state: 'Default', actionType: 'conflict' });
	});

	it('subsequent local edit after rebaseline classifies as push (not as a fresh-history conflict)', async () => {
		// Regression: without recording the rebaseline as Synced, the next
		// reconcile after a local edit would re-enter the no-history path
		// (no candidate → wasSynced=false) and treat the now-only-local-edit
		// state as `(local && !remote? push) | (both? conflict)` based on
		// whether remote still happens to match. With the rebaseline Synced
		// record in place, the second reconcile correctly classifies the
		// local edit as `push`.
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], [REMOTE_A]);  // rebaseline → Synced

		const editedLocal: FileSide = { ...LOCAL_A, mtime: LOCAL_A.mtime + 1, size: LOCAL_A.size + 5 };
		await cs.reconcile([editedLocal], [REMOTE_A]);  // local edited, remote unchanged

		expect(cs.getAll()[0]).toMatchObject({
			path: 'a.md',
			state: 'Default',
			actionType: 'push',
		});
	});
});

// ---------------------------------------------------------------------------
// reconcile — state transitions for a Synced candidate
// ---------------------------------------------------------------------------

describe('CandidateStore.reconcile: Synced transitions', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('Synced stays Synced when both sides match the sync history', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		// Insert a Synced candidate via insertSynced.
		await cs.insertSynced('a.md', syncedState({ driveFileId: 'drive-a', localMtime: 1000, remoteMtime: 1000 }));

		// Reconcile: both sides unchanged.
		await cs.reconcile([LOCAL_A], [REMOTE_A]);

		expect(cs.getAll().find(x => x.path === 'a.md')).toMatchObject({ path: 'a.md', state: 'Synced', actionType: 'noOp' });
	});

	it('Synced → Default when local is modified', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		// Insert synced at localMtime=1000, but reconcile with mtime=2000 (modified).
		await cs.insertSynced('a.md', syncedState({ driveFileId: 'drive-a', localMtime: 1000, remoteMtime: 1000 }));

		const modifiedLocal: FileSide = { path: 'a.md', mtime: 2000, size: 15 };
		await cs.reconcile([modifiedLocal], [REMOTE_A]);

		const c = cs.getAll().find(x => x.path === 'a.md');
		expect(c).toMatchObject({ path: 'a.md', state: 'Default', actionType: 'push' });
	});

	it('Synced → Default when remote is modified', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.insertSynced('a.md', syncedState({ driveFileId: 'drive-a', localMtime: 1000, remoteMtime: 1000 }));

		const modifiedRemote: DriveFileSide = { path: 'a.md', mtime: 2000, size: 15, driveFileId: 'drive-a' };
		await cs.reconcile([LOCAL_A], [modifiedRemote]);

		const c = cs.getAll().find(x => x.path === 'a.md');
		expect(c).toMatchObject({ path: 'a.md', state: 'Default', actionType: 'pull' });
	});

	it('transitions Synced → Default(deleteLocal) when both sides disappear (both-deleted race)', async () => {
		// When a previously-synced file disappears from both sides, reconcile produces
		// deleteLocal so BulkSync can clean up the orphaned candidate (via candidateStore.remove).
		// The candidate is NOT removed by reconcile itself; removal happens after BulkSync executes.
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.insertSynced('a.md', syncedState());
		await cs.reconcile([], []);

		const c = cs.getAll().find(x => x.path === 'a.md');
		expect(c).toBeDefined();
		expect(c?.state).toBe('Default');
		expect(c?.actionType).toBe('deleteLocal');
	});

	it('removes candidate when noOp + both sides never existed (cache entry with no history)', async () => {
		// A Synced candidate created via insertSynced then explicitly removed is gone.
		// Simpler case: direct remove call.
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.insertSynced('a.md', syncedState());
		await cs.remove('a.md');

		expect(cs.getAll()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// reconcile — Deferred auto-revocation
// ---------------------------------------------------------------------------

describe('CandidateStore.reconcile: Deferred auto-revocation', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('Deferred stays Deferred when mtimes are unchanged', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		// Create a Default candidate first, then defer it.
		await cs.reconcile([LOCAL_A], []);
		await cs.defer(['a.md']);
		expect(cs.getAll().find(x => x.path === 'a.md')?.state).toBe('Deferred');

		// Reconcile with the same files — mtime unchanged → stays Deferred.
		await cs.reconcile([LOCAL_A], []);
		expect(cs.getAll().find(x => x.path === 'a.md')?.state).toBe('Deferred');
	});

	it('Deferred → Default when local mtime changed (auto-revocation)', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		await cs.defer(['a.md']);

		// Reconcile with a different mtime → auto-revocation.
		const updated: FileSide = { path: 'a.md', mtime: 9999, size: 10 };
		await cs.reconcile([updated], []);

		const c = cs.getAll().find(x => x.path === 'a.md');
		expect(c?.state).toBe('Default');
		expect(c?.deferredAt).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// approve / defer
// ---------------------------------------------------------------------------

describe('CandidateStore.approve and defer', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('approve transitions Default → Approved', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		await cs.approve(['a.md']);

		expect(cs.getAll().find(x => x.path === 'a.md')?.state).toBe('Approved');
	});

	it('defer transitions Default → Deferred and captures deferral sentinels', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		const deferAt = Date.now();
		await cs.defer(['a.md'], deferAt);

		const c = cs.getAll().find(x => x.path === 'a.md');
		expect(c?.state).toBe('Deferred');
		expect(c?.deferredAt).toBe(deferAt);
		expect(c?.deferredLocalMtime).toBe(LOCAL_A.mtime);
	});

	it('approve no-ops for unknown paths', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await expect(cs.approve(['ghost.md'])).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// deferAllAndPause
// ---------------------------------------------------------------------------

describe('CandidateStore.deferAllAndPause', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('transitions all Default candidates to Deferred and sets paused=true', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A, LOCAL_B], []);
		const pending = cs.getPending();
		expect(pending).toHaveLength(2);

		await cs.deferAllAndPause(pending);

		expect(cs.isPausedSync()).toBe(true);
		for (const c of cs.getAll()) {
			expect(c.state).toBe('Deferred');
		}
	});

	it('paused=true survives init (persisted to IDB)', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.deferAllAndPause([]);

		// Re-init from same IDB to simulate restart.
		const cs2 = new CandidateStore(store.getIdb());
		await cs2.init();
		expect(cs2.isPausedSync()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// markSynced
// ---------------------------------------------------------------------------

describe('CandidateStore.markSynced', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('transitions Approved → Synced and records sync history', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		await cs.approve(['a.md']);
		await cs.markSynced('a.md', syncedState({ driveFileId: 'drive-a-new', localMtime: 1000, remoteMtime: 1001 }));

		const c = cs.getAll().find(x => x.path === 'a.md');
		expect(c?.state).toBe('Synced');
		expect(c?.actionType).toBe('noOp');
		expect(c?.driveFileId).toBe('drive-a-new');
		expect(c?.syncedAt).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe('CandidateStore.remove', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('removes a candidate from cache and IDB', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		expect(cs.getAll()).toHaveLength(1);

		await cs.remove('a.md');
		expect(cs.getAll()).toHaveLength(0);

		// Persisted removal: re-init sees empty.
		const cs2 = new CandidateStore(store.getIdb());
		await cs2.init();
		expect(cs2.getAll()).toHaveLength(0);
	});

	it('no-ops for unknown path', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await expect(cs.remove('ghost.md')).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// insertSynced
// ---------------------------------------------------------------------------

describe('CandidateStore.insertSynced', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('inserts a Synced candidate so the next reconcile does not re-plan it', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		const state = syncedState({ driveFileId: 'drive-c', localMtime: 1500, remoteMtime: 1500 });
		await cs.insertSynced('c.md', state);

		const c = cs.getAll()[0];
		expect(c).toMatchObject({
			path: 'c.md',
			state: 'Synced',
			actionType: 'noOp',
			driveFileId: 'drive-c',
		});
	});

	it('inserted candidate persists across re-init', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.insertSynced('d.md', syncedState());

		const cs2 = new CandidateStore(store.getIdb());
		await cs2.init();
		expect(cs2.getAll().find(c => c.path === 'd.md')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// applyFileResult
// ---------------------------------------------------------------------------

describe('CandidateStore.applyFileResult', () => {
	let store: SyncStore;
	afterEach(() => { store.close(); });

	it('is a no-op when changed=false', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();
		await cs.insertSynced('a.md', syncedState());

		await cs.applyFileResult('a.md', 'push', {
			changed: false, merged: false, hadConflictMarkers: false,
		});
		expect(cs.get('a.md')).toBeDefined();
	});

	it('removes the candidate for a deleteLocal/deleteRemote action', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();
		await cs.insertSynced('a.md', syncedState());

		await cs.applyFileResult('a.md', 'deleteRemote', {
			changed: true, merged: false, hadConflictMarkers: false,
		});
		expect(cs.get('a.md')).toBeUndefined();
	});

	it('upserts as Synced when syncedState is set on a cached candidate', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();
		await cs.reconcile([LOCAL_A], []);  // creates 'a.md' as Default(push)

		await cs.applyFileResult('a.md', 'push', {
			changed: true, merged: false, hadConflictMarkers: false,
			syncedState: syncedState({ driveFileId: 'drive-a' }),
		});
		expect(cs.get('a.md')).toMatchObject({ state: 'Synced', actionType: 'noOp' });
	});

	it('inserts as Synced when syncedState is set on a never-seen path', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.applyFileResult('brand-new.md', 'push', {
			changed: true, merged: false, hadConflictMarkers: false,
			syncedState: syncedState({ driveFileId: 'drive-new' }),
		});
		expect(cs.get('brand-new.md')).toMatchObject({ state: 'Synced', driveFileId: 'drive-new' });
	});

	it('removes the original candidate for a Keep Both conflict (changed + newSyncedFiles, no syncedState)', async () => {
		// Regression: this used to leave the original candidate stranded until
		// a future reconcile reclassified it as deleteLocal and another pass
		// finally swept it up. The applyFileResult contract is now: changed
		// without syncedState on a non-delete action means the original path
		// is gone, drop the candidate.
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();
		await cs.insertSynced('a.md', syncedState());

		await cs.applyFileResult('a.md', 'conflict', {
			changed: true, merged: false, hadConflictMarkers: false,
			newSyncedFiles: [
				{ path: 'a-conflict-local.md',  ...syncedState({ driveFileId: 'drive-local' })  },
				{ path: 'a-conflict-remote.md', ...syncedState({ driveFileId: 'drive-remote' }) },
			],
		});

		expect(cs.get('a.md')).toBeUndefined();
		expect(cs.get('a-conflict-local.md')).toMatchObject({ state: 'Synced', driveFileId: 'drive-local' });
		expect(cs.get('a-conflict-remote.md')).toMatchObject({ state: 'Synced', driveFileId: 'drive-remote' });
	});
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('CandidateStore.clear', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('removes all candidates from cache and IDB', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A, LOCAL_B], []);
		await cs.clear();

		expect(cs.getAll()).toHaveLength(0);

		const cs2 = new CandidateStore(store.getIdb());
		await cs2.init();
		expect(cs2.getAll()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// isPaused / setPaused
// ---------------------------------------------------------------------------

describe('CandidateStore paused flag', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('isPausedSync returns false before init', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		// Not yet inited.
		expect(cs.isPausedSync()).toBe(false);
	});

	it('setPaused(true) is reflected in isPausedSync and isPaused()', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.setPaused(true);
		expect(cs.isPausedSync()).toBe(true);
		expect(await cs.isPaused()).toBe(true);
	});

	it('setPaused(false) clears the flag', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.setPaused(true);
		await cs.setPaused(false);
		expect(cs.isPausedSync()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// hasSyncHistory / getPendingCount / isDeferred
// ---------------------------------------------------------------------------

describe('CandidateStore query helpers', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('hasSyncHistory returns false when no candidate has syncedAt > 0', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		expect(cs.hasSyncHistory()).toBe(false);
	});

	it('hasSyncHistory returns true after insertSynced', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.insertSynced('a.md', syncedState({ syncedAt: 1000 }));
		expect(cs.hasSyncHistory()).toBe(true);
	});

	it('getPendingCount returns 0 when all candidates are Synced', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.insertSynced('a.md', syncedState({ syncedAt: 1000 }));
		expect(cs.getPendingCount()).toBe(0);
	});

	it('getPendingCount counts Default and Deferred but not Synced', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A, LOCAL_B], []);
		// One deferred, one default.
		await cs.defer(['a.md']);
		expect(cs.getPendingCount()).toBe(2); // both non-Synced
	});

	it('isDeferred returns true only for Deferred candidates', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		await cs.defer(['a.md']);
		expect(cs.isDeferred('a.md')).toBe(true);
		expect(cs.isDeferred('b.md')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// onChanged callback
// ---------------------------------------------------------------------------

describe('CandidateStore.onChanged', () => {
	let store: SyncStore;

	afterEach(() => { store.close(); });

	it('fires onChanged after reconcile that creates a new candidate', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		const onChanged = vi.fn();
		cs.onChange(onChanged);

		await cs.reconcile([LOCAL_A], []);
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it('does not fire onChanged when reconcile makes no changes', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		// No local, no remote, no existing candidates → no-op.
		const onChanged = vi.fn();
		cs.onChange(onChanged);

		await cs.reconcile([], []);
		expect(onChanged).not.toHaveBeenCalled();
	});

	it('fires onChanged after approve', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		await cs.reconcile([LOCAL_A], []);
		const onChanged = vi.fn();
		cs.onChange(onChanged);

		await cs.approve(['a.md']);
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it('fires onChanged after setPaused', async () => {
		({ store } = await makeStore());
		const cs = new CandidateStore(store.getIdb());
		await cs.init();

		const onChanged = vi.fn();
		cs.onChange(onChanged);

		await cs.setPaused(true);
		expect(onChanged).toHaveBeenCalledTimes(1);
	});
});
