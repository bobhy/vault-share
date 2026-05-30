import type { Candidate, SyncActionType, SyncContext, SyncFileResult, SyncPassResult } from './types';
import type { ExcludeMatcher } from './exclude';
import type { CandidateStore } from './candidate-store';
import { syncOneFile } from './file-syncer';

/**
 * Tally one file's sync result into a {@link SyncPassResult} counter set.
 * Pure function — does not touch the store. Pairs with
 * {@link CandidateStore.applyFileResult}, which handles the store side.
 */
function tallyFileResult(
	actionType: SyncActionType,
	fileResult: SyncFileResult,
	result: SyncPassResult,
): void {
	if (!fileResult.changed) return;
	if (actionType === 'deleteLocal' || actionType === 'deleteRemote') {
		result.deleted++;
		return;
	}
	if (!fileResult.syncedState) return;
	switch (actionType) {
		case 'pull': result.downloaded++; break;
		case 'push': result.uploaded++; break;
		case 'conflict':
			result.conflicts++;
			if (fileResult.merged) result.merges++;
			break;
	}
}

/**
 * Orchestrates a full vault synchronization pass.
 * Processes one file at a time, yielding between files so queued
 * single-file sync operations can run in the same event loop.
 *
 * {@link CandidateStore} is the sole source of truth for candidate state.
 * `BulkSync` reads from it, executes actions, and writes back results.
 *
 * ### Approved candidates
 * When the user clicks Apply in {@link PendingListModal}, selected candidates are
 * persisted to IDB as `Approved` via {@link CandidateStore.approve}.  On the
 * next {@link run} call, {@link doRun} checks for `Approved` candidates first
 * and routes to {@link executeApproved} instead of the normal planning path.
 * This bypasses re-planning and the threshold guard so the same files cannot
 * trigger a second deferral.  Because `Approved` state is persisted to IDB, it
 * survives plugin restarts and scheduler-tick races without any in-memory pointers.
 *
 * ### Threshold guard
 * When the planned action count exceeds the configured threshold,
 * all `Default` candidates are transitioned to `Deferred` and sync is paused
 * via {@link CandidateStore.deferAllAndPause}.  The `onThresholdPause` callback
 * notifies the caller so a user-visible Notice can be shown.
 */
export class BulkSync {
	/**
	 * The Promise for the currently in-flight pass, or `null` if no pass is running.
	 *
	 * Concurrent callers of {@link run} share this Promise — they observe the
	 * *same* pass's result rather than starting a new one or getting a misleading
	 * synchronous zero. Cleared in the IIFE's finally so a `.then(() => run())`
	 * tail caller correctly starts a fresh pass.
	 */
	private inFlight: Promise<SyncPassResult> | null = null;

	constructor(
		private readonly ctx: SyncContext,
		private readonly excludeMatcher: ExcludeMatcher,
		private readonly setStatusBar: (text: string) => void,
		private readonly candidates: CandidateStore,
		private readonly onThresholdPause: (count: number) => void,
	) {}

	/**
	 * Enumerate both vaults and plan actions without executing anything.
	 *
	 * Intended for the Sharing Status panel's Refresh button.  Calls
	 * {@link CandidateStore.reconcile} to compute the latest action plan and
	 * update the in-memory cache; returns the full candidate list.
	 *
	 * Unlike {@link run}, this method does not check the paused flag, does not
	 * apply the threshold guard, and does not update the sync status bar.
	 */
	async planOnly(): Promise<Candidate[]> {
		const rootFolderId = this.ctx.driveFolderId();
		if (!rootFolderId) return [];
		const [localFiles, { files: remoteFiles }] = await Promise.all([
			this.ctx.localFs.list(this.excludeMatcher),
			this.ctx.driveFs.listAll(rootFolderId),
		]);
		await this.candidates.reconcile(localFiles, remoteFiles);
		const all = this.candidates.getAll();
		this.ctx.logger.info(
			`Plan: ${all.length} candidate${all.length === 1 ? '' : 's'} tracked`,
		);
		return all;
	}

	/**
	 * Execute one bulk sync pass and return its result.
	 *
	 * If a pass is already in flight, the call coalesces onto that pass and
	 * returns its result rather than starting a second one. This is the
	 * "only one bulk sync at a time" invariant the scheduler relied on, made
	 * explicit so callers always receive a meaningful {@link SyncPassResult}
	 * instead of a synchronous zero.
	 */
	async run(): Promise<SyncPassResult> {
		if (this.inFlight) {
			this.ctx.logger.debug('Bulk sync coalesced: pass already in flight');
			return this.inFlight;
		}
		this.inFlight = (async () => {
			try {
				return await this.doRun();
			} finally {
				this.inFlight = null;
			}
		})();
		return this.inFlight;
	}

