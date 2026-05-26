import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Candidate, SyncActionType, SyncContext } from '../sync/types';
import type { CandidateStore } from '../sync/candidate-store';
import type { BulkSync } from '../sync/bulk-sync';
import { ConfirmationModal } from './confirmation-modal';
import { PendingListModal } from './pending-list-modal';

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
 * Reads all candidate state from {@link CandidateStore} — no in-memory
 * `viewCandidates` snapshot.  Refreshes reactively whenever
 * `candidateStore.onChanged` fires (wired in `main.ts`).
 *
 * **While sharing is running** the view shows only the current state and a
 * "Pause sharing" button, plus an informational banner.  Candidate counts are
 * intentionally hidden — they are a moving target while sync is active.
 *
 * **While paused** the view shows the candidate count, a "Resume sharing"
 * button, a "Refresh" button, and a per-operation-type count table.  Tapping
 * a table row opens the {@link PendingListModal} for that type.
 *
 * The "Refresh" button triggers {@link BulkSync.planOnly} which calls
 * `CandidateStore.reconcile()` internally, then re-renders the view.
 *
 * TODO: add unit tests once the obsidian-mock package supports
 * `ItemView.containerEl.children[1]` (the content-pane child that ItemView
 * rendering depends on).
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

	/** Re-renders the view with the latest paused state and candidate counts. */
	async refresh(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (!container) return;

		container.empty();
		container.addClass('vault-share-sharing-status-container');

		const paused = await this.candidateStore.isPaused();
		const allCandidates = this.candidateStore.getAll().filter(c => c.state !== 'Synced');

		// ── State header (always shown) ────────────────────────────────────
		const header = container.createDiv({ cls: 'vault-share-sharing-status-header' });

		const totalCount = allCandidates.length;
		header.createEl('p', {
			cls: 'vault-share-sharing-status-state',
			text: paused
				? `Sharing is paused — ${totalCount} file${totalCount === 1 ? '' : 's'} pending`
				: 'Sharing is running',
		});

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

		// ── Running state: prompt to pause; don't show candidates ──────────
		if (!paused) {
			container.createDiv({ cls: 'vault-share-sharing-status-notice' }, notice => {
				notice.createEl('p', {
					text: 'Pause sharing to examine sharing status.',
				});
			});
			return;
		}

		// ── Paused state: refresh button + candidate table ──────────────────
		const refreshBtn = header.createEl('button', {
			text: this.isRefreshing ? 'Refreshing…' : 'Refresh',
			cls: 'vault-share-sharing-status-btn',
		});
		refreshBtn.disabled = this.isRefreshing;
		refreshBtn.addEventListener('click', () => {
			this.isRefreshing = true;
			void this.bulkSync.planOnly().then(() => {
				this.isRefreshing = false;
				void this.refresh();
			});
		});

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
		headerRow.createEl('th', { text: 'Files' });

		const tbody = table.createEl('tbody');
		for (const row of STATUS_ROWS) {
			const candidates = byType.get(row.type) ?? [];
			if (candidates.length === 0) continue;

			const tr = tbody.createEl('tr', { cls: 'vault-share-sharing-status-row is-clickable' });
			tr.createEl('td', { text: row.vault });
			tr.createEl('td', { text: row.description });
			tr.createEl('td', { text: String(candidates.length) });

			tr.addEventListener('click', () => {
				new PendingListModal(
					this.app, row.type, this.candidateStore, this.ctx,
					() => { void this.refresh(); },
				).open();
			});
		}
	}
}
