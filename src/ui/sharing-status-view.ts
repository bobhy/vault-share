import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { DeferralManager } from '../sync/deferral-manager';
import type { SyncActionType, SyncContext, ViewCandidate } from '../sync/types';
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
 * the persistent deferral status bar item.
 *
 * **While sharing is running** the view shows only the current state and a
 * "Pause sharing" button, plus an informational banner prompting the user to
 * pause before examining candidates.  Candidate counts are intentionally
 * hidden — they are a moving target while sync is active and would mislead
 * the user about what is actually pending.
 *
 * **While paused** the view shows the candidate count, a "Resume sharing"
 * button, a "Refresh" button, and a per-operation-type count table.  Tapping
 * a table row opens the {@link PendingListModal} for that type.
 *
 * The view does **not** auto-pause sharing on open.  Obsidian calls
 * {@link onOpen} both for user-initiated opens and for workspace-layout
 * restoration on startup; auto-pausing would permanently re-pause sharing
 * every time Obsidian is relaunched with the panel in the saved layout.
 * Users pause explicitly via the "Pause sharing" button.
 *
 * The `planFn` wraps {@link BulkSync.planOnly} and is called only when the
 * view is paused (on open if already paused, and when the user clicks "Pause
 * sharing" or "Refresh").
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
		if (await this.manager.isPaused()) {
			await this.runPlan();
		}
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

		// ── State header (always shown) ────────────────────────────────────
		const header = container.createDiv({ cls: 'vault-share-sharing-status-header' });

		const totalCount = this.viewCandidates.length;
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
			void this.manager.setPaused(willPause).then(async () => {
				// Collect candidates as soon as we pause so the table populates immediately.
				if (willPause) await this.runPlan();
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
		refreshBtn.addEventListener('click', () => { void this.runPlan().then(() => this.refresh()); });

		if (totalCount === 0) {
			container.createEl('p', {
				cls: 'vault-share-sharing-status-empty',
				text: 'No files waiting for review.',
			});
			return;
		}

		// Group candidates by action type for the table.
		const viewByType = new Map<SyncActionType, ViewCandidate[]>();
		for (const c of this.viewCandidates) {
			const list = viewByType.get(c.actionType) ?? [];
			list.push(c);
			viewByType.set(c.actionType, list);
		}

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
				const onResolved = (path: string) => {
					this.viewCandidates = this.viewCandidates.filter(c => c.path !== path);
					void this.refresh();
				};
				const onCandidatesChanged = (released: string[], deferred: string[]) => {
					const releasedSet = new Set(released);
					const deferredSet = new Set(deferred);
					for (const c of this.viewCandidates) {
						if (releasedSet.has(c.path)) c.isDeferred = false;
						if (deferredSet.has(c.path)) c.isDeferred = true;
					}
					void this.refresh();
				};
				new PendingListModal(
					this.app, candidates, row.type, this.manager, this.ctx, onResolved, onCandidatesChanged,
				).open();
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
