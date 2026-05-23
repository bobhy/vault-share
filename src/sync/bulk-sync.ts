import type { App } from 'obsidian';
import type { SyncContext, SyncPassResult } from './types';
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
 */
export class BulkSync {
	private running = false;

	constructor(
		private readonly ctx: SyncContext,
		private readonly excludeMatcher: ExcludeMatcher,
		private readonly app: App,
		private readonly setStatusBar: (text: string) => void,
		private readonly deferralManager: DeferralManager,
	) {}

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
			// Enumerate both sides.
			const [localFiles, remoteFiles, allRecords] = await Promise.all([
				this.ctx.localFs.list(this.excludeMatcher),
				this.ctx.driveFs.listAll(rootFolderId),
				this.ctx.store.getAllRecords(),
			]);

			const hasHistory = allRecords.length > 0;
			const entries = buildMixedEntries(localFiles, remoteFiles, allRecords);

			// Auto-revoke stale deferred candidates; get the set of paths to skip.
			const deferredPaths = await this.deferralManager.reconcile(entries);

			// Plan actions, filtering out noOps and currently-deferred paths.
			const actions = planActions(entries, hasHistory).filter(
				a => a.type !== 'noOp' && !deferredPaths.has(a.path),
			);

			// Threshold guard: too many changes → defer all and pause instead of executing.
			const syncableCount = localFiles.length;
			const modifyCount = actions.filter(a => a.type !== 'deleteLocal').length;
			const settings = this.ctx.settings();

			if (
				syncableCount >= settings.fileModificationConfirmationMin &&
				syncableCount > 0 &&
				(modifyCount / syncableCount) * 100 > settings.fileModificationConfirmationThreshold
			) {
				await this.deferralManager.deferAllAndPause(actions);
				result.deferredByThreshold = true;
				const msg = `Sharing paused: ${actions.length} changes deferred for review`;
				this.setStatusBar(msg);
				this.ctx.logger.info(msg);
				return result;
			}

			// Process one file at a time, yielding between each.
			for (const action of actions) {
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
