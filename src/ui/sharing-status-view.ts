/**
 * Sidebar view that lets the user inspect and control the sharing process.
 *
 * A single always-on layout (no separate running/paused modes):
 *
 * 1. **Live status section** — the bulk-sync state (Paused / Running / Idle)
 *    with the path of the file currently being shared, plus the file
 *    single-file sync is currently processing. Both lines are blank when idle.
 * 2. **Pause/Resume + Refresh buttons** — Refresh is enabled only while paused
 *    (live counts already update from running passes otherwise).
 * 3. **Per-operation count table** — `Pending` (Default + Approved) and
 *    `Deferred` (held-back) counts per action type. Always visible and live;
 *    rows are clickable (opening {@link PendingListModal}) only while paused.
 *
 * Persistent candidate state is read directly from {@link CandidateStore}; the
 * transient "currently sharing" signal comes from {@link sync/sync-activity!SyncActivity}. Both
 * fire change notifications wired in `main.ts` to re-render this view — there
 * is no separate snapshot held here.
 *
 * @packageDocumentation
 */
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Candidate, SyncActionType, SyncContext } from '../sync/types';
import type { CandidateStore } from '../sync/candidate-store';
import type { BulkSync } from '../sync/bulk-sync';
import { ConfirmationModal } from './confirmation-modal';
import { PendingListModal } from './pending-list-modal';

/** Workspace view-type identifier registered with Obsidian. */
export const SHARING_STATUS_VIEW_TYPE = 'vault-share-sharing-status';

interface StatusRow {
	type: SyncActionType;
	vault: string;
	description: string;
}

const STATUS_ROWS: StatusRow[] = [
	{ type: 'push',         vault: 'Group vault', description: 'Push local changes to group vault' },
	{ type: 'pull',         vault: 'Local vault',  description: 'Pull group vault changes to local' },
	{ type: 'deleteRemote', vault: 'Group vault', description: 'Delete from group vault' },
	{ type: 'deleteLocal',  vault: 'Local vault',  description: 'Delete from local vault' },
	{ type: 'conflict',     vault: 'Local vault',  description: 'Resolve file conflicts' },
];

/**
 * Sidebar panel for manually inspecting and controlling the sharing process.
 *
 * Reads candidate state from {@link CandidateStore} and live activity from
 * {@link sync/sync-activity!SyncActivity} — no in-memory snapshot.  Refreshes reactively whenever
 * either store's change notification fires (both wired in `main.ts`).
 *
 * The layout is always-on: a live status section (bulk state + currently-shared
 * file, plus the single-file-sync file), Pause/Resume and Refresh buttons, and a
 * per-operation count table with `Pending` (Default + Approved) and `Deferred`
 * (held-back) columns.  The table is always visible and updates live as the
 * engine works; its rows open the {@link PendingListModal} only while paused.
 *
 * The "Refresh" button (enabled only while paused) triggers
 * {@link BulkSync.planOnly}, which calls `CandidateStore.reconcile()`
 * internally, then re-renders the view.
 */
