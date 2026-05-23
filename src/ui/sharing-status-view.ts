import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { DeferralManager } from '../sync/deferral-manager';
import type { SyncActionType, ViewCandidate } from '../sync/types';
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
 * Opened via command palette ("Open sharing status panel") or by clicking
 * the persistent deferral status bar item. On open, pauses sharing and runs
 * a plan-only pass to collect current candidate counts. Shows the current
 * paused/running state, a pause/resume button, a refresh button, and a
 * per-operation-type count table. Tapping a table row opens the
 * {@link PendingListModal} for that operation type, listing both pending and
 * deferred candidates.
 *
 * The `planFn` returns a combined {@link ViewCandidate} list (pending + deferred)
 * from {@link BulkSync.planOnly}. The view groups these by action type directly —
 * no separate {@link DeferralManager} query is needed for candidate data.
 *
 * Refreshes whenever the caller invokes {@link refresh} — typically wired to
 * {@link DeferralManager}'s `onChanged` callback in the plugin entry point.
 *
 * On close while paused, prompts the user to resume sharing before leaving.
 *
 * TODO: add unit tests once the obsidian-mock package supports `ItemView.containerEl.children[1]`
 * (the content-pane child that ItemView rendering depends on).
 */
export class SharingStatusView extends ItemView {
	private viewCandidates: ViewCandidate[] = [];
	private isRefreshing = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly manager: DeferralManager,
		private readonly planFn: () => Promise<ViewCandidate[]>,
	) {
		super(leaf);
	}

	getViewType(): string { return SHARING_STATUS_VIEW_TYPE; }
	getDisplayText(): string { return 'Sharing status'; }
	getIcon(): string { return 'alert-triangle'; }

	async onOpen(): Promise<void> {
		await this.manager.setPaused(true);
		await this.runPlan();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		const paused = await this.manager.isPaused();
		if (paused) {
			const resume = await ConfirmationModal.prompt(
				this.app,
				'Sharing is paused',
				'Resume sharing before closing?',
				'Resume',
				'Keep paused',
			);
			if (resume) {
				await this.manager.setPaused(false);
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

		const paused = await this.manager.isPaused();

		// Group view candidates by action type.
		const viewByType = new Map<SyncActionType, ViewCandidate[]>();
		for (const c of this.viewCandidates) {
			const list = viewByType.get(c.actionType) ?? [];
			list.push(c);
			viewByType.set(c.actionType, list);
		}

		const totalCount = this.viewCandidates.length;

		// State header
		const header = container.createDiv({ cls: 'vault-share-sharing-status-header' });
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
		pauseBtn.addEventListener('click', () => { void this.manager.setPaused(!paused).then(() => this.refresh()); });

		const refreshBtn = header.createEl('button', {
			text: this.isRefreshing ? 'Refreshing…' : 'Refresh',
			cls: 'vault-share-sharing-status-btn',
		});
		refreshBtn.disabled = this.isRefreshing;
		refreshBtn.addEventListener('click', () => { void this.runPlan().then(() => this.refresh()); });

		if (totalCount === 0) {
			container.createEl('p', {
				cls: 'vault-share-sharing-status-empty',
				text: 'No files waiting for review.',
			});
			return;
		}

		// Per-type count table
		const table = container.createEl('table', { cls: 'vault-share-sharing-status-table' });
		const headerRow = table.createEl('thead').createEl('tr');
		headerRow.createEl('th', { text: 'Vault affected' });
		headerRow.createEl('th', { text: 'Planned operation' });
		headerRow.createEl('th', { text: 'Files' });

		const tbody = table.createEl('tbody');
		for (const row of STATUS_ROWS) {
			const candidates = viewByType.get(row.type) ?? [];
			if (candidates.length === 0) continue;

			const tr = tbody.createEl('tr', { cls: 'vault-share-sharing-status-row is-clickable' });
			tr.createEl('td', { text: row.vault });
			tr.createEl('td', { text: row.description });
			tr.createEl('td', { text: String(candidates.length) });

			tr.addEventListener('click', () => {
				new PendingListModal(this.app, candidates, row.type, this.manager).open();
			});
		}
	}

	/** Run the plan-only pass and store the results. Renders Refresh button as busy while running. */
	private async runPlan(): Promise<void> {
		this.isRefreshing = true;
		try {
			this.viewCandidates = await this.planFn();
		} finally {
			this.isRefreshing = false;
		}
	}
}
