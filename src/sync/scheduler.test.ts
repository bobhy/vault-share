import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncScheduler } from './scheduler';
import type { SyncSchedulerDeps } from './scheduler';
import type { SyncContext } from './types';
import type { CandidateStore } from './candidate-store';
import type { BulkSync } from './bulk-sync';
import type { EventRef, Workspace } from 'obsidian';
import { mockSettings } from '../__mocks__/sync-test-helpers';

vi.mock('./single-file-sync', () => ({
	singleFileSync: vi.fn().mockResolvedValue(undefined),
}));

// Import the mock AFTER vi.mock() so we get the spy reference.
import { singleFileSync } from './single-file-sync';
const singleFileSyncSpy = singleFileSync as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test workspace / app factory
// ---------------------------------------------------------------------------

type LeafStub = {
	view: { file?: { path: string } };
	parent?: { activeLeaf?: LeafStub };
};

// EventRef is structurally {} in obsidian-mock, so a plain object satisfies it.
const STUB_EVENT_REF: EventRef = {};

function makeWorkspace() {
	const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
	let leaves: LeafStub[] = [];

	return {
		on(event: string, handler: (...args: unknown[]) => void): EventRef {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
			return STUB_EVENT_REF;
		},
		containerEl: { doc: { visibilityState: 'visible' } as Document },
		iterateAllLeaves(cb: (leaf: LeafStub) => void) {
			leaves.forEach(cb);
		},
		// --- test helpers ---
		emit(event: string, ...args: unknown[]) {
			handlers.get(event)?.forEach(h => h(...args));
		},
		setLeaves(newLeaves: LeafStub[]) {
			leaves = newLeaves;
		},
	} as unknown as Workspace & {
		emit: (event: string, ...args: unknown[]) => void;
		setLeaves: (leaves: LeafStub[]) => void;
	};
}

