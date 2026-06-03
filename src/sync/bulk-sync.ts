/**
 * Bulk synchronization orchestrator.
 *
 * One {@link BulkSync.run} call enumerates both vaults, asks
 * {@link CandidateStore} to reconcile the plan, applies the threshold guard,
 * and executes each pending action via {@link syncOneFile}. Concurrent
 * `run()` callers coalesce onto a single in-flight pass so the scheduler and
 * UI triggers can never race each other into a double pass. Approved
 * candidates bypass planning entirely via {@link BulkSync.executeApproved}.
 *
 * @packageDocumentation
 */
import type { Candidate, SyncActionType, SyncContext, SyncFileResult, SyncPassResult } from './types';
import type { ExcludeMatcher } from './exclude';
import type { CandidateStore } from './candidate-store';
import { syncOneFile } from './file-syncer';
import { sha256Hex } from './content-hash';

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
			if (fileResult.identicalContent) {
				result.identicalTimestamps++;
			} else {
				result.conflicts++;
				if (fileResult.merged) result.merges++;
			}
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
 * When the user clicks Apply in `PendingListModal`, selected candidates are
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
		private readonly onSuspectDeletePause: (count: number) => void,
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
			identicalTimestamps: 0,
			failed: 0,
			deferredByThreshold: false,
			deferredBySuspectDelete: false,
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

			const rebaselinedPaths = await this.candidates.reconcile(localFiles, remoteFiles);

			// Site 1 — sha256 rebaseline verification.
			// reconcile() uses size equality as a heuristic to rebaseline
			// both-present no-history files as Synced. Verify each with Drive's
			// sha256Checksum to catch the rare false positive (different files at
			// the same path, same byte count). When the hash mismatches, flip the
			// candidate back to Default/conflict so the user sees it rather than
			// silently accepting a wrong sync record.
			for (const path of rebaselinedPaths) {
				const candidate = this.candidates.get(path);
				const remoteHash = candidate?.remote?.sha256Checksum;
				if (!remoteHash) continue;  // hash absent — keep size-equality result
				const localContent = await this.ctx.localFs.read(path);
				const localHash = await sha256Hex(localContent);
				if (localHash !== remoteHash) {
					this.ctx.logger.info(`Rebaseline sha256 mismatch (corrected to conflict): ${path}`);
					await this.candidates.rebaselineAsConflict(path);
				}
			}

			if (duplicatePathsFound > 0) {
				this.ctx.logger.warning(
					`Drive duplicates detected: ${duplicatePathsFound} path${duplicatePathsFound === 1 ? '' : 's'} ` +
					`had multiple Drive files; older copies were ignored. ` +
					`Run "Repair Drive duplicates" to remove stale copies.`,
				);
				this.ctx.statsTracker.recordPassWithDuplicates();
			}

			// Suspect-delete guard (stricter than, and prior to, the threshold
			// guard). A `deleteRemote` removes a file from the *group* vault on the
			// strength of the local file being absent. But "absent" can mean the
			// enumeration was incomplete (a not-yet-loaded vault index, a truncated
			// listing, a broadened exclude rule, an offline/adapter-level delete) —
			// not that anyone deleted anything. We only *trust* a `deleteRemote`
			// when an explicit `vault.on('delete')` event flagged the path
			// (`locallyDeletedAt > 0`). Any unflagged `deleteRemote` is deferred and
			// pauses sharing for review — regardless of the threshold, and even for
			// a single file: silently removing a user's notes from the group vault
			// is exactly the failure we are guarding against.
			const allPending = this.candidates.getPending();
			const suspectDeletes = allPending.filter(
				c => c.actionType === 'deleteRemote' && (c.locallyDeletedAt ?? 0) === 0,
			);
			if (suspectDeletes.length > 0) {
				await this.candidates.deferAllAndPause(suspectDeletes);
				result.deferredBySuspectDelete = true;
				const msg = `Sharing paused: ${suspectDeletes.length} file${suspectDeletes.length === 1 ? '' : 's'} ` +
					`missing locally without a delete signal — confirm before removing from the group vault`;
				this.setStatusBar(msg);
				this.ctx.logger.info(msg);
				this.onSuspectDeletePause(suspectDeletes.length);
				return result;
			}

			// Threshold guard: too many global changes → defer all and pause
			// instead of executing. All action types count as global changes,
			// including `deleteLocal` (a remote peer deleted a file, which is
			// as significant as any other change). The denominator is the union
			// of local and Drive paths so a peer-driven mass-delete or mass-pull
			// is weighed against the total file population, not just the local
			// subset.
			//
			// Remote-empty handling:
			//   - No sync history: skip the guard. This is a fresh install
			//     joining a populated group vault; the user expects everything
			//     to push without a confirmation dialog.
			//   - Sync history exists: run the guard. Remote being empty when
			//     there is an established sync record signals an accidental
			//     Drive-folder wipe (or the wrong folder). The ratio will be
			//     ~100 %, so the guard fires and the user is asked to confirm
			//     before anything is re-uploaded.
			//
			// Local-empty: always skip. Nothing to protect — the user has no
			// established state on this device yet.
			const settings = this.ctx.settings();
			const pending = this.candidates.getPending();
			const globalChangeCount = pending.length;

			const unionPaths = new Set<string>();
			for (const f of localFiles)  unionPaths.add(f.path);
			for (const f of remoteFiles) unionPaths.add(f.path);
			const unionFileCount = unionPaths.size;

			const hasHistory = this.candidates.hasSyncHistory();
			if (
				localFiles.length > 0 &&
				(remoteFiles.length > 0 || hasHistory) &&
				unionFileCount >= settings.globalChangeMin &&
				(globalChangeCount / unionFileCount) * 100 > settings.globalChangeThreshold
			) {
				await this.candidates.deferAllAndPause(pending);
				result.deferredByThreshold = true;
				const msg = `Sharing paused: ${pending.length} global changes deferred for review`;
				this.setStatusBar(msg);
				this.ctx.logger.info(msg);
				this.onThresholdPause(pending.length);
				return result;
			}

			// Execute pending candidates one at a time, yielding between each.
			for (const candidate of pending) {
				await this.syncAndApply(candidate, hasHistory, /* approved */ false, result);
				// Yield to allow queued single-file sync microtasks to run.
				await Promise.resolve();
			}

			await this.ctx.statsTracker.flush();

			const summary = summarize(result);
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
			identicalTimestamps: 0,
			failed: 0,
			deferredByThreshold: false,
			deferredBySuspectDelete: false,
		};

		this.setStatusBar('Sharing');
		this.ctx.logger.info(
			`Bulk sync: executing ${approved.length} approved action${approved.length === 1 ? '' : 's'}`,
		);
		this.ctx.statsTracker.recordBulkSyncPass();

		try {
			// Approved actions always come from a vault that already has sync history.
			for (const candidate of approved) {
				await this.syncAndApply(candidate, /* hasHistory */ true, /* approved */ true, result);
				// Yield to allow queued single-file sync microtasks to run.
				await Promise.resolve();
			}

			await this.ctx.statsTracker.flush();

			const summary = summarize(result);
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
	 * Execute one candidate and apply its result to the store, with a
	 * per-candidate try/catch so a single failing file doesn't block the rest
	 * of the queue.
	 *
	 * Two error policies:
	 *   - `Local file not found: <path>` (from `LocalFs#getFileOrThrow`):
	 *     the user deleted the file between planning and execution. Cancel
	 *     the candidate via {@link CandidateStore.remove} so we don't crash
	 *     on the same file every pass. This is the bug-class that motivated
	 *     this method — see sync-review-followups item (16).
	 *   - Any other error (transient Drive failures, IDB issues, etc.):
	 *     log at `error` level, bump `result.failed`, and leave the
	 *     candidate alone for the next pass to retry.
	 *
	 * Note that the actionType snapshot is taken *before* `applyFileResult`
	 * mutates the candidate's `actionType` to `'noOp'` via `markSynced`, so
	 * `tallyFileResult` sees the pre-mutation value.
	 */
	private async syncAndApply(
		candidate: Candidate,
		hasHistory: boolean,
		approved: boolean,
		result: SyncPassResult,
	): Promise<void> {
		const actionType = candidate.actionType;
		const tag = approved ? ' (approved)' : '';
		this.ctx.logger.debug(`sync ${candidate.path}: ${actionType}${tag}`);

		try {
			const fileResult = await syncOneFile(candidate, this.ctx, hasHistory);
			tallyFileResult(actionType, fileResult, result);
			await this.candidates.applyFileResult(candidate.path, actionType, fileResult);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.failed++;
			this.ctx.logger.error(
				`sync ${candidate.path} (${actionType}${tag}) failed`,
				msg,
			);

			// The only error we *cancel* the candidate for is "local file
			// gone." Everything else stays in the cache for retry.
			if (err instanceof Error && err.message.startsWith('Local file not found:')) {
				this.ctx.logger.info(
					`cancelling candidate ${candidate.path}: local file no longer exists`,
				);
				await this.candidates.remove(candidate.path);
			}
		}
	}

	/**
	 * Total count of non-`Synced` candidates from the most recent planning pass.
	 * Returns `null` before the first plan has run.
	 */
	getPendingCount(): number | null {
		return this.candidates.getPendingCount();
	}
}

/** Build a one-line summary of pass results for the status bar / info log. */
function summarize(r: SyncPassResult): string {
	const base = `Shared: ${r.downloaded} downloaded, ${r.uploaded} uploaded, ${r.deleted} deleted`;
	const extras: string[] = [];
	if (r.identicalTimestamps > 0) extras.push(`${r.identicalTimestamps} timestamp-reconciled`);
	if (r.failed > 0) extras.push(`${r.failed} failed`);
	return extras.length > 0 ? `${base}, ${extras.join(', ')}` : base;
}
