import type { App } from 'obsidian';
import type { SyncAction, SyncContext, SyncPassResult, ViewCandidate } from './types';
import type { ExcludeMatcher } from './exclude';
import type { DeferralManager } from './deferral-manager';
import { buildMixedEntries } from './change-detector';
import { planActions } from './decision-engine';
import { syncOneFile } from './file-syncer';

/**
 * Orchestrates a full vault synchronization pass.
 * Processes one file at a time, yielding between files so queued
 * single-file sync operations can run in the same event loop.
 *
 * When the planned action count exceeds the configured threshold,
 * all actions are deferred and sync is paused rather than prompting
 * the user with a modal. The {@link DeferralManager} handles persistence
 * and auto-revocation of deferred candidates.
 *
 * After every planning pass — whether triggered by {@link planOnly} or
 * internally by {@link run} — the `onPlanChanged` callback is invoked with
 * the full {@link ViewCandidate} list (pending + deferred). The caller uses
 * this to update the status bar count and show the startup deferral notice.
 */
export class BulkSync {
	private running = false;
	private lastPlanResult: ViewCandidate[] | null = null;

	constructor(
		private readonly ctx: SyncContext,
		private readonly excludeMatcher: ExcludeMatcher,
		private readonly app: App,
		private readonly setStatusBar: (text: string) => void,
		private readonly deferralManager: DeferralManager,
		private readonly onPlanChanged: (candidates: ViewCandidate[]) => void,
	) {}

	/**
	 * Total count of pending candidates (both pending and deferred) from the
	 * most recent planning pass.  Returns `null` if no plan has been run yet.
	 */
	getPendingCount(): number | null {
		return this.lastPlanResult?.length ?? null;
	}

	/**
	 * Enumerate both vaults and plan actions without executing anything.
	 *
	 * Intended for the Sharing Status panel's Refresh button. Calls
	 * {@link DeferralManager.reconcile} to auto-revoke stale deferred candidates,
	 * then returns a combined list of all non-noOp actions tagged with
	 * {@link ViewCandidate.isDeferred}.
	 *
	 * Unlike {@link run}, this method does not check the paused flag, does not
	 * apply the threshold guard, and does not update the sync status bar.
	 */
	async planOnly(): Promise<ViewCandidate[]> {
		const rootFolderId = this.ctx.driveFolderId();
		if (!rootFolderId) return [];
		const { viewCandidates } = await this.doPlanning(rootFolderId);
		return viewCandidates;
	}

	async run(): Promise<SyncPassResult> {
		if (this.running) {
			this.ctx.logger.debug('Bulk sync skipped: already running');
			return { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, merges: 0, deferredByThreshold: false };
		}
		this.running = true;
		try {
			return await this.doRun();
		} finally {
			this.running = false;
		}
	}

	/**
	 * Shared planning core used by both {@link planOnly} and {@link doRun}.
	 *
	 * Enumerates both vaults, calls {@link DeferralManager.reconcile} to
	 * auto-revoke stale deferred candidates, and builds a {@link ViewCandidate}
	 * list that tags each non-noOp action as pending or deferred.
	 *
	 * Updates {@link lastPlanResult} and fires {@link onPlanChanged} so callers
	 * (the status bar, the startup notice) receive the latest candidate count.
	 *
	 * @returns Combined view candidates, executable pending actions, and the
	 *   total local file count needed for the threshold guard.
	 */
	private async doPlanning(rootFolderId: string): Promise<{
		viewCandidates: ViewCandidate[];
		pendingActions: SyncAction[];
		localFileCount: number;
		hasHistory: boolean;
	}> {
		const [localFiles, remoteFiles, allRecords] = await Promise.all([
			this.ctx.localFs.list(this.excludeMatcher),
			this.ctx.driveFs.listAll(rootFolderId),
			this.ctx.store.getAllRecords(),
		]);

		const vaultHasHistory = allRecords.length > 0;
		const entries = buildMixedEntries(localFiles, remoteFiles, allRecords);
		const deferredPaths = await this.deferralManager.reconcile(entries);

		const allActions = planActions(entries, vaultHasHistory);

		const viewCandidates: ViewCandidate[] = allActions
			.filter(a => a.type !== 'noOp')
			.map(a => ({
				path: a.path,
				actionType: a.type,
				isDeferred: deferredPaths.has(a.path),
				driveFileId: a.remote?.driveFileId,
			}));

		const pendingActions = allActions.filter(
			a => a.type !== 'noOp' && !deferredPaths.has(a.path),
		);

		this.lastPlanResult = viewCandidates;
		this.onPlanChanged(viewCandidates);

		return { viewCandidates, pendingActions, localFileCount: localFiles.length, hasHistory: vaultHasHistory };
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
		if (await this.deferralManager.isPaused()) {
			this.ctx.logger.debug('Bulk sync skipped: sync is paused');
			return result;
		}

		this.setStatusBar('Sharing');
		this.ctx.logger.info('Bulk sync started');
		this.ctx.statsTracker.recordBulkSyncPass();

		try {
			const { pendingActions, localFileCount, hasHistory } = await this.doPlanning(rootFolderId);

			// Threshold guard: too many changes → defer all and pause instead of executing.
			const settings = this.ctx.settings();
			const modifyCount = pendingActions.filter(a => a.type !== 'deleteLocal').length;

			if (
				localFileCount >= settings.fileModificationConfirmationMin &&
				localFileCount > 0 &&
				(modifyCount / localFileCount) * 100 > settings.fileModificationConfirmationThreshold
			) {
				await this.deferralManager.deferAllAndPause(pendingActions);
				result.deferredByThreshold = true;
				const msg = `Sharing paused: ${pendingActions.length} changes deferred for review`;
				this.setStatusBar(msg);
				this.ctx.logger.info(msg);
				return result;
			}

			// Process one file at a time, yielding between each.
			for (const action of pendingActions) {
				this.ctx.logger.debug(`sync ${action.path}: ${action.type}`);
				const fileResult = await syncOneFile(action, this.ctx, hasHistory);

				if (fileResult.changed) {
					switch (action.type) {
						case 'pull': result.downloaded++; break;
						case 'push': result.uploaded++; break;
						case 'deleteLocal':
						case 'deleteRemote': result.deleted++; break;
						case 'conflict':
							result.conflicts++;
							if (fileResult.merged) result.merges++;
							break;
					}
				}

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
}
