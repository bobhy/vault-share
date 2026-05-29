import type { EventRef, Workspace, WorkspaceLeaf } from 'obsidian';
import type { SyncContext } from './types';
import type { BulkSync } from './bulk-sync';
import type { CandidateStore } from './candidate-store';
import { singleFileSync } from './single-file-sync';

interface PerFileState {
	/** Epoch ms when a holdDown-triggered sync is due; Infinity = none pending. */
	nextHoldDownAt: number;
	/**
	 * Epoch ms when the next poll-triggered sync is due.
	 * Infinity = not being monitored (no polling).
	 */
	nextPollAt: number;
	/** Whether the user has enabled monitoring (poll) mode for this file. */
	monitored: boolean;
}

export interface SyncSchedulerDeps {
	ctx: SyncContext;
	bulkSync: BulkSync;
	candidateStore: CandidateStore;
	workspace: Workspace;
	setStatusBar: (text: string) => void;
	registerEvent: (ref: EventRef) => void;
	registerInterval: (id: number) => void;
	/**
	 * Returns the current sharing-paused state synchronously.
	 * Backed by {@link CandidateStore.isPausedSync}, which reads from a cache that is
	 * kept in sync with every {@link CandidateStore.setPaused} call.
	 * Must be accurate before the first scheduler tick (warm the cache via
	 * `await candidateStore.init()` before calling {@link SyncScheduler.start}).
	 */
	isSharingPaused: () => boolean;
	/**
	 * Returns true if the given vault path is currently deferred.
	 * Backed by {@link CandidateStore.isDeferred}, which reads from the in-memory cache.
	 * Prevents single-file sync from executing a deferred file while sharing is
	 * otherwise running (e.g. after the user has partially released candidates).
	 */
	isDeferredPath: (path: string) => boolean;
}

/**
 * Drives all sync scheduling from a single 1-second heartbeat.
 *
 * Each file's sync deadline is tracked as two independent timestamps:
 * - nextHoldDownAt: set on edit, fires `openFileChangeHoldDown` seconds later
 * - nextPollAt: active only for monitored files, fires every `openFilePoll` seconds
 *
 * The tick fires whichever is due first (min of the two), then resets the holdDown
 * to Infinity (poll took precedence or holdDown ran) and advances the poll deadline
 * only for monitored files. This naturally implements the spec rule that
 * "openFilePoll has precedence over openFileChangeHoldDown and will cancel a
 * pending holdDown event."
 *
 * Handles background/foreground catchup: past-due deadlines fire on the next tick
 * after the app is foregrounded.
 */
/**
 * Drives all sync scheduling from a single 1-second heartbeat.
 *
 * Each file's sync deadline is tracked as two independent timestamps:
 * - nextHoldDownAt: set on edit, fires `openFileChangeHoldDown` seconds later
 * - nextPollAt: active only for monitored files, fires every `openFilePoll` seconds
 *
 * The tick fires whichever is due first (min of the two), then resets the holdDown
 * to Infinity (poll took precedence or holdDown ran) and advances the poll deadline
 * only for monitored files. This naturally implements the spec rule that
 * "openFilePoll has precedence over openFileChangeHoldDown and will cancel a
 * pending holdDown event."
 *
 * Handles background/foreground catchup: past-due deadlines fire on the next tick
 * after the app is foregrounded.
 *
 * Sharing-paused state is not tracked here — it is the sole responsibility of
 * {@link DeferralManager}. The {@link SyncSchedulerDeps.isSharingPaused} callback
 * reads the cached value from {@link DeferralManager.isPausedSync} on every tick.
 */
export class SyncScheduler {
	private bulkNextRunAt = 0; // 0 = run immediately
	private readonly fileStates = new Map<string, PerFileState>();
	private bulkRunning = false;
	private intervalId: number | null = null;

	constructor(private readonly deps: SyncSchedulerDeps) {}

	start(): void {
		const { workspace, registerEvent, registerInterval, ctx } = this.deps;

		registerEvent(workspace.on('file-open', file => {
			if (!file) return;
			this.onFileVisible(file.path);
		}));

		registerEvent(workspace.on('layout-change', () => {
			this.recomputeVisibleFiles(workspace);
		}));

		registerEvent(ctx.app.vault.on('modify', file => {
			const state = this.fileStates.get(file.path);
			if (!state) return;
			const holdMs = ctx.settings().openFileChangeHoldDown * 1000;
			state.nextHoldDownAt = Date.now() + holdMs;
		}));

		registerEvent(ctx.app.vault.on('delete', file => {
			const state = this.fileStates.get(file.path);
			if (!state) return;
			// Stop monitoring — no point polling a file that no longer exists.
			state.monitored = false;
			state.nextPollAt = Infinity;
			// Arm hold-down so the deletion propagates after the same delay as an edit.
			// recomputeVisibleFiles will preserve this entry until the timer fires.
			const holdMs = ctx.settings().openFileChangeHoldDown * 1000;
			state.nextHoldDownAt = Date.now() + holdMs;
		}));

		this.intervalId = window.setInterval(() => { void this.tick(); }, 1000);
		registerInterval(this.intervalId);
	}

	/**
	 * Halt the autonomous heartbeat. After this returns, no further tick will
	 * fire and any bulk-sync pass kicked off by the most recent tick has
	 * completed. File-open / modify / delete event handlers remain registered
	 * (they only update per-file timer state, which is harmless without ticks).
	 *
	 * Distinct from {@link CandidateStore.setPaused}, which is a persisted
	 * user-facing pause flag that also causes {@link BulkSync.run} to bail.
	 * `stop()` is non-persisted runtime state: callers (e.g. e2e tests) can
	 * still drive {@link BulkSync.run} directly while the scheduler is silent.
	 */
	async stop(): Promise<void> {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		// Drain any in-flight bulk pass started by the most recent tick.
		while (this.bulkRunning) {
			await new Promise(r => activeWindow.setTimeout(r, 50));
		}
	}

