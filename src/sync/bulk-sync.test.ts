import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { BulkSync } from './bulk-sync';
import type { SyncAction, SyncContext, ViewCandidate } from './types';
import type { ExcludeMatcher } from './exclude';
import type { DeferralManager } from './deferral-manager';
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

function makeAction(path: string, localMtime = 1000, overrides: Partial<SyncAction> = {}): SyncAction {
	return {
		type: 'push',
		path,
		local: { path, mtime: localMtime, size: 100 },
		...overrides,
	};
}

interface BulkSyncHarness {
	bulk: BulkSync;
	setStatusBar: ReturnType<typeof vi.fn>;
	onPlanChanged: ReturnType<typeof vi.fn>;
	onThresholdPause: ReturnType<typeof vi.fn>;
	statMock: ReturnType<typeof vi.fn>;
}

function makeBulkSync(): BulkSyncHarness {
	const statMock = vi.fn().mockReturnValue(null);

	const ctx: SyncContext = {
		app: new App(),
		localFs: {
			list: vi.fn().mockResolvedValue([]),
			stat: statMock,
			read: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
			write: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
		} as unknown as SyncContext['localFs'],
		driveFs: {
			listAll: vi.fn().mockResolvedValue({ files: [], duplicatePathsFound: 0 }),
		} as unknown as SyncContext['driveFs'],
		store: {
			getAllRecords: vi.fn().mockResolvedValue([]),
		} as unknown as SyncContext['store'],
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

	const excludeMatcher = { isExcluded: () => false } as unknown as ExcludeMatcher;

	const deferralManager = {
		isPaused: vi.fn().mockResolvedValue(false),
		isPausedSync: vi.fn().mockReturnValue(false),
		reconcile: vi.fn().mockResolvedValue(new Set<string>()),
		deferAllAndPause: vi.fn().mockResolvedValue(undefined),
	} as unknown as DeferralManager;

	const setStatusBar = vi.fn<(text: string) => void>();
	const onPlanChanged = vi.fn<(candidates: ViewCandidate[]) => void>();
	const onThresholdPause = vi.fn<(count: number) => void>();

	const bulk = new BulkSync(
		ctx, excludeMatcher, new App(), setStatusBar, deferralManager, onPlanChanged, onThresholdPause,
	);

	return { bulk, setStatusBar, onPlanChanged, onThresholdPause, statMock };
}

// ---------------------------------------------------------------------------
// executeApproved — via approveForExecution + run()
// ---------------------------------------------------------------------------

describe('executeApproved', () => {
	beforeEach(() => {
		mockSyncOneFile.mockReset();
		mockSyncOneFile.mockResolvedValue({ changed: true, merged: false, hadConflictMarkers: false });
	});

	it('all-valid actions: result counts match action types', async () => {
		const { bulk, statMock } = makeBulkSync();

		const actions: SyncAction[] = [
			makeAction('a.md', 1000, { type: 'push' }),
			makeAction('b.md', 2000, { type: 'pull', local: { path: 'b.md', mtime: 2000, size: 50 } }),
			makeAction('c.md', 3000, { type: 'conflict', local: { path: 'c.md', mtime: 3000, size: 80 } }),
		];

		// Stat returns matching mtimes so nothing is skipped.
		statMock.mockImplementation((path: string) => {
			const a = actions.find(x => x.path === path);
			return a?.local ?? null;
		});

		bulk.approveForExecution(actions);
		const result = await bulk.run();

		expect(result.uploaded).toBe(1);
		expect(result.downloaded).toBe(1);
		expect(result.conflicts).toBe(1);
		expect(result.deleted).toBe(0);
		expect(result.deferredByThreshold).toBe(false);
		expect(mockSyncOneFile).toHaveBeenCalledTimes(3);
	});

	it('stale local file: skipped; fresh files still execute', async () => {
		const { bulk, statMock } = makeBulkSync();

		const stale = makeAction('stale.md', 1000);   // plan-time mtime = 1000
		const fresh = makeAction('fresh.md', 2000);

		// stale.md has changed since planning; fresh.md is still at plan-time mtime.
		statMock.mockImplementation((path: string) => {
			if (path === 'stale.md') return { path, mtime: 9999, size: 100 };  // different
			if (path === 'fresh.md') return { path, mtime: 2000, size: 100 };  // matches
			return null;
		});

		bulk.approveForExecution([stale, fresh]);
		const result = await bulk.run();

		expect(mockSyncOneFile).toHaveBeenCalledTimes(1);
		expect(mockSyncOneFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: 'fresh.md' }),
			expect.anything(),
			true,
		);
		expect(result.uploaded).toBe(1);
	});

	it('empty approved list: no-op, no errors, zero counts', async () => {
		const { bulk } = makeBulkSync();

		bulk.approveForExecution([]);
		const result = await bulk.run();

		expect(mockSyncOneFile).not.toHaveBeenCalled();
		expect(result.uploaded).toBe(0);
		expect(result.downloaded).toBe(0);
		expect(result.deferredByThreshold).toBe(false);
		expect(result.error).toBeUndefined();
	});

	it('pendingApprovedActions consumed on first run; second run goes through normal path', async () => {
		const { bulk, statMock } = makeBulkSync();

		const action = makeAction('x.md', 1000);
		statMock.mockReturnValue({ path: 'x.md', mtime: 1000, size: 100 });

		bulk.approveForExecution([action]);

		// First run: should call executeApproved (syncOneFile called once).
		await bulk.run();
		expect(mockSyncOneFile).toHaveBeenCalledTimes(1);

		mockSyncOneFile.mockClear();

		// Second run: pendingApprovedActions is now null; goes through normal
		// planning path with an empty vault → syncOneFile is NOT called.
		await bulk.run();
		expect(mockSyncOneFile).not.toHaveBeenCalled();
	});
});