export class SharingStatusView extends ItemView {
	private isRefreshing = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly candidateStore: CandidateStore,
		private readonly bulkSync: BulkSync,
		private readonly ctx: SyncContext,
	) {
		super(leaf);
	}

	getViewType(): string { return SHARING_STATUS_VIEW_TYPE; }
	getDisplayText(): string { return 'Sharing status'; }
	getIcon(): string { return 'alert-triangle'; }

	async onOpen(): Promise<void> {
		// Only enumerate candidates if sharing is already paused; while running
		// the candidate list is a moving target and won't be displayed anyway.
		if (await this.candidateStore.isPaused()) {
			await this.bulkSync.planOnly();
		}
		await this.refresh();
	}

	async onClose(): Promise<void> {
		const paused = await this.candidateStore.isPaused();
		if (paused) {
			const resume = await ConfirmationModal.prompt(
				this.app,
				'Sharing is paused',
				'Resume sharing before closing?',
				'Resume',
				'Keep paused',
			);
			if (resume) {
				await this.candidateStore.setPaused(false);
			}
		}
		this.containerEl.empty();
	}

	/** Re-renders the view with the latest paused state, live activity, and counts. */
	async refresh(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (!container) return;

		container.empty();
		container.addClass('vault-share-sharing-status-container');

		const paused = await this.candidateStore.isPaused();
		const activity = this.ctx.activity.getSnapshot();
		const allCandidates = this.candidateStore.getAll().filter(c => c.state !== 'Synced');
		const totalCount = allCandidates.length;

		const header = container.createDiv({ cls: 'vault-share-sharing-status-header' });

		// ── Live status section (always shown) ─────────────────────────────
		// Bulk state: Paused (user flag) takes precedence; otherwise Running
		// reflects an in-flight pass and Idle is the enabled-but-waiting state.
		const bulkState = paused ? 'Paused' : activity.bulkRunning ? 'Running' : 'Idle';
		// Pending = will be shared on resume (Default + Approved); Deferred =
		// held back. Together they total the non-Synced candidate population.
		const deferred = allCandidates.filter(c => c.state === 'Deferred').length;
		const pending = totalCount - deferred;
		this.renderStatusLine(
			header,
			'Bulk sharing status: ',
			`${bulkState}, pending files: ${pending}, deferred: ${deferred}`,
		);
		// Current file: whatever file the engine is syncing right now (bulk,
		// single-file, or manual resolution), blank when idle.
		this.renderStatusLine(header, 'Current file: ', activity.currentPath ?? '', 'path');

		// ── Pause / Resume + Refresh buttons ────────────────────────────────
		const pauseBtn = header.createEl('button', {
			text: paused ? 'Resume sharing' : 'Pause sharing',
			cls: paused ? 'mod-cta vault-share-sharing-status-btn' : 'vault-share-sharing-status-btn',
		});
		pauseBtn.addEventListener('click', () => {
			const willPause = !paused;
			void this.candidateStore.setPaused(willPause).then(async () => {
				// Collect candidates as soon as we pause so the table populates immediately.
				if (willPause) await this.bulkSync.planOnly();
				await this.refresh();
			});
		});

		// Refresh re-enumerates via planOnly. Only useful while paused — a running
		// pass keeps the counts live on its own — so it is disabled otherwise.
		const refreshBtn = header.createEl('button', {
			text: this.isRefreshing ? 'Refreshing…' : 'Refresh',
			cls: 'vault-share-sharing-status-btn',
		});
		refreshBtn.disabled = !paused || this.isRefreshing;
		refreshBtn.addEventListener('click', () => {
			this.isRefreshing = true;
			void this.bulkSync.planOnly().then(() => {
				this.isRefreshing = false;
				void this.refresh();
			});
		});

		// ── Per-operation count table (always shown, live) ──────────────────
		if (totalCount === 0) {
			container.createEl('p', {
				cls: 'vault-share-sharing-status-empty',
				text: 'No files waiting for review.',
			});
			return;
		}

		// Group candidates by action type for the table.
		const byType = new Map<SyncActionType, Candidate[]>();
		for (const c of allCandidates) {
			const list = byType.get(c.actionType) ?? [];
			list.push(c);
			byType.set(c.actionType, list);
		}

		const table = container.createEl('table', { cls: 'vault-share-sharing-status-table' });
		const headerRow = table.createEl('thead').createEl('tr');
		headerRow.createEl('th', { text: 'Vault affected' });
		headerRow.createEl('th', { text: 'Planned operation' });
		headerRow.createEl('th', { text: 'Pending' });
		headerRow.createEl('th', { text: 'Deferred' });

		const tbody = table.createEl('tbody');
		for (const row of STATUS_ROWS) {
			const candidates = byType.get(row.type) ?? [];
			if (candidates.length === 0) continue;

			// Pending = will be shared on resume (Default + Approved);
			// Deferred = held back. The row stays visible whenever the type has
			// any non-Synced candidate, so a fully-deferred type is still
			// reachable to release later.
			const pending = candidates.filter(c => c.state !== 'Deferred').length;
			const deferred = candidates.length - pending;

			// Rows are interactive only while paused; otherwise they are inert
			// (the per-operation modal acts on a frozen plan, so it must not be
			// reachable while the engine is mutating candidates).
			const tr = tbody.createEl('tr', {
				cls: paused
					? 'vault-share-sharing-status-row is-clickable'
					: 'vault-share-sharing-status-row',
			});
			tr.createEl('td', { text: row.vault });
			tr.createEl('td', { text: row.description });
			tr.createEl('td', { text: String(pending) });
			tr.createEl('td', { text: String(deferred) });

			if (paused) {
				tr.addEventListener('click', () => {
					new PendingListModal(
						this.app, row.type, this.candidateStore, this.ctx,
						() => { void this.refresh(); },
					).open();
				});
			}
		}
	}

	/**
	 * Render one status line: a bold `label` followed by `value`. When
	 * `valueKind` is `'path'` the value is styled as a muted, truncating file
	 * path (used for the "Current file" line); otherwise it is plain text.
	 */
	private renderStatusLine(
		parent: HTMLElement,
		label: string,
		value: string,
		valueKind: 'text' | 'path' = 'text',
	): void {
		const line = parent.createDiv({ cls: 'vault-share-sharing-status-activity' });
		line.createSpan({ cls: 'vault-share-sharing-status-activity-label', text: label });
		line.createSpan({
			cls: valueKind === 'path' ? 'vault-share-sharing-status-activity-path' : '',
			text: value,
		});
	}
}
