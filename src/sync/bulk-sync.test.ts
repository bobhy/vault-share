import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BulkSync } from './bulk-sync';
import { Logger } from '../logger';
import { mockSettings } from '../__mocks__/sync-test-helpers';
import type { SyncContext } from './types';
import type { ExcludeMatcher } from './exclude';
import type { SyncPreviewResult } from './types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./file-syncer', () => ({
	syncOneFile: vi.fn().mockResolvedValue({ changed: true, merged: false, hadConflictMarkers: false }),
}));

vi.mock('./change-detector', () => ({
	buildMixedEntries: vi.fn().mockReturnValue([]),
}));

vi.mock('./decision-engine', () => ({
	planActions: vi.fn().mockReturnValue([]),
}));

vi.mock('./share-preview', () => ({
	classifyActions: vi.fn().mockReturnValue(emptyPreview()),
}));

import { syncOneFile } from './file-syncer';
import { planActions } from './decision-engine';
import { classifyActions } from './share-preview';

const syncOneFileSpy = syncOneFile as ReturnType<typeof vi.fn>;
const planActionsSpy = planActions as ReturnType<typeof vi.fn>;
const classifyActionsSpy = classifyActions as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyPreview(): SyncPreviewResult {
	return {
		groupNew: 0, groupUpdated: 0, groupDeleted: 0, groupDeletedPaths: [],
		localNew: 0, localUpdated: 0, localDeleted: 0, localDeletedPaths: [],
		contentConflicts: 0, contentConflictPaths: [],
		deleteConflicts: 0, deleteConflictPaths: [],
		textMergeFiles: 0, textMergeFilePaths: [],
		collectedAt: 0,
	};
}

function makeLocalFiles(count: number) {
	return Array.from({ length: count }, (_, i) => ({ path: `file${i}.md`, isDirectory: false, size: 100, mtime: 1000 }));
}

function makeActions(count: number, type = 'push') {
	return Array.from({ length: count }, (_, i) => ({ type, path: `file${i}.md` }));
}

const stubExcludeMatcher = { isExcluded: () => false } as unknown as ExcludeMatcher;

function makeCtx(opts: {
	localFileCount?: number;
	driveFolderId?: string;
	settingsOverrides?: Parameters<typeof mockSettings>[0];
	logger?: Logger;
} = {}): { ctx: SyncContext; logger: Logger; statsTracker: { recordBulkSyncPass: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } } {
	const logger = opts.logger ?? new Logger(() => 'DEBUG', () => 100);
	const statsTracker = {
		recordBulkSyncPass: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
	};
	const ctx = {
		localFs: { list: vi.fn().mockResolvedValue(makeLocalFiles(opts.localFileCount ?? 0)) },
		driveFs: { listAll: vi.fn().mockResolvedValue([]) },
		store: { getAllRecords: vi.fn().mockResolvedValue([]) },
		statsTracker,
		settings: () => mockSettings(opts.settingsOverrides),
		clientId: 'client-1',
		driveFolderId: () => opts.driveFolderId ?? 'folder-id',
		logger,
	} as unknown as SyncContext;
	return { ctx, logger, statsTracker };
}

