import type { App } from 'obsidian';
import type { SyncContext, SyncPassResult } from './types';
import type { ExcludeMatcher } from './exclude';
import { buildMixedEntries } from './change-detector';
import { planActions } from './decision-engine';
import { syncOneFile } from './file-syncer';
import { ConfirmationModal } from '../ui/confirmation-modal';

/**
 * Orchestrates a full vault synchronization pass.
 * Processes one file at a time, yielding between files so queued
 * single-file sync operations can run in the same event loop.
 */
export class BulkSync {
	constructor(
		private readonly ctx: SyncContext,
		private readonly excludeMatcher: ExcludeMatcher,
		private readonly app: App,
		private readonly setStatusBar: (text: string) => void,
	) {}

	async run(): Promise<SyncPassResult> {
		const result: SyncPassResult = {
			downloaded: 0,
			uploaded: 0,
			deleted: 0,
			conflicts: 0,
			merges: 0,
			abortedByUser: false,
		};

		const rootFolderId = this.ctx.driveFolderId();
		if (!rootFolderId) {
			this.ctx.logger.debug('Bulk sync skipped: not connected to Drive');
			return result;
		}

		this.setStatusBar('Syncing');
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
			const actions = planActions(entries, hasHistory).filter(a => a.type !== 'noOp');

			// Confirmation guard.
			const syncableCount = localFiles.length;
			const modifyCount = actions.filter(
				a => a.type !== 'noOp' && a.type !== 'deleteLocal',
			).length;

			const settings = this.ctx.settings();
			if (
				syncableCount >= settings.fileModificationConfirmationMin &&
				syncableCount > 0 &&
				(modifyCount / syncableCount) * 100 > settings.fileModificationConfirmationThreshold
			) {
				const proceed = await ConfirmationModal.prompt(
					this.app,
					'Sync confirmation',
					`Bulk sync will modify <strong>${modifyCount}</strong> of ` +
					`<strong>${syncableCount}</strong> files in your vault. Proceed?`,
				);
				if (!proceed) {
					result.abortedByUser = true;
					this.setStatusBar('Sync cancelled');
					return result;
				}
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

			const summary = `Synced: ${result.downloaded} downloaded, ${result.uploaded} uploaded, ${result.deleted} deleted`;
			this.setStatusBar(summary);
			this.ctx.logger.info(summary);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.error = err instanceof Error ? err : new Error(msg);
			this.setStatusBar(`Sync interrupted: ${msg}`);
			this.ctx.logger.error('Bulk sync interrupted', msg);
		}

		return result;
	}
}