	private async doRun(): Promise<SyncPassResult> {
		const result: SyncPassResult = {
			downloaded: 0,
			uploaded: 0,
			deleted: 0,
			conflicts: 0,
			merges: 0,
			deferredByThreshold: false,
		};

		const rootFolderId = this.ctx.driveFolderId();
		if (!rootFolderId) {
			this.ctx.logger.debug('Bulk sync skipped: not logged in to Drive');
			return result;
		}

		// Bail immediately if paused — no enumeration needed.
		if (await this.candidates.isPaused()) {
			this.ctx.logger.debug('Bulk sync skipped: sync is paused');
			return result;
		}

		// Approved candidates bypass planning and the threshold guard entirely.
		// Their intent has been persisted to IDB and survives plugin restarts and
		// scheduler-tick races without any in-memory pointers.
		const approved = this.candidates.getApproved();
		if (approved.length > 0) {
			return this.executeApproved(approved);
		}

		// Normal planning pass.
		this.setStatusBar('Sharing');
		this.ctx.logger.info('Bulk sync started');
		this.ctx.statsTracker.recordBulkSyncPass();

		try {
			const [localFiles, listAllResult] = await Promise.all([
				this.ctx.localFs.list(this.excludeMatcher),
				this.ctx.driveFs.listAll(rootFolderId),
			]);
			const { files: remoteFiles, duplicatePathsFound } = listAllResult;

			await this.candidates.reconcile(localFiles, remoteFiles);

			if (duplicatePathsFound > 0) {
				this.ctx.logger.warning(
					`Drive duplicates detected: ${duplicatePathsFound} path${duplicatePathsFound === 1 ? '' : 's'} ` +
					`had multiple Drive files; older copies were ignored. ` +
					`Run "Repair Drive duplicates" to remove stale copies.`,
				);
				this.ctx.statsTracker.recordPassWithDuplicates();
			}

			// Threshold guard: too many changes → defer all and pause instead of executing.
			const settings = this.ctx.settings();
			const pending = this.candidates.getPending();
			const localFileCount = localFiles.length;
			const modifyCount = pending.filter(a => a.actionType !== 'deleteLocal').length;

			if (
				localFileCount >= settings.fileModificationConfirmationMin &&
				localFileCount > 0 &&
				(modifyCount / localFileCount) * 100 > settings.fileModificationConfirmationThreshold
			) {
				await this.candidates.deferAllAndPause(pending);
				result.deferredByThreshold = true;
				const msg = `Sharing paused: ${pending.length} changes deferred for review`;
				this.setStatusBar(msg);
				this.ctx.logger.info(msg);
				this.onThresholdPause(pending.length);
				return result;
			}

			// Execute pending candidates one at a time, yielding between each.
			const hasHistory = this.candidates.hasSyncHistory();
			for (const candidate of pending) {
				// Snapshot actionType: applyFileResult → markSynced mutates the
				// shared candidate reference (sets actionType='noOp'), and the
				// tally below must read the pre-mutation value.
				const actionType = candidate.actionType;
				this.ctx.logger.debug(`sync ${candidate.path}: ${actionType}`);
				const fileResult = await syncOneFile(candidate, this.ctx, hasHistory);
				tallyFileResult(actionType, fileResult, result);
				await this.candidates.applyFileResult(candidate.path, actionType, fileResult);

				// Yield to allow queued single-file sync microtasks to run.
				await Promise.resolve();
			}

			await this.ctx.statsTracker.flush();

			const summary = `Shared: ${result.downloaded} downloaded, ${result.uploaded} uploaded, ${result.deleted} deleted`;
			this.setStatusBar(summary);
			this.ctx.logger.info(summary);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.error = err instanceof Error ? err : new Error(msg);
			this.setStatusBar(`Sharing interrupted: ${msg}`);
			this.ctx.logger.error('Bulk sync interrupted', msg);
		}

		return result;
	}

	/**
	 * Execute a pre-approved set of {@link Candidate}s whose `state === 'Approved'`.
	 *
	 * Skips the planning pass and the threshold guard entirely.  Calls
	 * {@link CandidateStore.markSynced} or {@link CandidateStore.remove} after each
	 * successful file so the store is up to date even if the pass is interrupted.
	 */
	private async executeApproved(approved: Candidate[]): Promise<SyncPassResult> {
		const result: SyncPassResult = {
			downloaded: 0,
			uploaded: 0,
			deleted: 0,
			conflicts: 0,
			merges: 0,
			deferredByThreshold: false,
		};

		this.setStatusBar('Sharing');
		this.ctx.logger.info(
			`Bulk sync: executing ${approved.length} approved action${approved.length === 1 ? '' : 's'}`,
		);
		this.ctx.statsTracker.recordBulkSyncPass();

		try {
			// Approved actions always come from a vault that already has sync history.
			for (const candidate of approved) {
				// Snapshot actionType: applyFileResult → markSynced mutates the
				// shared candidate reference (sets actionType='noOp'), and the
				// tally below must read the pre-mutation value.
				const actionType = candidate.actionType;
				this.ctx.logger.debug(`sync ${candidate.path}: ${actionType} (approved)`);
				const fileResult = await syncOneFile(candidate, this.ctx, /* hasHistory */ true);
				tallyFileResult(actionType, fileResult, result);
				await this.candidates.applyFileResult(candidate.path, actionType, fileResult);

				// Yield to allow queued single-file sync microtasks to run.
				await Promise.resolve();
			}

			await this.ctx.statsTracker.flush();

			const summary = `Shared: ${result.downloaded} downloaded, ${result.uploaded} uploaded, ${result.deleted} deleted`;
			this.setStatusBar(summary);
			this.ctx.logger.info(summary);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.error = err instanceof Error ? err : new Error(msg);
			this.setStatusBar(`Sharing interrupted: ${msg}`);
			this.ctx.logger.error('Bulk sync interrupted', msg);
		}

		return result;
	}

	/**
	 * Total count of non-`Synced` candidates from the most recent planning pass.
	 * Returns `null` before the first plan has run.
	 */
	getPendingCount(): number | null {
		return this.candidates.getPendingCount();
	}
}
