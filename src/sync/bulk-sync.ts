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
 *
 * When the threshold guard fires and all actions are deferred, the
 * `onThresholdPause` callback is invoked with the count of deferred actions
 * so the caller can show a user-visible Notice.
 */
export class BulkSync {
	private running = false;
	private lastPlanResult: ViewCandidate[] | null = null;

	/**
	 * Actions deposited by {@link approveForExecution} after the user clicks Apply
	 * in {@link PendingListModal}.  When non-null, the next {@link doRun} call
	 * routes to {@link executeApproved} instead of re-planning, bypassing the
	 * threshold guard so the same files cannot trigger a second deferral.
	 * Consumed and reset to `null` at the start of each {@link doRun} call.
	 */
	private pendingApprovedActions: SyncAction[] | null = null;

	/**
	 * True while a {@link run} pass is actively executing.
	 *
	 * When `isRunning` is `true`, a pass is in flight and {@link onPassCompleted}
	 * is guaranteed to fire on completion.  Callers that want to wait for an
	 * in-progress pass should register {@link onPassCompleted} only after
	 * confirming `isRunning` is `true`, or use the poll-friendly
	 * {@link lastPassCompletedAt} timestamp instead.
	 */
	get isRunning(): boolean { return this.running; }

	/**
	 * Unix timestamp (ms) of the most recently completed {@link run} pass.
	 * Zero before the first pass. Updated before {@link onPassCompleted} fires,
	 * so it is always accurate when the callback is invoked.
	 */
	lastPassCompletedAt = 0;

	/**
	 * Result of the most recently completed {@link run} pass.
	 * `null` before the first pass. Updated atomically with
	 * {@link lastPassCompletedAt}.
	 */
	lastPassResult: SyncPassResult | null = null;

	/**
	 * Optional callback fired at the end of every {@link run} pass, after
	 * {@link lastPassCompletedAt} and {@link lastPassResult} are updated.
	 *
	 * Fires regardless of how the pass ended — whether it executed actions,
	 * was skipped (paused, not logged in, or deferred by threshold), or
	 * encountered an error.  Not fired by {@link planOnly}.
	 *
	 * Designed for synchronising with sync completion without polling fixed
	 * timeouts.  Production callers may also use this for post-sync notifications.
	 */
	onPassCompleted: (() => void) | null = null;

	constructor(
		private readonly ctx: SyncContext,
		private readonly excludeMatcher: ExcludeMatcher,
		private readonly app: App,
		private readonly setStatusBar: (text: string) => void,
		private readonly deferralManager: DeferralManager,
		private readonly onPlanChanged: (candidates: ViewCandidate[]) => void,
		private readonly onThresholdPause: (count: number) => void,
	) {}

	/**
	 * Called by {@link PendingListModal} after the user clicks Apply on a set of
	 * previously-deferred candidates.  Deposits the approved {@link SyncAction}
	 * list so the next {@link run} call routes to {@link executeApproved} instead
	 * of re-planning.
	 *
	 * The caller is responsible for removing candidates from the deferral store
	 * (via {@link DeferralManager.releaseByPath}) before calling this method.
	 * `approveForExecution` does not interact with the deferral store directly.
	 *
	 * Sharing must be unpaused by the caller before the next `run()` call;
	 * `approveForExecution` does not resume sharing on its own.
	 */
	approveForExecution(actions: SyncAction[]): void {
		this.pendingApprovedActions = actions;
	}

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
		const { viewCandidates, pendingActions } = await this.doPlanning(rootFolderId);
		const deferredCount = viewCandidates.length - pendingActions.length;
		this.ctx.logger.info(
			`Plan: ${viewCandidates.length} candidate${viewCandidates.length === 1 ? '' : 's'} — ${pendingActions.length} pending, ${deferredCount} deferred`,
		);
		return viewCandidates;
	}

	async run(): Promise<SyncPassResult> {
		if (this.running) {
			this.ctx.logger.debug('Bulk sync skipped: already running');
			return { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, merges: 0, deferredByThreshold: false };
		}
		this.running = true;
		try {
			const result = await this.doRun();
			this.lastPassResult = result;
			return result;
		} finally {
			this.running = false;
			this.lastPassCompletedAt = Date.now();
			this.onPassCompleted?.();
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
		duplicatePathsFound: number;
	}> {
		const [localFiles, listAllResult, allRecords] = await Promise.all([
			this.ctx.localFs.list(this.excludeMatcher),
			this.ctx.driveFs.listAll(rootFolderId),
			this.ctx.store.getAllRecords(),
		]);
		const remoteFiles = listAllResult.files;
		const { duplicatePathsFound } = listAllResult;

		const vaultHasHistory = allRecords.length > 0;
		const entries = buildMixedEntries(localFiles, remoteFiles, allRecords);
		const deferredPaths = await this.deferralManager.reconcile(entries);

		const allActions = planActions(entries, vaultHasHistory);

		const viewCandidates: ViewCandidate[] = allActions
			.filter(a => a.type !== 'noOp')
			.map(a => ({ ...a, isDeferred: deferredPaths.has(a.path) }));

		const pendingActions = allActions.filter(
			a => a.type !== 'noOp' && !deferredPaths.has(a.path),
		);

		this.lastPlanResult = viewCandidates;
		this.onPlanChanged(viewCandidates);

		return { viewCandidates, pendingActions, localFileCount: localFiles.length, hasHistory: vaultHasHistory, duplicatePathsFound };
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

		// If the user approved a set of candidates via Apply in PendingListModal,
		// execute them directly — no re-plan and no threshold guard so the same
		// files cannot trigger a second deferral.
		const approvedActions = this.pendingApprovedActions;
		if (approvedActions !== null) {
			this.pendingApprovedActions = null;
			return this.executeApproved(approvedActions);
		}

		this.setStatusBar('Sharing');
		this.ctx.logger.info('Bulk sync started');
		this.ctx.statsTracker.recordBulkSyncPass();

		try {
			const { pendingActions, localFileCount, hasHistory, duplicatePathsFound } = await this.doPlanning(rootFolderId);

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
				this.onThresholdPause(pendingActions.length);
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

	/**
	 * Execute a pre-approved set of {@link SyncAction}s deposited by
	 * {@link approveForExecution}.
	 *
	 * Skips the planning pass and the threshold guard entirely, so approved
	 * files cannot trigger a second deferral.  Validates each action against
	 * the current local mtime before executing: if the local file changed since
	 * the plan was built the action is skipped (logged at INFO) to avoid acting
	 * on stale data.  Remote staleness is handled naturally inside
	 * {@link syncOneFile}.
	 */
	private async executeApproved(actions: SyncAction[]): Promise<SyncPassResult> {
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
			`Bulk sync: executing ${actions.length} approved action${actions.length === 1 ? '' : 's'}`,
		);
		this.ctx.statsTracker.recordBulkSyncPass();

		try {
			for (const action of actions) {
				// Local mtime validation — cheap, no network.
				const currentMtime = this.ctx.localFs.stat(action.path)?.mtime ?? 0;
				const approvedMtime = action.local?.mtime ?? 0;
				if (currentMtime !== approvedMtime) {
					this.ctx.logger.info(
						`executeApproved: skipping ${action.path} — local file changed since approval`,
					);
					continue;
				}

				this.ctx.logger.debug(`sync ${action.path}: ${action.type}`);
				// Approved actions always come from a vault that already has sync history.
				const fileResult = await syncOneFile(action, this.ctx, /* hasHistory */ true);

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
