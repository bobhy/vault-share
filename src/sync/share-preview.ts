import type { SyncAction, SyncPreviewResult } from './types';
import type { SyncContext } from './types';
import type { ExcludeMatcher } from './exclude';
import type { VaultShareSettings } from '../settings';
import { buildMixedEntries } from './change-detector';
import { classifyStatus } from './change-detector';
import { planActions } from './decision-engine';

const TEXT_EXTENSIONS = new Set(['.md', '.txt']);

function isTextFile(path: string): boolean {
	const dot = path.lastIndexOf('.');
	return dot !== -1 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Classify a set of planned sync actions into the preview result buckets.
 * Pure function; used by both SharePreview.compute() and BulkSync before
 * executing the action list.
 */
export function classifyActions(
	actions: SyncAction[],
	settings: VaultShareSettings,
): SyncPreviewResult {
	const result: SyncPreviewResult = {
		groupNew: 0,
		groupUpdated: 0,
		groupDeleted: 0,
		groupDeletedPaths: [],
		localNew: 0,
		localUpdated: 0,
		localDeleted: 0,
		localDeletedPaths: [],
		contentConflicts: 0,
		contentConflictPaths: [],
		deleteConflicts: 0,
		deleteConflictPaths: [],
		textMergeFiles: 0,
		textMergeFilePaths: [],
		collectedAt: Date.now(),
	};

	for (const action of actions) {
		switch (action.type) {
			case 'push':
				if (action.remote) { result.groupUpdated++; } else { result.groupNew++; }
				break;
			case 'pull':
				if (action.local) { result.localUpdated++; } else { result.localNew++; }
				break;
			case 'deleteRemote':
				result.groupDeleted++;
				result.groupDeletedPaths.push(action.path);
				break;
			case 'deleteLocal':
				result.localDeleted++;
				result.localDeletedPaths.push(action.path);
				break;
			case 'conflict': {
				const localStatus = classifyStatus(action.local, action.record, true);
				const remoteStatus = classifyStatus(action.remote, action.record, false);
				const isDeleteConflict = localStatus === 'deleted' || remoteStatus === 'deleted';
				if (isDeleteConflict) {
					result.deleteConflicts++;
					result.deleteConflictPaths.push(action.path);
				} else {
					result.contentConflicts++;
					result.contentConflictPaths.push(action.path);
					if (isTextFile(action.path) && settings.textFileConflict === 'Merge') {
						result.textMergeFiles++;
						result.textMergeFilePaths.push(action.path);
					}
				}
				break;
			}
		}
	}

	return result;
}

/**
 * Computes what a bulk-sync pass would do right now without executing any actions.
 * Enumerates both sides and plans actions using the same logic as BulkSync.
 */
export class SharePreview {
	constructor(
		private readonly ctx: SyncContext,
		private readonly excludeMatcher: ExcludeMatcher,
	) {}

	async compute(): Promise<SyncPreviewResult> {
		const rootFolderId = this.ctx.driveFolderId();
		if (!rootFolderId) {
			return {
				groupNew: 0, groupUpdated: 0, groupDeleted: 0, groupDeletedPaths: [],
				localNew: 0, localUpdated: 0, localDeleted: 0, localDeletedPaths: [],
				contentConflicts: 0, contentConflictPaths: [],
				deleteConflicts: 0, deleteConflictPaths: [],
				textMergeFiles: 0, textMergeFilePaths: [],
				collectedAt: Date.now(),
			};
		}

		const [localFiles, remoteFiles, allRecords] = await Promise.all([
			this.ctx.localFs.list(this.excludeMatcher),
			this.ctx.driveFs.listAll(rootFolderId),
			this.ctx.store.getAllRecords(),
		]);

		const hasHistory = allRecords.length > 0;
		const entries = buildMixedEntries(localFiles, remoteFiles, allRecords);
		const actions = planActions(entries, hasHistory).filter(a => a.type !== 'noOp');

		return classifyActions(actions, this.ctx.settings());
	}
}
