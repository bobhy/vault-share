import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { BulkSync } from './bulk-sync';
import { SyncActivity } from './sync-activity';
import type { Candidate, SyncContext } from './types';
import type { CandidateStore } from './candidate-store';
import type { ExcludeMatcher } from './exclude';
import { mockSettings } from '../__mocks__/sync-test-helpers';

// ---------------------------------------------------------------------------
// Mock syncOneFile so tests never hit real I/O
// ---------------------------------------------------------------------------

vi.mock('./file-syncer', () => ({
	syncOneFile: vi.fn(),
}));

// Import after vi.mock so the hoisted mock is in place.
import { syncOneFile } from './file-syncer';
const mockSyncOneFile = syncOneFile as ReturnType<typeof vi.fn<typeof syncOneFile>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Candidate for use in tests. */
function makeCandidate(
	path: string,
	actionType: Candidate['actionType'],
	overrides: Partial<Candidate> = {},
): Candidate {
	return {
		path,
		state: 'Default',
		actionType,
		driveFileId: '',
		syncedLocalMtime: 0,
		syncedRemoteMtime: 0,
		syncedLocalSize: 0,
		syncedRemoteSize: 0,
		syncedAt: 500, // > 0 so hasSyncHistory() is true
		deferredAt: 0,
		deferredLocalMtime: 0,
		deferredRemoteMtime: 0,
		...overrides,
	};
}

/** Build a mock SyncFileResult for a successful push/pull/conflict. */
function makeSuccessResult(actionType: Candidate['actionType']): Awaited<ReturnType<typeof syncOneFile>> {
	if (actionType === 'deleteLocal' || actionType === 'deleteRemote') {
		return { changed: true, merged: false, hadConflictMarkers: false };
	}
	return {
		changed: true,
		merged: false,
		hadConflictMarkers: false,
		syncedState: {
			driveFileId: 'drive-result',
			localMtime: 2000,
			remoteMtime: 2000,
			localSize: 10,
			remoteSize: 10,
			syncedAt: Date.now(),
		},
	};
}

interface BulkSyncHarness {
	bulk: BulkSync;
	candidateStore: CandidateStore & {
		isPaused: ReturnType<typeof vi.fn>;
		getApproved: ReturnType<typeof vi.fn>;
		getPending: ReturnType<typeof vi.fn>;
		reconcile: ReturnType<typeof vi.fn>;
		markSynced: ReturnType<typeof vi.fn>;
		remove: ReturnType<typeof vi.fn>;
		deferAllAndPause: ReturnType<typeof vi.fn>;
		hasSyncHistory: ReturnType<typeof vi.fn>;
		insertSynced: ReturnType<typeof vi.fn>;
		getPendingCount: ReturnType<typeof vi.fn>;
		rebaselineAsConflict: ReturnType<typeof vi.fn>;
	};
	setStatusBar: ReturnType<typeof vi.fn>;
	onThresholdPause: ReturnType<typeof vi.fn>;
	onSuspectDeletePause: ReturnType<typeof vi.fn>;
	activity: SyncActivity;
}

