import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { BulkSync } from './bulk-sync';
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
	};
	setStatusBar: ReturnType<typeof vi.fn>;
	onThresholdPause: ReturnType<typeof vi.fn>;
}

function makeBulkSync(
	localFileCount = 0,
	pendingCandidates: Candidate[] = [],
	approvedCandidates: Candidate[] = [],
): BulkSyncHarness {
	const ctx: SyncContext = {
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
			listAll: vi.fn().mockResolvedValue({ files: [], duplicatePathsFound: 0 }),
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
		reconcile: vi.fn().mockResolvedValue(undefined),
		markSynced,
		remove,
		deferAllAndPause: vi.fn().mockResolvedValue(undefined),
		hasSyncHistory: vi.fn().mockReturnValue(true),
		insertSynced,
		getPendingCount: vi.fn().mockReturnValue(pendingCandidates.length),
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

	const bulk = new BulkSync(ctx, excludeMatcher, setStatusBar, candidateStore, onThresholdPause);

	return { bulk, candidateStore, setStatusBar, onThresholdPause };
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
});

// ---------------------------------------------------------------------------
// doRun: threshold guard
// ---------------------------------------------------------------------------

describe('BulkSync.run: threshold guard', () => {
	beforeEach(() => mockSyncOneFile.mockReset());

	it('calls deferAllAndPause and skips execution when action ratio exceeds threshold', async () => {
		// Default settings: fileModificationConfirmationMin=10, threshold=50%.
		// 10 local files, 8 pending (non-deleteLocal) = 80% > 50% → threshold fires.
		const pending: Candidate[] = Array.from({ length: 8 }, (_, i) =>
			makeCandidate(`file${i}.md`, 'push'),
		);

		const { bulk, candidateStore, onThresholdPause } = makeBulkSync(10, pending);
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).toHaveBeenCalledWith(pending);
		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(true);
		expect(onThresholdPause).toHaveBeenCalled();
	});

	it('does not trigger threshold when vault has fewer than fileModificationConfirmationMin files', async () => {
		// 5 local files < fileModificationConfirmationMin (10) → threshold guard disabled.
		const pending: Candidate[] = Array.from({ length: 5 }, (_, i) =>
			makeCandidate(`f${i}.md`, 'push'),
		);
		pending.forEach(() => mockSyncOneFile.mockResolvedValueOnce(makeSuccessResult('push')));

		const { bulk, candidateStore } = makeBulkSync(5, pending);
		const result = await bulk.run();

		expect(candidateStore.deferAllAndPause).not.toHaveBeenCalled();
		expect(result.deferredByThreshold).toBe(false);
		expect(mockSyncOneFile).toHaveBeenCalledTimes(5);
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
