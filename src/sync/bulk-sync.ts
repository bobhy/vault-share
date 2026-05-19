import type { SyncContext, SyncPassResult, SyncPreviewResult } from './types';
import type { ExcludeMatcher } from './exclude';
import { buildMixedEntries } from './change-detector';
import { planActions } from './decision-engine';
import { syncOneFile } from './file-syncer';
import { classifyActions } from './share-preview';

/**
 * Orchestrates a full vault synchronization pass.
 * Processes one file at a time, yielding between files so queued
 * single-file sync operations can run in the same event loop.
 */
export class BulkSync {
	private abortSignal = false;
	private onPlanComplete?: (preview: SyncPreviewResult) => void;
	private onTooManyChanges?: () => void;

	constructor(
		private readonly ctx: SyncContext,
		private readonly excludeMatcher: ExcludeMatcher,
		private readonly setStatusBar: (text: string) => void,
	) {}

	/** Signal the running pass to stop after the current file completes. */
	abortCurrentPass(): void {
		this.abortSignal = true;
	}

	/** Register a callback invoked with the planned actions before they execute. */
	setOnPlanComplete(cb: (preview: SyncPreviewResult) => void): void {
		this.onPlanComplete = cb;
	}

	/** Register a callback invoked when too many changes are detected; caller should pause sharing. */
	setOnTooManyChanges(cb: () => void): void {
		this.onTooManyChanges = cb;
	}

	async run(): Promise<SyncPassResult> {
		this.abortSignal = false;
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
			this.ctx.logger.debug('Bulk sync skipped: not logged in to Drive');
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
			const actions = planActions(entries, hasHistory).filter(a => a.type !== 'noOp');

			// Emit preview snapshot before any actions execute.
			const preview = classifyActions(actions, this.ctx.settings());
			this.onPlanComplete?.(preview);

			// Too-many-changes guard: auto-pause instead of prompting.
			const syncableCount = localFiles.length;
			const modifyCount = actions.length; // already filtered to non-noOp above

			const settings = this.ctx.settings();
			if (
				syncableCount >= settings.fileModificationConfirmationMin &&
				syncableCount > 0 &&
				(modifyCount / syncableCount) * 100 > settings.fileModificationConfirmationThreshold
			) {
				const groupCount = preview.groupNew + preview.groupUpdated + preview.groupDeleted;
				const localCount = preview.localNew + preview.localUpdated + preview.localDeleted;
				this.ctx.logger.error(
					'Bulk sharing paused: too many pending changes',
					`Group vault: ${groupCount} (${preview.groupNew} new, ${preview.groupUpdated} updated, ${preview.groupDeleted} deleted); ` +
					`Local vault: ${localCount} (${preview.localNew} new, ${preview.localUpdated} updated, ${preview.localDeleted} deleted)`,
				);
				this.onTooManyChanges?.();
				result.abortedByUser = true;
				this.setStatusBar('Sharing paused — too many changes');
				return result;
			}

			// Process one file at a time, yielding between each.
			for (const action of actions) {
				if (this.abortSignal) { result.abortedByUser = true; break; }
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
