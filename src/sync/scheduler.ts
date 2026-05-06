import type { EventRef, Workspace, WorkspaceLeaf } from 'obsidian';
import type { SyncContext } from './types';
import type { BulkSync } from './bulk-sync';
import { singleFileSync } from './single-file-sync';

interface PerFileState {
	nextRunAt: number;
	lastEditAt: number;
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
 * Each operation is represented by a nextRunAt timestamp.
 * Handles background/foreground catchup naturally — past-due operations
 * fire on the next tick after the app is foregrounded.
 */
export class SyncScheduler {
	private bulkNextRunAt = 0; // 0 = run immediately
	private readonly fileStates = new Map<string, PerFileState>();
	private paused = false;
	private bulkRunning = false;

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
			const now = Date.now();
			state.lastEditAt = now;
			const holdMs = ctx.settings().openFileChangeHoldDown * 1000;
			state.nextRunAt = now + holdMs;
		}));

		const intervalId = window.setInterval(() => { void this.tick(); }, 1000);
		registerInterval(intervalId);
	}

	destroy(): void {
		this.fileStates.clear();
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	isPaused(): boolean {
		return this.paused;
	}

	/** Schedule bulk sync to run immediately on the next tick. */
	triggerBulkSync(): void {
		this.bulkNextRunAt = 0;
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
			const intervalMs = ctx.settings().bulkSyncPoll * 1000;
			this.bulkNextRunAt = now + intervalMs;
			void bulkSync.run().finally(() => { this.bulkRunning = false; });
		}

		// Dispatch single-file syncs that are due.
		const pollMs = ctx.settings().openFilePoll * 1000;
		for (const [path, state] of this.fileStates) {
			if (now >= state.nextRunAt) {
				state.nextRunAt = now + pollMs;
				void singleFileSync(path, ctx, workspace, setStatusBar);
			}
		}
	}

	private onFileVisible(path: string): void {
		if (this.fileStates.has(path)) return;
		this.fileStates.set(path, { nextRunAt: 0, lastEditAt: 0 });
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

		// Remove entries for files no longer visible.
		for (const path of this.fileStates.keys()) {
			if (!visible.has(path)) this.fileStates.delete(path);
		}

		// Add entries for newly visible files.
		for (const path of visible) {
			this.onFileVisible(path);
		}
	}
}