function makeApp() {
	const vaultHandlers = new Map<string, ((file: { path: string }) => void)[]>();

	return {
		vault: {
			on(event: string, handler: (file: { path: string }) => void): EventRef {
				if (!vaultHandlers.has(event)) vaultHandlers.set(event, []);
				vaultHandlers.get(event)!.push(handler);
				return STUB_EVENT_REF;
			},
			emit(event: string, file: { path: string }) {
				vaultHandlers.get(event)?.forEach(h => h(file));
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Scheduler factory
// ---------------------------------------------------------------------------

function makeScheduler(
	settingsOverrides = {},
	isSharingPaused: () => boolean = () => false,
	isDeferredPath: (path: string) => boolean = () => false,
) {
	const workspace = makeWorkspace();
	const app = makeApp();
	const settings = mockSettings({ openFilePoll: 10, openFileChangeHoldDown: 5, bulkSyncPoll: 3600, ...settingsOverrides });

	const ctx = {
		app,
		settings: () => settings,
		store: {
			getContent: vi.fn().mockResolvedValue(null),
			putContent: vi.fn().mockResolvedValue(undefined),
		},
		localFs: {
			read: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
		},
	} as unknown as SyncContext;

	const bulkSyncRunSpy = vi.fn().mockResolvedValue({});
	const bulkSync = { run: bulkSyncRunSpy } as unknown as BulkSync;

	const candidateStore = {
		getAll: vi.fn().mockReturnValue([]),
	} as unknown as CandidateStore;

	const deps: SyncSchedulerDeps = {
		ctx,
		bulkSync,
		candidateStore,
		workspace,
		setStatusBar: vi.fn(),
		registerEvent: vi.fn(),
		registerInterval: vi.fn(),
		isSharingPaused,
		isDeferredPath,
		isVaultReady: () => true,
	};

	const scheduler = new SyncScheduler(deps);

	return { scheduler, workspace, app, ctx, bulkSync, bulkSyncRunSpy };
}

// ---------------------------------------------------------------------------
// Helper: advance fake clock by ms and flush microtask queue
// ---------------------------------------------------------------------------
async function tick(ms = 1000) {
	await vi.advanceTimersByTimeAsync(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncScheduler', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -------------------------------------------------------------------------
	// Initial sync
	// -------------------------------------------------------------------------

	it('syncs a file immediately on first tick after file-open', async () => {
		const { scheduler, workspace } = makeScheduler();
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick();

		expect(singleFileSyncSpy).toHaveBeenCalledWith(
			'notes/hello.md',
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it('does not sync a non-monitored file again after the initial sync', async () => {
		const { scheduler, workspace } = makeScheduler();
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000);   // initial sync fires
		singleFileSyncSpy.mockClear();

		await tick(60_000); // 60 s pass — no further sync for non-monitored file
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	it('does not double-track a file opened multiple times', async () => {
		const { scheduler, workspace } = makeScheduler();
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000);

		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
	});

	// -------------------------------------------------------------------------
	// Hold-down timer (edit)
	// -------------------------------------------------------------------------

	it('schedules a holdDown sync after editing (openFileChangeHoldDown = 5 s)', async () => {
		const { scheduler, workspace, app } = makeScheduler({ openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync fires
		singleFileSyncSpy.mockClear();

		app.vault.emit('modify', { path: 'notes/hello.md' });
		await tick(4000); // 4 s — holdDown not yet due
		expect(singleFileSyncSpy).not.toHaveBeenCalled();

		await tick(2000); // now 6 s after edit — past the 5 s holdDown
		expect(singleFileSyncSpy).toHaveBeenCalledWith('notes/hello.md', expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
	});

	it('resets the holdDown timer on each subsequent edit', async () => {
		const { scheduler, workspace, app } = makeScheduler({ openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		app.vault.emit('modify', { path: 'notes/hello.md' });
		await tick(3000); // 3 s after first edit

		app.vault.emit('modify', { path: 'notes/hello.md' }); // resets timer
		await tick(3000); // only 3 s after second edit — holdDown not yet due
		expect(singleFileSyncSpy).not.toHaveBeenCalled();

		await tick(3000); // 6 s after second edit — past the 5 s holdDown
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
	});

	// -------------------------------------------------------------------------
	// Monitoring (polling)
	// -------------------------------------------------------------------------

	it('enableMonitoring makes the file poll every openFilePoll seconds', async () => {
		const { scheduler, workspace } = makeScheduler({ openFilePoll: 10 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		scheduler.enableMonitoring('notes/hello.md');

		await tick(10_000); // first poll due
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);

		await tick(10_000); // second poll
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(2);
	});

	it('isMonitored returns true after enableMonitoring and false after disableMonitoring', () => {
		const { scheduler, workspace } = makeScheduler();
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });

		expect(scheduler.isMonitored('notes/hello.md')).toBe(false);
		scheduler.enableMonitoring('notes/hello.md');
		expect(scheduler.isMonitored('notes/hello.md')).toBe(true);
		scheduler.disableMonitoring('notes/hello.md');
		expect(scheduler.isMonitored('notes/hello.md')).toBe(false);
	});

	it('toggleMonitoring returns the new state', () => {
		const { scheduler, workspace } = makeScheduler();
		scheduler.start();
		workspace.emit('file-open', { path: 'notes/hello.md' });

		expect(scheduler.toggleMonitoring('notes/hello.md')).toBe(true);
		expect(scheduler.toggleMonitoring('notes/hello.md')).toBe(false);
	});

	it('disableMonitoring stops polling', async () => {
		const { scheduler, workspace } = makeScheduler({ openFilePoll: 10 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000);
		singleFileSyncSpy.mockClear();

		scheduler.enableMonitoring('notes/hello.md');
		await tick(10_000); // one poll
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
		singleFileSyncSpy.mockClear();

		scheduler.disableMonitoring('notes/hello.md');
		await tick(30_000); // 30 s — no more polling
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Poll-beats-holdDown precedence rule
	// -------------------------------------------------------------------------

	it('openFilePoll fires before holdDown and prevents the holdDown from firing', async () => {
		// Setup: openFilePoll=10s, holdDown=5s
		// At T+0: monitoring already scheduled for T+8 (next poll in 8 s from when monitoring was enabled)
		// At T+2: edit → holdDown due at T+7
		// At T+8: poll fires, cancels pending holdDown
		// At T+12: nothing fires (next poll = T+18, no holdDown pending)

		const { scheduler, workspace, app } = makeScheduler({ openFilePoll: 10, openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // T+1: initial sync
		singleFileSyncSpy.mockClear();

		// Enable monitoring at T+1; first poll scheduled at T+11
		scheduler.enableMonitoring('notes/hello.md');

		// Advance to T+3 (before poll, before holdDown)
		await tick(2000);
		// Edit at T+3; holdDown set to T+8
		app.vault.emit('modify', { path: 'notes/hello.md' });
		singleFileSyncSpy.mockClear();

		// Advance to T+9 (before holdDown at T+8 from the edit... wait, holdDown=5s: T+3+5=T+8)
		// Poll is at T+11. holdDown is at T+8. So holdDown fires first at T+8!
		// Advance to T+7 (no sync yet)
		await tick(4000); // now T+7
		expect(singleFileSyncSpy).not.toHaveBeenCalled();

		// T+8: holdDown fires
		await tick(1000); // T+8
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
		singleFileSyncSpy.mockClear();

		// After holdDown fires, nextHoldDownAt=Infinity, nextPollAt = T+8+10 = T+18
		await tick(9000); // T+17: no sync
		expect(singleFileSyncSpy).not.toHaveBeenCalled();

		await tick(2000); // T+19: poll fires
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
	});

	it('a poll while holdDown is pending prevents the holdDown from firing', async () => {
		// openFilePoll=10s; monitoring enabled immediately; poll fires at T+10
		// At T+7: edit → holdDown at T+12
		// At T+10: poll fires, resets nextHoldDownAt=Infinity, nextPollAt=T+20
		// At T+12: nothing fires

		const { scheduler, workspace, app } = makeScheduler({ openFilePoll: 10, openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync at T+1
		singleFileSyncSpy.mockClear();

		scheduler.enableMonitoring('notes/hello.md'); // first poll at T+11

		await tick(6000); // T+7
		app.vault.emit('modify', { path: 'notes/hello.md' }); // holdDown = T+7+5 = T+12

		await tick(4000); // T+11: poll fires (T+11 >= T+11)
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
		singleFileSyncSpy.mockClear();

		await tick(2000); // T+13: holdDown was at T+12 but was cancelled by the poll
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Monitoring cleared when file leaves visible set
	// -------------------------------------------------------------------------

	it('removes file state (and monitoring) when file is no longer visible after layout-change', async () => {
		const { scheduler, workspace } = makeScheduler({ openFilePoll: 10 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		scheduler.enableMonitoring('notes/hello.md');
		expect(scheduler.isMonitored('notes/hello.md')).toBe(true);

		// Simulate the file being hidden (not in any visible leaf)
		(workspace as unknown as { setLeaves: (l: LeafStub[]) => void }).setLeaves([]);
		workspace.emit('layout-change');

		// Monitoring state is gone
		expect(scheduler.isMonitored('notes/hello.md')).toBe(false);

		await tick(30_000); // no more syncs
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// vault.delete — local file deleted while open in a view
	// -------------------------------------------------------------------------

	it('vault.delete on a tracked file arms the hold-down timer', async () => {
		const { scheduler, workspace, app } = makeScheduler({ openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		app.vault.emit('delete', { path: 'notes/hello.md' });

		await tick(4000); // 4 s — hold-down not yet due
		expect(singleFileSyncSpy).not.toHaveBeenCalled();

		await tick(2000); // 6 s total — past the 5 s hold-down
		expect(singleFileSyncSpy).toHaveBeenCalledWith(
			'notes/hello.md',
			expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
		);
	});

	it('vault.delete on an untracked file does not schedule any sync', async () => {
		const { scheduler, app } = makeScheduler({ openFileChangeHoldDown: 5 });
		scheduler.start();

		// No file-open — file is not tracked.
		app.vault.emit('delete', { path: 'notes/hello.md' });

		await tick(30_000);
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	it('vault.delete disables monitoring so no further polls fire after the hold-down', async () => {
		const { scheduler, workspace, app } = makeScheduler({ openFilePoll: 10, openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		scheduler.enableMonitoring('notes/hello.md');
		app.vault.emit('delete', { path: 'notes/hello.md' });

		// Hold-down fires once (the deletion propagation sync).
		await tick(6000);
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
		singleFileSyncSpy.mockClear();

		// No further polls — monitoring was disabled by the delete handler.
		await tick(60_000);
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	it('entry is preserved after layout-change when delete hold-down is still pending', async () => {
		const { scheduler, workspace, app } = makeScheduler({ openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		app.vault.emit('delete', { path: 'notes/hello.md' });

		// Layout-change fires before the hold-down expires (file view closed).
		(workspace as unknown as { setLeaves: (l: LeafStub[]) => void }).setLeaves([]);
		workspace.emit('layout-change');

		// Hold-down must still fire even though the file is no longer visible.
		await tick(6000);
		expect(singleFileSyncSpy).toHaveBeenCalledTimes(1);
	});

	it('layout-change removes the entry once the delete hold-down has fired', async () => {
		const { scheduler, workspace, app } = makeScheduler({ openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000);
		singleFileSyncSpy.mockClear();

		app.vault.emit('delete', { path: 'notes/hello.md' });

		// Let the hold-down fire.
		await tick(6000);
		singleFileSyncSpy.mockClear();

		// Now the entry has both timers at Infinity; a layout-change should clean it up.
		(workspace as unknown as { setLeaves: (l: LeafStub[]) => void }).setLeaves([]);
		workspace.emit('layout-change');

		// No further syncs ever.
		await tick(60_000);
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// destroy
	// -------------------------------------------------------------------------

	it('destroy clears all file state so no further syncs fire', async () => {
		const { scheduler, workspace } = makeScheduler();
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		scheduler.destroy();

		await tick(60_000);
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Pause — sharing-paused state comes from DeferralManager via isSharingPaused
	// -------------------------------------------------------------------------

	it('suppresses all syncs while isSharingPaused returns true', async () => {
		const { scheduler, workspace, app, bulkSyncRunSpy } = makeScheduler(
			{ openFilePoll: 10 },
			() => true,
		);
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		app.vault.emit('modify', { path: 'notes/hello.md' });
		scheduler.enableMonitoring('notes/hello.md');

		await tick(60_000);
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
		expect(bulkSyncRunSpy).not.toHaveBeenCalled();
	});

	it('resumes single-file and bulk sync once isSharingPaused returns false', async () => {
		let paused = true;
		const { scheduler, workspace, bulkSyncRunSpy } = makeScheduler({}, () => paused);
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(2000);
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
		expect(bulkSyncRunSpy).not.toHaveBeenCalled();

		paused = false; // simulate DeferralManager.setPaused(false)
		await tick(1000);
		expect(singleFileSyncSpy).toHaveBeenCalledWith(
			'notes/hello.md', expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
		);
		expect(bulkSyncRunSpy).toHaveBeenCalledTimes(1);
	});

	it('runs a bulk pass immediately on resume even when the poll interval has not elapsed', async () => {
		// Regression: with a long bulkSyncPoll, resuming used to wait for the
		// next scheduled poll, so Approved actions sat unexecuted for up to an
		// hour after the user resumed. The resume edge must force a pass.
		let paused = false;
		const { scheduler, bulkSyncRunSpy } = makeScheduler({ bulkSyncPoll: 3600 }, () => paused);
		scheduler.start();

		await tick(1000); // initial bulk pass; next poll now ~1 h out
		expect(bulkSyncRunSpy).toHaveBeenCalledTimes(1);

		paused = true;
		await tick(60_000); // a minute passes while paused — no pass
		expect(bulkSyncRunSpy).toHaveBeenCalledTimes(1);

		paused = false; // resume well before the 1 h poll would be due
		await tick(1000);
		expect(bulkSyncRunSpy).toHaveBeenCalledTimes(2);
	});

	// -------------------------------------------------------------------------
	// Deferred path — isDeferredPath skips single-file sync for that path
	// -------------------------------------------------------------------------

	it('skips single-file sync for a deferred path even when sharing is not paused', async () => {
		// 'deferred.md' is deferred; 'normal.md' is not.
		const { scheduler, workspace } = makeScheduler(
			{ openFileChangeHoldDown: 5 },
			() => false,
			path => path === 'deferred.md',
		);
		scheduler.start();

		workspace.emit('file-open', { path: 'deferred.md' });
		workspace.emit('file-open', { path: 'normal.md' });

		await tick(1000); // initial tick — both files are due

		const syncedPaths = (singleFileSyncSpy.mock.calls as string[][]).map(c => c[0]);
		expect(syncedPaths).not.toContain('deferred.md');
		expect(syncedPaths).toContain('normal.md');
	});

	// -------------------------------------------------------------------------
	// Bulk sync
	// -------------------------------------------------------------------------

	it('triggers bulk sync immediately on first tick', async () => {
		const { scheduler, bulkSyncRunSpy } = makeScheduler();
		scheduler.start();

		await tick(1000);
		expect(bulkSyncRunSpy).toHaveBeenCalledTimes(1);
	});

	it('triggerBulkSync causes a second bulk pass on next tick', async () => {
		const { scheduler, bulkSyncRunSpy } = makeScheduler({ bulkSyncPoll: 3600 });
		scheduler.start();

		await tick(1000); // initial bulk
		scheduler.triggerBulkSync();
		await tick(1000);
		expect(bulkSyncRunSpy).toHaveBeenCalledTimes(2);
	});

	// -------------------------------------------------------------------------
	// clearHoldDown
	// -------------------------------------------------------------------------

	it('clearHoldDown cancels a pending hold-down so no sync fires', async () => {
		const { scheduler, workspace, app } = makeScheduler({ openFileChangeHoldDown: 5 });
		scheduler.start();

		workspace.emit('file-open', { path: 'notes/hello.md' });
		await tick(1000); // initial sync
		singleFileSyncSpy.mockClear();

		app.vault.emit('modify', { path: 'notes/hello.md' });
		// Clear the hold-down before it expires
		scheduler.clearHoldDown('notes/hello.md');

		await tick(10_000); // well past the 5 s hold-down
		expect(singleFileSyncSpy).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// Background tab filtering
	// -------------------------------------------------------------------------

	it('does not track a file in a background tab during layout-change', async () => {
		const { scheduler, workspace } = makeScheduler({ openFilePoll: 10 });
		scheduler.start();

		// Set up: active leaf and a background leaf in the same tab group.
		const activeLeaf = { view: { file: { path: 'notes/active.md' } }, parent: null as unknown };
		const bgLeaf = { view: { file: { path: 'notes/background.md' } }, parent: null as unknown };
		// Both leaves share a tab group where activeLeaf is the active one.
		const tabGroup = { activeLeaf };
		activeLeaf.parent = tabGroup;
		bgLeaf.parent = tabGroup;

		(workspace as unknown as { setLeaves: (l: LeafStub[]) => void }).setLeaves([activeLeaf as LeafStub, bgLeaf as LeafStub]);
		workspace.emit('layout-change');

		await tick(1000); // initial sync for visible file
		// Active file should sync; background file should not.
		const syncedPaths = (singleFileSyncSpy.mock.calls as string[][]).map(c => c[0]);
		expect(syncedPaths).toContain('notes/active.md');
		expect(syncedPaths).not.toContain('notes/background.md');

		expect(scheduler.isMonitored('notes/background.md')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Newly visible files via layout-change
	// -------------------------------------------------------------------------

	it('adds and syncs a newly visible file when layout-change fires', async () => {
		const { scheduler, workspace } = makeScheduler();
		scheduler.start();

		// No file-open — file not tracked yet.
		expect(scheduler.isMonitored('notes/new.md')).toBe(false);

		(workspace as unknown as { setLeaves: (l: LeafStub[]) => void }).setLeaves([
			{ view: { file: { path: 'notes/new.md' } } },
		]);
		workspace.emit('layout-change');

		await tick(1000); // initial sync
		const syncedPaths = (singleFileSyncSpy.mock.calls as string[][]).map(c => c[0]);
		expect(syncedPaths).toContain('notes/new.md');
	});
});
