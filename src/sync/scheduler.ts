/**
 * Heartbeat-driven scheduler that owns all sync timing.
 *
 * One 1-second `setInterval` drives both the periodic bulk-sync pass and the
 * per-file single-file syncs (hold-down after edit, poll for monitored
 * files). The bulk-sync deadline and per-file deadlines are evaluated on each
 * tick; whichever is due fires immediately. See {@link SyncScheduler} for the
 * deadline-precedence rules.
 *
 * @packageDocumentation
 */
import type { EventRef, TAbstractFile, Workspace, WorkspaceLeaf } from 'obsidian';
import type { SyncContext } from './types';
import type { BulkSync } from './bulk-sync';
import type { CandidateStore } from './candidate-store';
import { singleFileSync } from './single-file-sync';

/** Two-deadline state tracked per open or recently-open file. */
export interface PerFileState {
	/** Epoch ms when a holdDown-triggered sync is due; Infinity = none pending. */
	nextHoldDownAt: number;
	/**
	 * Epoch ms when the next poll-triggered sync is due.
	 * Infinity = not being monitored (no polling).
	 */
	nextPollAt: number;
	/** Whether the user has enabled monitoring (poll) mode for this file. */
	monitored: boolean;
	/**
	 * True only for the open/visible file (tracked via
	 * {@link SyncScheduler.onFileVisible}), whose entry has an ongoing lifecycle —
	 * merge-base seed, optional polling, view refresh, and re-arming across edits —
	 * and is removed by visibility ({@link SyncScheduler.recomputeVisibleFiles}).
	 *
	 * The common case is `false`: an entry created reactively by a vault
	 * create/modify (any non-excluded file, e.g. another plugin rewriting a closed
	 * note) is a one-shot — it fires a single hold-down sync and is then evicted, so
	 * {@link fileStates} does not accumulate one row per file ever touched.
	 */
	persistent: boolean;
}

/** Dependencies passed to {@link SyncScheduler} at construction. */
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
	/**
	 * Returns true if the given vault path is excluded from sharing (config dir
	 * or a user exclude rule). Gates the reactive create/modify trigger so the
	 * scheduler does not single-file-sync constantly-churning excluded files
	 * (e.g. `.obsidian/workspace.json`). Backed by {@link sync/exclude!ExcludeMatcher}.
	 */
	isExcludedPath: (path: string) => boolean;
	/**
	 * Returns true once the vault's file index is fully loaded (Obsidian's
	 * `onLayoutReady`). Bulk sync is gated on this so a not-yet-loaded vault — a
	 * transiently-empty/incomplete `localFs.list()` — cannot be misread as mass
	 * local deletions during the startup window.
	 */
	isVaultReady: () => boolean;
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
 * Beyond open files, vault `create`/`modify` events arm a one-shot hold-down sync
 * for any non-excluded file — including files rewritten by other plugins as a side
 * effect of editing an open note (e.g. the Tasks plugin updating a closed source
 * note). These reactive entries are not {@link PerFileState.persistent} and are
 * evicted after their single sync so {@link fileStates} stays bounded.
 *
 * Handles background/foreground catchup: past-due deadlines fire on the next tick
 * after the app is foregrounded.
 *
 * Sharing-paused state is not tracked here — it is the sole responsibility of
 * {@link CandidateStore}. The {@link SyncSchedulerDeps.isSharingPaused} callback
 * reads the cached value from {@link CandidateStore.isPausedSync} on every tick.
 */
export class SyncScheduler {
	private bulkNextRunAt = 0; // 0 = run immediately
	private readonly fileStates = new Map<string, PerFileState>();
	private bulkRunning = false;
	private intervalId: number | null = null;
	/**
	 * Tracks whether the previous tick saw sharing paused, so the tick can
	 * detect the paused → resumed edge and fire a bulk pass immediately rather
	 * than waiting for {@link bulkNextRunAt}.
	 */
	private wasPaused = false;
	/**
	 * Fired whenever {@link bulkNextRunAt} changes, so UI showing the next
	 * scheduled bulk pass (the "Idle till HH:MM:SS" line in the Sharing Status
	 * panel) re-renders the moment the schedule actually moves — on trigger,
	 * resume, or after a pass reschedules the next one.
	 */
	private nextRunChangeCb: (() => void) | null = null;

	constructor(private readonly deps: SyncSchedulerDeps) {}

	/**
	 * Register a callback fired whenever the next scheduled bulk-sync time
	 * changes. Used by the Sharing Status panel to keep its "Idle till …" line
	 * responsive to reschedules. Only one callback is held; the latest wins.
	 */
	onNextRunChange(cb: () => void): void {
		this.nextRunChangeCb = cb;
	}

