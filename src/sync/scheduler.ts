import type { EventRef, Workspace, WorkspaceLeaf } from 'obsidian';
import type { SyncContext } from './types';
import type { BulkSync } from './bulk-sync';
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
	workspace: Workspace;
	setStatusBar: (text: string) => void;
	registerEvent: (ref: EventRef) => void;
	registerInterval: (id: number) => void;
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
export class SyncScheduler {
	private bulkNextRunAt = 0; // 0 = run immediately
	private readonly fileStates = new Map<string, PerFileState>();
	private paused = false;
	private bulkRunning = false;
	private onStatusChangeCb?: () => void;

	constructor(private readonly deps: SyncSchedulerDeps) {}

	/** Returns the current sharing status for display in the instrumentation view. */
	getStatus(): 'paused' | 'running' | 'enabled' {
		if (this.paused) return 'paused';
		if (this.bulkRunning) return 'running';
		return 'enabled';
	}

	/** Register a callback invoked whenever the sharing status changes. */
	setOnStatusChange(cb: () => void): void {
		this.onStatusChangeCb = cb;
	}

	/** Abort the current bulk-sync pass after the in-progress file completes. */
	abortCurrentPass(): void {
		if (this.bulkRunning) {
			this.deps.bulkSync.abortCurrentPass();
		}
	}

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

		const intervalId = window.setInterval(() => { void this.tick(); }, 1000);
		registerInterval(intervalId);
	}

	destroy(): void {
		this.fileStates.clear();
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) return;
		this.paused = paused;
		this.onStatusChangeCb?.();
	}

	isPaused(): boolean {
		return this.paused;
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

	private async tick(): Promise<void> {
		if (this.paused) return;

		const now = Date.now();
		const { ctx, bulkSync, workspace, setStatusBar } = this.deps;

		// Dispatch bulk sync if due and not already running.
		// containerEl.doc is Obsidian's per-element Document reference, used for popout window compat.
		const doc: Document = this.deps.workspace.containerEl.doc ?? window.document;
		if (!this.bulkRunning && now >= this.bulkNextRunAt && doc.visibilityState === 'visible') {
			this.bulkRunning = true;
			this.onStatusChangeCb?.();
			const intervalMs = ctx.settings().bulkSyncPoll * 1000;
			this.bulkNextRunAt = now + intervalMs;
			void bulkSync.run().finally(() => {
				this.bulkRunning = false;
				this.onStatusChangeCb?.();
			});
		}

		// Dispatch single-file syncs that are due.
		// The deadline is the earlier of holdDown and poll. After running:
		//   - holdDown is always cleared (reset to Infinity)
		//   - poll advances only for monitored files
		const pollMs = ctx.settings().openFilePoll * 1000;
		for (const [path, state] of this.fileStates) {
			if (now >= Math.min(state.nextHoldDownAt, state.nextPollAt)) {
				state.nextHoldDownAt = Infinity;
				state.nextPollAt = state.monitored ? now + pollMs : Infinity;
				void singleFileSync(path, ctx, workspace, setStatusBar, p => this.clearHoldDown(p));
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
