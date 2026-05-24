import type { DeferralStore } from './deferral-store';
import type { DeferredCandidate, MixedEntry, SyncAction } from './types';

/**
 * Business logic for the deferred-sync-candidates feature.
 *
 * Coordinates between the persistence layer ({@link DeferralStore}) and
 * {@link BulkSync}:
 * - Decides when to pause sync and defer all candidates based on the threshold.
 * - Performs auto-revocation by comparing stored mtimes against current file state.
 *
 * The `onChanged` callback is invoked whenever deferred state or the paused flag
 * changes, allowing the status bar and Sharing Status panel to refresh reactively.
 *
 * The paused flag and the deferred-path set are the single sources of truth for
 * sharing state across the plugin. Call {@link init} at startup to warm both
 * in-memory caches; thereafter {@link isPausedSync} and {@link isDeferredPathSync}
 * return cached values without I/O cost.
 */
export class DeferralManager {
	/** In-memory cache; null means not yet loaded from IndexedDB. */
	private cachedPaused: boolean | null = null;
	/** In-memory cache of currently-deferred vault paths; null means not yet loaded. */
	private cachedDeferredPaths: Set<string> | null = null;

	constructor(
		private readonly store: DeferralStore,
		private readonly onChanged: () => void,
	) {}

	/**
	 * Warm both in-memory caches from IndexedDB.
	 *
	 * Must be called once at plugin startup before the scheduler's first tick so
	 * that {@link isPausedSync} and {@link isDeferredPathSync} return accurate
	 * values from the very beginning.
	 */
	async init(): Promise<void> {
		const [, candidates] = await Promise.all([
			this.isPaused(),
			this.store.getAllCandidates(),
		]);
		this.cachedDeferredPaths = new Set(candidates.map(c => c.path));
	}

	/**
	 * Returns the current paused state, reading from IndexedDB the first time and
	 * from the in-memory cache thereafter.
	 */
	async isPaused(): Promise<boolean> {
		if (this.cachedPaused !== null) return this.cachedPaused;
		const paused = await this.store.isPaused();
		this.cachedPaused = paused;
		return paused;
	}

	/**
	 * Synchronous cache read.  Returns `false` until {@link init} (or {@link isPaused})
	 * has been awaited at least once.  Safe to call from hot paths such as the
	 * 1-second scheduler tick.
	 */
	isPausedSync(): boolean {
		return this.cachedPaused ?? false;
	}

	/**
	 * Synchronous cache read.  Returns `false` until {@link init} has been awaited.
	 * Safe to call from hot paths such as the 1-second scheduler tick.
	 */
	isDeferredPathSync(path: string): boolean {
		return this.cachedDeferredPaths?.has(path) ?? false;
	}

	/** Pause or resume sharing on this device. Updates the cache and triggers {@link onChanged}. */
	async setPaused(paused: boolean): Promise<void> {
		this.cachedPaused = paused;
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
		this.cachedPaused = true;
		this.cachedDeferredPaths = new Set(actions.map(a => a.path));
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
	 * Intended to be called by {@link BulkSync}; not a general-purpose API.
	 *
	 * @returns The set of vault paths that remain validly deferred and must be skipped
	 *   by the caller's action-planning step.
	 */
	async reconcile(entries: MixedEntry[]): Promise<Set<string>> {
		const candidates = await this.store.getAllCandidates();
		if (candidates.length === 0) {
			this.cachedDeferredPaths = new Set();
			return new Set();
		}

		const entryMap = new Map<string, MixedEntry>(entries.map(e => [e.path, e]));
		const validPaths = new Set<string>();
		const pathsToDrop: string[] = [];

		for (const candidate of candidates) {
			const entry = entryMap.get(candidate.path);
			const currentLocalMtime = entry?.local?.mtime ?? 0;
			const currentRemoteMtime = entry?.remote?.mtime ?? 0;

			const kept =
				currentLocalMtime  === candidate.localMtime &&
				currentRemoteMtime === candidate.remoteMtime;

			if (kept) {
				validPaths.add(candidate.path);
			} else {
				pathsToDrop.push(candidate.path);
			}
		}

		if (pathsToDrop.length > 0) {
			await this.store.deleteCandidates(pathsToDrop);
			this.onChanged();
		}

		this.cachedDeferredPaths = validPaths;
		return validPaths;
	}

	/**
	 * Add specific candidates to the deferred set without pausing sharing.
	 *
	 * Used when the user explicitly unchecks pending candidates in the Apply flow of
	 * {@link PendingListModal}. Unlike {@link deferAllAndPause}, this does not replace
	 * existing candidates and does not set the paused flag.
	 */
	async addDeferred(candidates: DeferredCandidate[]): Promise<void> {
		if (candidates.length === 0) return;
		await this.store.putCandidates(candidates);
		if (this.cachedDeferredPaths) {
			for (const c of candidates) this.cachedDeferredPaths.add(c.path);
		}
		this.onChanged();
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
		if (this.cachedDeferredPaths) {
			for (const p of paths) this.cachedDeferredPaths.delete(p);
		}
		this.onChanged();
	}

	/**
	 * Release all deferred candidates at once.
	 *
	 * Equivalent to calling {@link releaseByPath} for every deferred path, but
	 * more efficient. Useful for cleanup in tests and setup routines.
	 */
	async releaseAll(): Promise<void> {
		await this.store.clearCandidates();
		this.cachedDeferredPaths = new Set();
		this.onChanged();
	}

}
