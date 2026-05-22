import type { DeferralStore } from './deferral-store';
import type { DeferredCandidate, MixedEntry, SyncAction, SyncActionType } from './types';

/**
 * Business logic for the deferred-sync-candidates feature.
 *
 * Coordinates between the persistence layer ({@link DeferralStore}) and
 * {@link BulkSync}:
 * - Decides when to pause sync and defer all candidates based on the threshold.
 * - Performs auto-revocation by comparing stored mtimes against current file state.
 * - Exposes grouped candidate data for the Bulk Sharing Status panel UI.
 *
 * The `onChanged` callback is invoked whenever deferred state or the paused flag
 * changes, allowing the status bar and status panel to refresh reactively.
 */
export class DeferralManager {
	constructor(
		private readonly store: DeferralStore,
		private readonly onChanged: () => void,
	) {}

	/** True if bulk sync is currently paused on this device. */
	isPaused(): Promise<boolean> {
		return this.store.isPaused();
	}

	/** Pause or resume bulk sync on this device. Triggers {@link onChanged}. */
	async setPaused(paused: boolean): Promise<void> {
		await this.store.setPaused(paused);
		this.onChanged();
	}

	/**
	 * Called when the bulk sync threshold is exceeded.
	 *
	 * Replaces all existing deferred candidates with the supplied action set and
	 * sets the paused flag. The caller should return immediately after this — no
	 * actions should be executed in the same pass.
	 */
	async deferAllAndPause(actions: SyncAction[]): Promise<void> {
		const now = Date.now();
		const candidates: DeferredCandidate[] = actions.map(action => ({
			path: action.path,
			actionType: action.type,
			localMtime: action.local?.mtime ?? 0,
			remoteMtime: action.remote?.mtime ?? 0,
			driveFileId: action.remote?.driveFileId,
			deferredAt: now,
		}));
		await this.store.clearCandidates();
		await this.store.putCandidates(candidates);
		await this.store.setPaused(true);
		this.onChanged();
	}

	/**
	 * Call at the start of each bulk sync pass after enumerating current file state.
	 *
	 * Compares each deferred candidate's stored mtimes against the current values
	 * from the {@link MixedEntry} list. Candidates whose mtimes have changed — because
	 * the user edited, renamed, or deleted a file, or the remote side changed — are
	 * silently dropped. This is the sole auto-revocation mechanism; no explicit
	 * "undefer" call is needed anywhere else in the codebase.
	 *
	 * @returns The set of vault paths that remain validly deferred and must be skipped
	 *   by the caller's action-planning step.
	 */
	async reconcile(entries: MixedEntry[]): Promise<Set<string>> {
		const candidates = await this.store.getAllCandidates();
		if (candidates.length === 0) return new Set();

		const entryMap = new Map<string, MixedEntry>(entries.map(e => [e.path, e]));
		const validPaths = new Set<string>();
		const pathsToDrop: string[] = [];

		for (const candidate of candidates) {
			const entry = entryMap.get(candidate.path);
			const currentLocalMtime = entry?.local?.mtime ?? 0;
			const currentRemoteMtime = entry?.remote?.mtime ?? 0;

			if (
				currentLocalMtime === candidate.localMtime &&
				currentRemoteMtime === candidate.remoteMtime
			) {
				validPaths.add(candidate.path);
			} else {
				pathsToDrop.push(candidate.path);
			}
		}

		if (pathsToDrop.length > 0) {
			await this.store.deleteCandidates(pathsToDrop);
			this.onChanged();
		}

		return validPaths;
	}

	/**
	 * Release specific candidates from deferral (user accepted them via the Apply button).
	 *
	 * Released candidates will be processed in the next bulk sync pass —
	 * immediately if sharing is running, or when the user resumes sharing if paused.
	 */
	async releaseByPath(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await this.store.deleteCandidates(paths);
		this.onChanged();
	}

	/**
	 * Returns all current deferred candidates grouped by {@link SyncActionType}.
	 * Used by the Bulk Sharing Status panel to show per-type counts and lists.
	 */
	async getGroupedByType(): Promise<Map<SyncActionType, DeferredCandidate[]>> {
		const candidates = await this.store.getAllCandidates();
		const grouped = new Map<SyncActionType, DeferredCandidate[]>();
		for (const candidate of candidates) {
			const list = grouped.get(candidate.actionType) ?? [];
			list.push(candidate);
			grouped.set(candidate.actionType, list);
		}
		return grouped;
	}

	/**
	 * Total count of deferred candidates.
	 * Used by the status bar indicator and the startup notice.
	 */
	async getTotalCount(): Promise<number> {
		const candidates = await this.store.getAllCandidates();
		return candidates.length;
	}
}