	destroy(): void {
		this.fileStates.clear();
	}

	/** Schedule bulk sync to run immediately on the next tick. */
	triggerBulkSync(): void {
		this.bulkNextRunAt = 0;
	}

	/**
	 * Enable monitoring (poll) mode for the given path.
	 * Per spec, enabling does not immediately run a sync — the first poll
	 * fires `openFilePoll` seconds from now.
	 * No-op if the file is not currently tracked (not open/visible).
	 */
	enableMonitoring(path: string): void {
		const state = this.fileStates.get(path);
		if (!state || state.monitored) return;
		state.monitored = true;
		state.nextPollAt = Date.now() + this.deps.ctx.settings().openFilePoll * 1000;
	}

	/**
	 * Disable monitoring mode for the given path.
	 * No-op if the file is not tracked or not being monitored.
	 */
	disableMonitoring(path: string): void {
		const state = this.fileStates.get(path);
		if (!state || !state.monitored) return;
		state.monitored = false;
		state.nextPollAt = Infinity;
	}

	/** Toggle monitoring for path; returns the new monitored state. */
	toggleMonitoring(path: string): boolean {
		const state = this.fileStates.get(path);
		if (!state) return false;
		if (state.monitored) {
			this.disableMonitoring(path);
		} else {
			this.enableMonitoring(path);
		}
		return state.monitored;
	}

	/** Returns true if monitoring is currently enabled for path. */
	isMonitored(path: string): boolean {
		return this.fileStates.get(path)?.monitored ?? false;
	}

	/** Clear any pending holdDown for path. Called after a pull/merge rewrites the file. */
	clearHoldDown(path: string): void {
		const state = this.fileStates.get(path);
		if (state) state.nextHoldDownAt = Infinity;
	}

	private tick(): void {
		if (this.deps.isSharingPaused()) return;

		const now = Date.now();
		const { ctx, bulkSync, workspace, setStatusBar } = this.deps;

		// Dispatch bulk sync if due and not already running.
		// containerEl.doc is Obsidian's per-element Document reference, used for popout window compat.
		const doc: Document = this.deps.workspace.containerEl.doc ?? window.document;
		if (!this.bulkRunning && now >= this.bulkNextRunAt && doc.visibilityState === 'visible') {
			this.bulkRunning = true;
			const intervalMs = ctx.settings().bulkSyncPoll * 1000;
			this.bulkNextRunAt = now + intervalMs;
			void bulkSync.run().finally(() => { this.bulkRunning = false; });
		}

		// Dispatch single-file syncs that are due.
		// The deadline is the earlier of holdDown and poll. After running:
		//   - holdDown is always cleared (reset to Infinity)
		//   - poll advances only for monitored files
		// Deferred files: advance timers but skip the sync so a partially-released
		// deferral list cannot cause an individually-deferred file to sync while
		// the rest of the vault is still running.
		const pollMs = ctx.settings().openFilePoll * 1000;
		for (const [path, state] of this.fileStates) {
			if (now >= Math.min(state.nextHoldDownAt, state.nextPollAt)) {
				state.nextHoldDownAt = Infinity;
				state.nextPollAt = state.monitored ? now + pollMs : Infinity;
				if (!this.deps.isDeferredPath(path)) {
					void singleFileSync(path, ctx, this.deps.candidateStore, workspace, setStatusBar, p => this.clearHoldDown(p));
				}
			}
		}
	}

	private onFileVisible(path: string): void {
		if (this.fileStates.has(path)) return;
		// nextHoldDownAt = 0 triggers an immediate sync on first tick after open.
		this.fileStates.set(path, { nextHoldDownAt: 0, nextPollAt: Infinity, monitored: false });
		void this.seedBaseContent(path);
	}

	/**
	 * Capture the current on-disk bytes as the merge base the first time a file
	 * becomes visible, before any edits can advance the mtime. Without this,
	 * the first merge on a file with no sync history uses an empty base, which
	 * forces every line into conflict.
	 */
	private async seedBaseContent(path: string): Promise<void> {
		const { store, localFs } = this.deps.ctx;
		const existing = await store.getContent(path);
		if (existing) return;
		const bytes = await localFs.read(path).catch(() => null);
		if (bytes) await store.putContent(path, bytes);
	}

	private recomputeVisibleFiles(workspace: Workspace): void {
		const visible = new Set<string>();
		workspace.iterateAllLeaves(leaf => {
			const view = leaf.view as { file?: { path: string } };
			// Only track leaves in the active tab group; background tab leaves share the
			// same container but are not displayed. Use the tab group's activeLeaf as proxy.
			const tabGroup = leaf.parent as { activeLeaf?: WorkspaceLeaf } | undefined;
			if (tabGroup && tabGroup.activeLeaf && tabGroup.activeLeaf !== leaf) return;
			if (view.file?.path) visible.add(view.file.path);
		});

		// Remove entries for files no longer visible. Preserve an entry only if it
		// has a pending hold-down (an edit or delete that hasn't propagated yet).
		// Pending polls are discarded — no point polling an invisible file.
		for (const [path, state] of this.fileStates) {
			if (!visible.has(path) && state.nextHoldDownAt === Infinity) {
				this.fileStates.delete(path);
			}
		}

		// Add entries for newly visible files.
		for (const path of visible) {
			this.onFileVisible(path);
		}
	}
}