	/**
	 * Epoch ms of the next scheduled bulk-sync pass, or `0` when one is due to
	 * run on the next eligible tick. Reflects only the timer; it does not account
	 * for the paused flag or an in-flight pass (the panel reads those separately).
	 */
	getNextBulkSyncAt(): number {
		return this.bulkNextRunAt;
	}

	/** Assign {@link bulkNextRunAt} and notify listeners if the value changed. */
	private setBulkNextRunAt(at: number): void {
		if (this.bulkNextRunAt === at) return;
		this.bulkNextRunAt = at;
		this.nextRunChangeCb?.();
	}

	/**
	 * Begin the 1-second heartbeat and register Obsidian event listeners.
	 * Call once during plugin load after {@link CandidateStore.init} resolves.
	 */
	start(): void {
		const { workspace, registerEvent, registerInterval, ctx } = this.deps;

		registerEvent(workspace.on('file-open', file => {
			if (!file) return;
			this.onFileVisible(file.path);
		}));

		registerEvent(workspace.on('layout-change', () => {
			this.recomputeVisibleFiles(workspace);
		}));

		// Create/modify both arm a reactive sync for the affected file, whether or
		// not it is open. This catches files rewritten by other plugins as a side
		// effect of editing an open note (e.g. the Tasks plugin updating a closed
		// source note from a query result). Folders are skipped, and excluded paths
		// are filtered inside armReactiveSync.
		const onCreateOrModify = (file: TAbstractFile) => {
			if ('children' in file) return; // TFolder has children; sync files only
			this.armReactiveSync(file.path);
		};
		registerEvent(ctx.app.vault.on('create', onCreateOrModify));
		registerEvent(ctx.app.vault.on('modify', onCreateOrModify));

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
			await new Promise(r => window.setTimeout(r, 50));
		}
	}

	/** Drop per-file timer state. Called from `onunload`. */
	destroy(): void {
		this.fileStates.clear();
	}

	/** Schedule bulk sync to run immediately on the next tick. */
	triggerBulkSync(): void {
		this.setBulkNextRunAt(0);
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
		if (this.deps.isSharingPaused()) {
			this.wasPaused = true;
			return;
		}

		// Sharing was just resumed (paused → not paused). Run a bulk pass on
		// this tick instead of waiting up to bulkSyncPoll (default 1 h) for the
		// timer — otherwise Approved actions can sit unexecuted long after the
		// user resumes. Covers every resume path (panel button, close prompt,
		// command) because it keys off the persisted paused flag, not the UI.
		if (this.wasPaused) {
			this.wasPaused = false;
			this.setBulkNextRunAt(0);
		}

		const now = Date.now();
		const { ctx, bulkSync, workspace, setStatusBar } = this.deps;

		// Dispatch bulk sync if due and not already running.
		// containerEl.doc is Obsidian's per-element Document reference, used for popout window compat.
		const doc: Document = this.deps.workspace.containerEl.doc ?? window.document;
		if (!this.bulkRunning && now >= this.bulkNextRunAt && doc.visibilityState === 'visible' && this.deps.isVaultReady()) {
			this.bulkRunning = true;
			const intervalMs = ctx.settings().bulkSyncPoll * 1000;
			this.setBulkNextRunAt(now + intervalMs);
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
				// A non-persistent entry (reactive create/modify on a closed file)
				// fires exactly once, then is evicted so fileStates does not
				// accumulate a row per file ever touched. A later change re-creates it.
				if (!state.persistent) this.fileStates.delete(path);
			}
		}
	}

	/**
	 * Arm a reactive hold-down sync for a file changed by a create/modify event,
	 * whether or not it is open. Excluded paths are ignored. An already-tracked
	 * file (the open file, or a still-pending one-shot) just has its hold-down
	 * re-armed, preserving its flags; an untracked file gets a fresh one-shot
	 * (non-persistent) entry.
	 */
	private armReactiveSync(path: string): void {
		if (this.deps.isExcludedPath(path)) return;
		const holdMs = this.deps.ctx.settings().openFileChangeHoldDown * 1000;
		const existing = this.fileStates.get(path);
		if (existing) {
			existing.nextHoldDownAt = Date.now() + holdMs;
			return;
		}
		this.fileStates.set(path, {
			nextHoldDownAt: Date.now() + holdMs,
			nextPollAt: Infinity,
			monitored: false,
			persistent: false,
		});
	}

	private onFileVisible(path: string): void {
		if (this.fileStates.has(path)) return;
		// nextHoldDownAt = 0 triggers an immediate sync on first tick after open.
		this.fileStates.set(path, { nextHoldDownAt: 0, nextPollAt: Infinity, monitored: false, persistent: true });
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