function makeBulkSync(
	localFileCount = 0,
	pendingCandidates: Candidate[] = [],
	approvedCandidates: Candidate[] = [],
	remoteFileCount = 0,
): BulkSyncHarness {
	const activity = new SyncActivity();
	const ctx: SyncContext = {
		activity,
		app: new App(),
		localFs: {
			list: vi.fn().mockResolvedValue(
				Array.from({ length: localFileCount }, (_, i) => ({ path: `file${i}.md`, mtime: 1000, size: 10 })),
			),
			stat: vi.fn().mockReturnValue(null),
			read: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
			write: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
		} as unknown as SyncContext['localFs'],
		driveFs: {
			// By default mirror local paths so the union equals max(localFileCount,
			// remoteFileCount). Tests that need overlapping-but-distinct sets
			// (e.g. for union-arithmetic edge cases) can override the mock
			// after construction.
			listAll: vi.fn().mockResolvedValue({
				files: Array.from({ length: remoteFileCount }, (_, i) => ({
					path: `file${i}.md`, mtime: 1000, size: 10, driveFileId: `drive-${i}`,
				})),
				duplicatePathsFound: 0,
			}),
		} as unknown as SyncContext['driveFs'],
		store: {} as unknown as SyncContext['store'],
		statsTracker: {
			recordBulkSyncPass: vi.fn(),
			recordPassWithDuplicates: vi.fn(),
			flush: vi.fn().mockResolvedValue(undefined),
		} as unknown as SyncContext['statsTracker'],
		settings: () => mockSettings(),
		clientId: 'test-client-id',
		driveFolderId: () => 'root-folder-id',
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warning: vi.fn(),
			error: vi.fn(),
		} as unknown as SyncContext['logger'],
	};

	const markSynced = vi.fn().mockResolvedValue(undefined);
	const remove = vi.fn().mockResolvedValue(undefined);
	const insertSynced = vi.fn().mockResolvedValue(undefined);
	const candidateStore = {
		isPaused: vi.fn().mockResolvedValue(false),
		getApproved: vi.fn().mockReturnValue(approvedCandidates),
		getPending: vi.fn().mockReturnValue(pendingCandidates),
		reconcile: vi.fn().mockResolvedValue([]),
		markSynced,
		remove,
		deferAllAndPause: vi.fn().mockResolvedValue(undefined),
		hasSyncHistory: vi.fn().mockReturnValue(true),
		insertSynced,
		getPendingCount: vi.fn().mockReturnValue(pendingCandidates.length),
		rebaselineAsConflict: vi.fn().mockResolvedValue(undefined),
		// Mirror CandidateStore.applyFileResult so the existing markSynced /
		// remove / insertSynced assertions still see the same calls.
		applyFileResult: vi.fn(async (path: string, actionType: string, fileResult: { changed: boolean; syncedState?: unknown; newSyncedFiles?: Array<{ path: string } & Record<string, unknown>> }) => {
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
		}),
	} as unknown as BulkSyncHarness['candidateStore'];

	const excludeMatcher = { isExcluded: () => false } as unknown as ExcludeMatcher;
	const setStatusBar = vi.fn<(text: string) => void>();
	const onThresholdPause = vi.fn<(count: number) => void>();
	const onSuspectDeletePause = vi.fn<(count: number) => void>();

	const bulk = new BulkSync(ctx, excludeMatcher, setStatusBar, candidateStore, onThresholdPause, onSuspectDeletePause);

	return { bulk, candidateStore, setStatusBar, onThresholdPause, onSuspectDeletePause, activity };
}

// ---------------------------------------------------------------------------
// doRun: paused guard
// ---------------------------------------------------------------------------