function makeBulkSync(ctxOpts: Parameters<typeof makeCtx>[0] = {}) {
	const { ctx, logger, statsTracker } = makeCtx(ctxOpts);
	const setStatusBar = vi.fn();
	const bulkSync = new BulkSync(ctx, stubExcludeMatcher, setStatusBar);
	return { bulkSync, ctx, logger, setStatusBar, statsTracker };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BulkSync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		planActionsSpy.mockReturnValue([]);
		classifyActionsSpy.mockReturnValue(emptyPreview());
		syncOneFileSpy.mockResolvedValue({ changed: true, merged: false, hadConflictMarkers: false });
	});

	// ── no Drive folder ──────────────────────────────────────────────────────

	describe('run() skips when no driveFolderId', () => {
		it('returns an empty result without calling syncOneFile', async () => {
			const { bulkSync, statsTracker } = makeBulkSync({ driveFolderId: '' });

			const result = await bulkSync.run();

			expect(result.downloaded).toBe(0);
			expect(result.abortedByUser).toBe(false);
			expect(result.error).toBeUndefined();
			expect(syncOneFileSpy).not.toHaveBeenCalled();
			expect(statsTracker.recordBulkSyncPass).not.toHaveBeenCalled();
		});
	});

	// ── onPlanComplete ───────────────────────────────────────────────────────

	describe('run() — onPlanComplete', () => {
		it('invokes callback with the classified preview', async () => {
			const preview = { ...emptyPreview(), groupNew: 3 };
			classifyActionsSpy.mockReturnValue(preview);

			const { bulkSync } = makeBulkSync({ localFileCount: 5 });
			const onPlanComplete = vi.fn();
			bulkSync.setOnPlanComplete(onPlanComplete);

			await bulkSync.run();

			expect(onPlanComplete).toHaveBeenCalledWith(preview);
		});

		it('invokes callback before any syncOneFile calls', async () => {
			planActionsSpy.mockReturnValue([{ type: 'push', path: 'a.md' }]);

			const { bulkSync } = makeBulkSync({ localFileCount: 1 });
			const onPlanComplete = vi.fn();
			bulkSync.setOnPlanComplete(onPlanComplete);

			await bulkSync.run();

			expect(onPlanComplete).toHaveBeenCalledBefore(syncOneFileSpy);
		});
	});

	// ── too-many-changes guard ────────────────────────────────────────────────

	describe('run() — too-many-changes guard', () => {
		it('fires onTooManyChanges, sets abortedByUser, skips all actions', async () => {
			// 10 files, 7 actions → 70% > 50% threshold
			planActionsSpy.mockReturnValue(makeActions(7));

			const { bulkSync } = makeBulkSync({
				localFileCount: 10,
				settingsOverrides: { fileModificationConfirmationMin: 5, fileModificationConfirmationThreshold: 50 },
			});
			const onTooManyChanges = vi.fn();
			bulkSync.setOnTooManyChanges(onTooManyChanges);

			const result = await bulkSync.run();

			expect(onTooManyChanges).toHaveBeenCalledOnce();
			expect(result.abortedByUser).toBe(true);
			expect(syncOneFileSpy).not.toHaveBeenCalled();
		});

		it('logs an ERROR with per-vault counts when guard triggers', async () => {
			planActionsSpy.mockReturnValue(makeActions(7));
			classifyActionsSpy.mockReturnValue({
				...emptyPreview(),
				groupNew: 5, groupUpdated: 2, groupDeleted: 1,
				localNew: 3, localUpdated: 1, localDeleted: 2,
			});

			const logger = new Logger(() => 'DEBUG', () => 100);
			const { bulkSync } = makeBulkSync({
				localFileCount: 10,
				settingsOverrides: { fileModificationConfirmationMin: 5, fileModificationConfirmationThreshold: 50 },
				logger,
			});

			await bulkSync.run();

			const entry = logger.getEntries().find(e => e.severity === 'ERROR' && e.message.includes('too many'));
			expect(entry).toBeDefined();
			expect(entry?.detail).toContain('Group vault: 8 (5 new, 2 updated, 1 deleted)');
			expect(entry?.detail).toContain('Local vault: 6 (3 new, 1 updated, 2 deleted)');
		});

		it('does NOT fire when modifyCount is below the percentage threshold', async () => {
			// 10 files, 3 actions → 30% < 50%
			planActionsSpy.mockReturnValue(makeActions(3));

			const { bulkSync } = makeBulkSync({
				localFileCount: 10,
				settingsOverrides: { fileModificationConfirmationMin: 5, fileModificationConfirmationThreshold: 50 },
			});
			const onTooManyChanges = vi.fn();
			bulkSync.setOnTooManyChanges(onTooManyChanges);

			await bulkSync.run();

			expect(onTooManyChanges).not.toHaveBeenCalled();
		});

		it('does NOT fire when localFileCount is below fileModificationConfirmationMin', async () => {
			// Only 4 files < min 5, so guard should not trigger even at 100% modify rate
			planActionsSpy.mockReturnValue(makeActions(4));

			const { bulkSync } = makeBulkSync({
				localFileCount: 4,
				settingsOverrides: { fileModificationConfirmationMin: 5, fileModificationConfirmationThreshold: 10 },
			});
			const onTooManyChanges = vi.fn();
			bulkSync.setOnTooManyChanges(onTooManyChanges);

			await bulkSync.run();

			expect(onTooManyChanges).not.toHaveBeenCalled();
		});
	});

	// ── abortCurrentPass ─────────────────────────────────────────────────────

	describe('abortCurrentPass()', () => {
		it('stops the action loop after the current file completes', async () => {
			planActionsSpy.mockReturnValue(makeActions(5));

			const { bulkSync } = makeBulkSync({ localFileCount: 5 });

			let syncCount = 0;
			// eslint-disable-next-line @typescript-eslint/no-misused-promises -- mockImplementation correctly propagates the returned Promise to the awaiting caller
			syncOneFileSpy.mockImplementation(() => {
				syncCount++;
				if (syncCount === 1) bulkSync.abortCurrentPass();
				return Promise.resolve({ changed: true, merged: false, hadConflictMarkers: false });
			});

			const result = await bulkSync.run();

			expect(syncOneFileSpy).toHaveBeenCalledTimes(1);
			expect(result.abortedByUser).toBe(true);
		});
	});

	// ── result counters ───────────────────────────────────────────────────────

	describe('run() — result counters', () => {
		it('increments downloaded for each changed pull action', async () => {
			planActionsSpy.mockReturnValue([{ type: 'pull', path: 'a.md' }, { type: 'pull', path: 'b.md' }]);

			const { bulkSync } = makeBulkSync({ localFileCount: 3 });
			const result = await bulkSync.run();

			expect(result.downloaded).toBe(2);
		});

		it('increments uploaded for each changed push action', async () => {
			planActionsSpy.mockReturnValue([{ type: 'push', path: 'a.md' }]);

			const { bulkSync } = makeBulkSync({ localFileCount: 1 });
			const result = await bulkSync.run();

			expect(result.uploaded).toBe(1);
		});

		it('increments deleted for deleteLocal and deleteRemote', async () => {
			planActionsSpy.mockReturnValue([
				{ type: 'deleteLocal', path: 'a.md' },
				{ type: 'deleteRemote', path: 'b.md' },
			]);

			const { bulkSync } = makeBulkSync({ localFileCount: 3 });
			const result = await bulkSync.run();

			expect(result.deleted).toBe(2);
		});

		it('increments conflicts and merges for conflict actions', async () => {
			planActionsSpy.mockReturnValue([{ type: 'conflict', path: 'a.md' }, { type: 'conflict', path: 'b.md' }]);
			syncOneFileSpy
				.mockResolvedValueOnce({ changed: true, merged: true, hadConflictMarkers: false })
				.mockResolvedValueOnce({ changed: true, merged: false, hadConflictMarkers: false });

			const { bulkSync } = makeBulkSync({ localFileCount: 3 });
			const result = await bulkSync.run();

			expect(result.conflicts).toBe(2);
			expect(result.merges).toBe(1);
		});

		it('does not count files where syncOneFile reports no change', async () => {
			planActionsSpy.mockReturnValue([{ type: 'pull', path: 'a.md' }]);
			syncOneFileSpy.mockResolvedValue({ changed: false, merged: false, hadConflictMarkers: false });

			const { bulkSync } = makeBulkSync({ localFileCount: 1 });
			const result = await bulkSync.run();

			expect(result.downloaded).toBe(0);
		});
	});

	// ── status bar ────────────────────────────────────────────────────────────

	describe('run() — status bar', () => {
		it('sets status bar to summary after a successful pass', async () => {
			planActionsSpy.mockReturnValue([{ type: 'pull', path: 'a.md' }, { type: 'push', path: 'b.md' }]);

			const { bulkSync, setStatusBar } = makeBulkSync({ localFileCount: 2 });
			await bulkSync.run();

			expect(setStatusBar).toHaveBeenCalledWith(expect.stringContaining('downloaded'));
		});

		it('sets status bar to paused message when too-many-changes fires', async () => {
			planActionsSpy.mockReturnValue(makeActions(7));

			const { bulkSync, setStatusBar } = makeBulkSync({
				localFileCount: 10,
				settingsOverrides: { fileModificationConfirmationMin: 5, fileModificationConfirmationThreshold: 50 },
			});

			await bulkSync.run();

			expect(setStatusBar).toHaveBeenCalledWith(expect.stringContaining('paused'));
		});
	});
});