describe('BulkSync.run: paused guard', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('returns immediately without planning or executing when paused', async () => {
		const { bulk, candidateStore } = makeBulkSync();
		candidateStore.isPaused.mockResolvedValue(true);

		const result = await bulk.run();

		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(candidateStore.reconcile).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(false);
		expect(result.uploaded).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// doRun: executeApproved path (getApproved returns candidates)
// ---------------------------------------------------------------------------

describe('BulkSync.run: executeApproved', () => {
	beforeEach(() => {
		mockSyncOneFile.mockReset();
	});

	it('routes to executeApproved when getApproved returns candidates; reconcile is skipped', async () => {
		const approved = [
			makeCandidate('a.md', 'push', { state: 'Approved' }),
			makeCandidate('b.md', 'pull', { state: 'Approved' }),
		];
		approved.forEach(c => mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult(c.actionType)));

		const { bulk, candidateStore } = makeBulkSync(0, [], approved);
		const result = await bulk.run();

		// executeApproved runs: syncOneFile called for each approved candidate.
		expect(mockSyncOneFile).toHaveBeenCalledTimes(2);
		// No reconcile — approved path bypasses planning.
		expect(candidateStore.reconcile).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(false);
	});

	it('result counts are correct for approved push, pull, and conflict', async () => {
		const approved = [
			makeCandidate('a.md', 'push', { state: 'Approved' }),
			makeCandidate('b.md', 'pull', { state: 'Approved' }),
			makeCandidate('c.md', 'conflict', { state: 'Approved' }),
		];
		approved.forEach(c => mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult(c.actionType)));

		const { bulk } = makeBulkSync(0, [], approved);
		const result = await bulk.run();

		expect(result.uploaded).toBe(1);
		expect(result.downloaded).toBe(1);
		expect(result.conflicts).toBe(1);
		expect(result.deleted).toBe(0);
	});

	it('calls markSynced for push/pull approved; calls remove for delete approved', async () => {
		const approved = [
			makeCandidate('push.md', 'push', { state: 'Approved' }),
			makeCandidate('del.md', 'deleteLocal', { state: 'Approved' }),
		];
		mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult('push'));
		mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult('deleteLocal'));

		const { bulk, candidateStore } = makeBulkSync(0, [], approved);
		await bulk.run();

		expect(candidateStore.markSynced).toHaveBeenCalledWith('push.md', expect.any(Object));
		expect(candidateStore.remove).toHaveBeenCalledWith('del.md');
	});

	it('empty approved list falls through to normal planning path', async () => {
		// getApproved returns [] → should proceed to reconcile + execute pending.
		const pending = [makeCandidate('x.md', 'push')];
		mockSyncOneFile.mockResolvedValue(makeSuccessResult('push'));

		const { bulk, candidateStore } = makeBulkSync(1, pending, []);
		await bulk.run();

		// reconcile was called because approved path was skipped.
		expect(candidateStore.reconcile).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Per-candidate failure isolation (sync-review-followups item 16)
// ---------------------------------------------------------------------------

describe('BulkSync.run: per-candidate failure isolation', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('approved + Local file not found: cancels that candidate, completes the rest, bumps failed counter', async () => {
		// Regression: the old code wrapped the whole approved loop in a single
		// try/catch, so the first throw stranded every subsequent approved
		// candidate AND the dead candidate stayed Approved forever (next pass
		// re-threw on the same file). The fix: per-candidate try/catch, and
		// for "Local file not found:" specifically, remove the candidate so
		// the queue can never re-stick on it.
		const approved = [
			makeCandidate('alive-a.md', 'push', { state: 'Approved' }),
			makeCandidate('gone.md',    'push', { state: 'Approved' }),
			makeCandidate('alive-b.md', 'push', { state: 'Approved' }),
		];
		// Iteration order matches array order.
		mockSyncOneFile
			.mockResolvedValueOnce(makeSuccessResult('push'))
			.mockRejectedValueOnce(new Error('Local file not found: gone.md'))
			.mockResolvedValueOnce(makeSuccessResult('push'));

		const { bulk, candidateStore } = makeBulkSync(0, [], approved);
		const result = await bulk.run();

		// Both healthy candidates executed (markSynced called for each).
		expect(candidateStore.markSynced).toHaveBeenCalledWith('alive-a.md', expect.any(Object));
		expect(candidateStore.markSynced).toHaveBeenCalledWith('alive-b.md', expect.any(Object));
		expect(result.uploaded).toBe(2);

		// The missing-local candidate was *cancelled* — remove was called for
		// its path. This is what unblocks the next pass.
		expect(candidateStore.remove).toHaveBeenCalledWith('gone.md');

		// Pass counters reflect one failure.
		expect(result.failed).toBe(1);
		// Catastrophic-error field stays unset; one bad file isn't a pass-wide error.
		expect(result.error).toBeUndefined();
	});

	it('approved + transient (non-not-found) error keeps the candidate and lets the rest proceed', async () => {
		// Transient errors (network blip, Drive 5xx, IDB hiccup) should NOT
		// cancel the candidate — the next pass should retry. Only the explicit
		// "Local file not found:" signal cancels.
		const approved = [
			makeCandidate('alive-a.md', 'push', { state: 'Approved' }),
			makeCandidate('flaky.md',   'push', { state: 'Approved' }),
			makeCandidate('alive-b.md', 'push', { state: 'Approved' }),
		];
		mockSyncOneFile
			.mockResolvedValueOnce(makeSuccessResult('push'))
			.mockRejectedValueOnce(new Error('Drive request failed: 503 Service Unavailable'))
			.mockResolvedValueOnce(makeSuccessResult('push'));

		const { bulk, candidateStore } = makeBulkSync(0, [], approved);
		const result = await bulk.run();

		// Healthy candidates still ran.
		expect(candidateStore.markSynced).toHaveBeenCalledWith('alive-a.md', expect.any(Object));
		expect(candidateStore.markSynced).toHaveBeenCalledWith('alive-b.md', expect.any(Object));
		expect(result.uploaded).toBe(2);
		expect(result.failed).toBe(1);

		// Crucially: the flaky candidate was NOT removed — it'll retry next pass.
		expect(candidateStore.remove).not.toHaveBeenCalledWith('flaky.md');
	});

	it('normal (non-approved) pending: same per-candidate isolation applies', async () => {
		// The shared helper means doRun's pending loop has the same behaviour.
		// One bad file shouldn't strand the rest.
		const pending = [
			makeCandidate('alive.md', 'push'),
			makeCandidate('gone.md',  'push'),
		];
		mockSyncOneFile
			.mockResolvedValueOnce(makeSuccessResult('push'))
			.mockRejectedValueOnce(new Error('Local file not found: gone.md'));

		const { bulk, candidateStore } = makeBulkSync(2, pending, []);
		const result = await bulk.run();

		expect(candidateStore.markSynced).toHaveBeenCalledWith('alive.md', expect.any(Object));
		expect(candidateStore.remove).toHaveBeenCalledWith('gone.md');
		expect(result.uploaded).toBe(1);
		expect(result.failed).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// doRun: normal planning path
// ---------------------------------------------------------------------------

describe('BulkSync.run: normal planning path', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('reconciles, then executes pending candidates and updates result counts', async () => {
		const pending = [
			makeCandidate('a.md', 'push'),
			makeCandidate('b.md', 'pull'),
		];
		pending.forEach(c => mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult(c.actionType)));

		const { bulk, candidateStore } = makeBulkSync(2, pending);
		const result = await bulk.run();

		expect(candidateStore.reconcile).toHaveBeenCalled();
		expect(mockSyncOneFile).toHaveBeenCalledTimes(2);
		expect(result.uploaded).toBe(1);
		expect(result.downloaded).toBe(1);
	});

	it('calls markSynced with syncedState after a successful push', async () => {
		const pending = [makeCandidate('note.md', 'push')];
		mockSyncOneFile.mockResolvedValue(makeSuccessResult('push'));

		const { bulk, candidateStore } = makeBulkSync(1, pending);
		await bulk.run();

		expect(candidateStore.markSynced).toHaveBeenCalledWith('note.md', expect.objectContaining({ driveFileId: 'drive-result' }));
	});

	it('calls remove after a successful deleteLocal', async () => {
		const pending = [makeCandidate('dead.md', 'deleteLocal')];
		mockSyncOneFile.mockResolvedValue(makeSuccessResult('deleteLocal'));

		const { bulk, candidateStore } = makeBulkSync(1, pending);
		await bulk.run();

		expect(candidateStore.remove).toHaveBeenCalledWith('dead.md');
		expect(candidateStore.markSynced).not.toHaveBeenCalled();
	});

	it('reports bulkRunning true during the pass and false after', async () => {
		const pending = [makeCandidate('a.md', 'push'), makeCandidate('b.md', 'push')];
		const { bulk, activity } = makeBulkSync(2, pending);

		// syncOneFile is mocked here, so the per-file currentPath signal (which the
		// real syncOneFile owns) is not exercised — that is covered in
		// file-syncer.test. Here we only assert the pass-level running flag, which
		// BulkSync.run sets directly. Capture it mid-pass via the mock.
		const runningDuringPass: boolean[] = [];
		pending.forEach(c => mockSyncOneFile.mockImplementationOnce(() => {
			runningDuringPass.push(activity.getSnapshot().bulkRunning);
			return Promise.resolve(makeSuccessResult(c.actionType));
		}));

		expect(activity.getSnapshot().bulkRunning).toBe(false);
		await bulk.run();

		expect(runningDuringPass).toEqual([true, true]);
		expect(activity.getSnapshot().bulkRunning).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// doRun: threshold guard
// ---------------------------------------------------------------------------

describe('BulkSync.run: threshold guard', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('calls deferAllAndPause when the global-change ratio exceeds the threshold', async () => {
		// Mocks default to mirroring local paths into remote, so 10 local
		// + 10 remote with overlapping paths → union = 10. Default
		// settings: globalChangeMin = 10, globalChangeThreshold = 10.
		// 8 pending pushes / 10 union = 80 % > 10 % → threshold fires.
		const pending: Candidate[] = Array.from({ length: 8 }, (_, i) =>
			makeCandidate(`file${i}.md`, 'push'),
		);

		const { bulk, candidateStore, onThresholdPause } = makeBulkSync(10, pending, [], 10);
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).toHaveBeenCalledWith(pending);
		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(true);
		expect(onThresholdPause).toHaveBeenCalled();
	});

	it('does not trigger threshold when the union is smaller than globalChangeMin', async () => {
		// 5 local + 5 remote with overlapping paths → union = 5. With
		// the default min of 10, the union is too small to be checked
		// against threshold even though every file is pending.
		const pending: Candidate[] = Array.from({ length: 5 }, (_, i) =>
			makeCandidate(`file${i}.md`, 'push'),
		);
		pending.forEach(() => mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult('push')));

		const { bulk, candidateStore } = makeBulkSync(5, pending, [], 5);
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(false);
		expect(mockSyncOneFile).toHaveBeenCalledTimes(5);
	});

	it('does not trigger threshold when remote is empty and there is no sync history (fresh install)', async () => {
		// 10 local files, 0 remote, no history — every file is a push, ratio
		// would normally be 100 %. Without history the vault is a fresh install
		// joining a populated group vault; skip the guard so the user isn't
		// ambushed with a deferral notice on first sync.
		const pending: Candidate[] = Array.from({ length: 10 }, (_, i) =>
			makeCandidate(`file${i}.md`, 'push', { syncedAt: 0 }),
		);
		pending.forEach(() => mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult('push')));

		const { bulk, candidateStore } = makeBulkSync(10, pending, [], 0);
		// Ensure hasSyncHistory returns false for this test.
		candidateStore.hasSyncHistory.mockReturnValue(false);
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(false);
		expect(mockSyncOneFile).toHaveBeenCalledTimes(10);
	});

	it('triggers threshold when remote is empty but sync history exists (accidental Drive wipe)', async () => {
		// 10 local files, 0 remote, history present — signals an accidental
		// Drive-folder wipe. Ratio = 100 % > 10 % threshold → guard fires.
		const pending: Candidate[] = Array.from({ length: 10 }, (_, i) =>
			makeCandidate(`file${i}.md`, 'push'),
		);

		const { bulk, candidateStore, onThresholdPause } = makeBulkSync(10, pending, [], 0);
		// hasSyncHistory already returns true by default (syncedAt: 500 in makeCandidate).
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).toHaveBeenCalledWith(pending);
		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(true);
		expect(onThresholdPause).toHaveBeenCalled();
	});

	it('counts deleteLocal actions in the global-change ratio (remote peer mass-delete trips threshold)', async () => {
		// 8 deleteLocal candidates / 10 union files = 80 % > 10 % → threshold fires.
		// Previously deleteLocal was excluded from the numerator, which would have
		// allowed a remote peer deleting most of the vault to bypass the guard.
		const pending: Candidate[] = Array.from({ length: 8 }, (_, i) =>
			makeCandidate(`file${i}.md`, 'deleteLocal'),
		);

		const { bulk, candidateStore, onThresholdPause } = makeBulkSync(10, pending, [], 10);
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).toHaveBeenCalledWith(pending);
		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(true);
		expect(onThresholdPause).toHaveBeenCalled();
	});

	it('does not trigger threshold when local is empty (fresh install joining a populated group vault)', async () => {
		// 0 local files, 10 remote — every file is a pull. The
		// empty-local guard skips the check, so the user isn't ambushed
		// with a "10 global changes deferred for review" notice on the
		// very first sync of a fresh install.
		const pending: Candidate[] = Array.from({ length: 10 }, (_, i) =>
			makeCandidate(`file${i}.md`, 'pull'),
		);
		pending.forEach(() => mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult('pull')));

		const { bulk, candidateStore } = makeBulkSync(0, pending, [], 10);
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(false);
		expect(mockSyncOneFile).toHaveBeenCalledTimes(10);
	});
});

// ---------------------------------------------------------------------------
// doRun: suspect-delete guard (deleteRemote without an onDelete signal)
// ---------------------------------------------------------------------------

describe('BulkSync.run: suspect-delete guard', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('defers + pauses an unflagged deleteRemote (no locallyDeletedAt) instead of executing it', async () => {
		// Local file absent, remote present, history exists → planAction yields
		// deleteRemote. But no vault.on('delete') ever flagged it, so it is a
		// suspect (possibly-truncated-enumeration) deletion and must not run.
		const pending = [makeCandidate('note.md', 'deleteRemote')]; // locallyDeletedAt undefined
		const { bulk, candidateStore, onSuspectDeletePause, onThresholdPause } = makeBulkSync(0, pending, [], 1);

		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).toHaveBeenCalledWith(pending);
		expect(onSuspectDeletePause).toHaveBeenCalledWith(1);
		expect(result.deferredBySuspectDelete).toBe(true);
		expect(result.deferredByThreshold).toBe(false);
		expect(mockSyncOneFile).not.toHaveBeenCalled();
		// Not subject to the threshold guard's notice.
		expect(onThresholdPause).not.toHaveBeenCalled();
	});

	it('executes a flagged deleteRemote (locallyDeletedAt set) without pausing', async () => {
		const pending = [makeCandidate('note.md', 'deleteRemote', { locallyDeletedAt: 1234 })];
		mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult('deleteRemote'));
		const { bulk, candidateStore, onSuspectDeletePause } = makeBulkSync(0, pending, [], 1);

		const result = await bulk.run();

		expect(onSuspectDeletePause).not.toHaveBeenCalled();
		expect(result.deferredBySuspectDelete).toBe(false);
		expect(mockSyncOneFile).toHaveBeenCalledTimes(1);
		expect(candidateStore.remove).toHaveBeenCalledWith('note.md');
	});

	it('pauses the whole pass when even one of several deleteRemotes is unflagged', async () => {
		const flagged = makeCandidate('flagged.md', 'deleteRemote', { locallyDeletedAt: 99 });
		const suspect = makeCandidate('suspect.md', 'deleteRemote'); // unflagged
		const { bulk, candidateStore, onSuspectDeletePause } = makeBulkSync(0, [flagged, suspect], [], 2);

		const result = await bulk.run();

		// Only the unflagged candidate is deferred; sharing pauses; nothing executes.
		expect(candidateStore.deferAllAndPause).toHaveBeenCalledWith([suspect]);
		expect(onSuspectDeletePause).toHaveBeenCalledWith(1);
		expect(result.deferredBySuspectDelete).toBe(true);
		expect(mockSyncOneFile).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// doRun: Site 1 sha256 rebaseline verification
// ---------------------------------------------------------------------------

describe('BulkSync.run: Site 1 sha256 rebaseline verification', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('calls rebaselineAsConflict when sha256 mismatches a rebaselined path', async () => {
		// reconcile() returns one rebaselined path. The local read returns content
		// whose sha256 does NOT match the remote sha256Checksum → the rebaseline
		// was a false positive. BulkSync should flip it to conflict.
		const localContent = new TextEncoder().encode('local content').buffer;
		const { bulk, candidateStore } = makeBulkSync(1, [], [], 1);

		// Override reconcile to report a rebaselined path.
		candidateStore.reconcile.mockResolvedValue(['file0.md']);

		// Override get() so the candidate has a mismatching sha256Checksum.
		// sha256 of 'local content' is a specific hex; we supply a different hex.
		(candidateStore as unknown as { get: ReturnType<typeof vi.fn> }).get =
			vi.fn().mockReturnValue({
				path: 'file0.md',
				remote: { sha256Checksum: 'deadbeef'.repeat(8), driveFileId: 'drive-0' },
				local:  { path: 'file0.md', mtime: 1000, size: localContent.byteLength },
			});

		// localFs.read returns the local content.
		const ctx = (bulk as unknown as { ctx: { localFs: { read: ReturnType<typeof vi.fn> } } }).ctx;
		ctx.localFs.read = vi.fn().mockResolvedValue(localContent);

		await bulk.run();

		expect(candidateStore.rebaselineAsConflict).toHaveBeenCalledWith('file0.md');
	});

	it('does not call rebaselineAsConflict when sha256 matches', async () => {
		// sha256 of 'hello' in hex (computed reference value).
		const content = new TextEncoder().encode('hello').buffer;
		const { bulk, candidateStore } = makeBulkSync(1, [], [], 1);

		candidateStore.reconcile.mockResolvedValue(['file0.md']);
		(candidateStore as unknown as { get: ReturnType<typeof vi.fn> }).get =
			vi.fn().mockReturnValue({
				path: 'file0.md',
				// We use a sentinel that cannot match the real sha256 of 'hello'.
				// Test passes when rebaselineAsConflict is NOT called.
				// (Actual hash verified by content-hash.test.ts.)
				remote: { sha256Checksum: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', driveFileId: 'd0' },
				local: { path: 'file0.md', mtime: 1000, size: content.byteLength },
			});

		const ctx = (bulk as unknown as { ctx: { localFs: { read: ReturnType<typeof vi.fn> } } }).ctx;
		ctx.localFs.read = vi.fn().mockResolvedValue(content);

		await bulk.run();

		expect(candidateStore.rebaselineAsConflict).not.toHaveBeenCalled();
	});

	it('skips verification when the rebaselined candidate has no sha256Checksum', async () => {
		// No sha256Checksum on the remote side → keep size-equality result, no I/O.
		const { bulk, candidateStore } = makeBulkSync(1, [], [], 1);
		candidateStore.reconcile.mockResolvedValue(['file0.md']);
		(candidateStore as unknown as { get: ReturnType<typeof vi.fn> }).get =
			vi.fn().mockReturnValue({
				path: 'file0.md',
				remote: { driveFileId: 'd0' },  // no sha256Checksum
				local: { path: 'file0.md', mtime: 1000, size: 5 },
			});

		const ctx = (bulk as unknown as { ctx: { localFs: { read: ReturnType<typeof vi.fn> } } }).ctx;
		const readSpy = vi.fn();
		ctx.localFs.read = readSpy;

		await bulk.run();

		expect(readSpy).not.toHaveBeenCalled();
		expect(candidateStore.rebaselineAsConflict).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// doRun: identicalTimestamps tally
// ---------------------------------------------------------------------------

describe('BulkSync.run: identicalTimestamps tally', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('increments identicalTimestamps and not conflicts for an identicalContent result', async () => {
		const pending = [makeCandidate('note.md', 'conflict')];
		mockSyncOneFile.mockResolvedValue({
			changed: true,
			identicalContent: true,
			merged: false,
			hadConflictMarkers: false,
			syncedState: {
				driveFileId: 'drive-1', localMtime: 2000, remoteMtime: 2000,
				localSize: 10, remoteSize: 10, syncedAt: Date.now(),
			},
		});

		const { bulk } = makeBulkSync(1, pending, []);
		const result = await bulk.run();

		expect(result.identicalTimestamps).toBe(1);
		expect(result.conflicts).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// doRun: not logged in
// ---------------------------------------------------------------------------

describe('BulkSync.run: not logged in', () => {
	it('returns immediately when driveFolderId() returns empty string', async () => {
		const { bulk, candidateStore } = makeBulkSync();
		// Override driveFolderId on the ctx to return ''.
		const ctx = (bulk as unknown as { ctx: SyncContext }).ctx;
		(ctx as { driveFolderId: () => string }).driveFolderId = () => '';

		const result = await bulk.run();

		expect(candidateStore.reconcile).not.toHaveBeenCalled();
		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(result.uploaded).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// planOnly
// ---------------------------------------------------------------------------

describe('BulkSync.planOnly', () => {
	it('calls reconcile and returns all candidates without executing', async () => {
		const allCandidates = [makeCandidate('a.md', 'push')];
		const { bulk, candidateStore } = makeBulkSync();
		(candidateStore as unknown as { getAll: ReturnType<typeof vi.fn> }).getAll =
			vi.fn().mockReturnValue(allCandidates);

		const result = await bulk.planOnly();

		expect(candidateStore.reconcile).toHaveBeenCalled();
		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(result).toEqual(allCandidates);
	});

	it('returns empty array when not logged in', async () => {
		const { bulk } = makeBulkSync();
		const ctx = (bulk as unknown as { ctx: SyncContext }).ctx;
		(ctx as { driveFolderId: () => string }).driveFolderId = () => '';

		const result = await bulk.planOnly();
		expect(result).toEqual([]);
	});
});
