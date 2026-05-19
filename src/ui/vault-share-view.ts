import { App, ItemView, Modal, WorkspaceLeaf } from 'obsidian';
import { ConfirmationModal } from './confirmation-modal';
import type VaultSharePlugin from '../main';
import type { SyncPreviewResult } from '../sync/types';

export const VAULT_SHARING_VIEW_TYPE = 'vault-share-view';

/**
 * Instrumentation view for Vault Share.
 * Shows cumulative statistics and a live preview of what the next bulk sync
 * would do. Opens in the right-hand sidebar via the "Open Vault Sharing view"
 * command; displays side-by-side columns when the pane is wide enough.
 */
export class VaultShareView extends ItemView {
	private preview: SyncPreviewResult | null = null;
	private previewLoading = false;
	private previewError: string | null = null;

	/** Container elements kept for targeted re-renders. */
	private statsSection!: HTMLElement;
	private previewSection!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: VaultSharePlugin,
	) {
		super(leaf);
	}

	getViewType(): string { return VAULT_SHARING_VIEW_TYPE; }
	getDisplayText(): string { return 'Vault share'; }
	getIcon(): string { return 'bar-chart'; }

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('vs-view-root');

		const grid = root.createDiv({ cls: 'vs-grid' });
		this.statsSection = grid.createEl('section', { cls: 'vs-section' });
		this.previewSection = grid.createEl('section', { cls: 'vs-section' });

		this.renderStats();
		this.renderPreview();

		// Auto-fetch preview only when flagged (e.g. after too-many-changes auto-pause).
		if (this.plugin.sharePreviewPending) {
			this.plugin.sharePreviewPending = false;
			void this.refreshPreview();
		}
	}

	async onClose(): Promise<void> {
		if (this.plugin.scheduler?.getStatus() === 'paused') {
			const unpause = await ConfirmationModal.prompt(
				this.app,
				'Sharing is paused',
				'Bulk sharing is currently paused. Resume sharing before closing?',
				{ ok: 'Resume sharing', cancel: 'Leave paused' },
			);
			if (unpause) {
				this.plugin.scheduler.setPaused(false);
				this.plugin.scheduler.triggerBulkSync();
			}
		}
		this.containerEl.children[1]?.empty();
	}

	// --- External notification hooks ---

	/** Called by BulkSync immediately after planning, before any actions execute. */
	onBulkSyncPlanComplete(preview: SyncPreviewResult): void {
		this.preview = preview;
		this.previewError = null;
		this.renderPreview();
	}

	/** Called by SyncScheduler when paused/running/enabled state changes. */
	onStatusChange(): void {
		this.renderPreview();
	}

	// --- Stats section ---

	private renderStats(): void {
		const sec = this.statsSection;
		sec.empty();

		const heading = sec.createDiv({ cls: 'vs-section-heading' });
		heading.createSpan({ text: 'Statistics', cls: 'vs-heading-text' });
		heading.createDiv({ cls: 'vs-heading-btns' })
			.createEl('button', { text: 'Refresh', cls: 'vs-btn' })
			.addEventListener('click', () => { this.renderStats(); });

		const body = sec.createDiv({ cls: 'vs-section-body' });

		const stats = this.plugin.statsTracker?.getCurrent();

		// "Last reset: timestamp  [Reset]" row — Reset lives here, not in heading.
		const resetAt = stats?.statsResetAt ?? 0;
		const resetRow = body.createDiv({ cls: 'vs-reset-line' });
		resetRow.createSpan({
			text: resetAt > 0 ? `Last reset: ${formatDatetime(resetAt)}` : 'Last reset: Never',
		});
		resetRow.createEl('button', { text: 'Reset', cls: 'vs-btn vs-btn-warning' })
			.addEventListener('click', () => {
				void (async () => {
					await this.plugin.statsTracker?.reset();
					this.renderStats();
				})();
			});

		if (!stats) {
			body.createDiv({ cls: 'vs-empty', text: 'Statistics unavailable.' });
			return;
		}

		const table = body.createEl('dl', { cls: 'vs-stat-table' });

		const row = (label: string, value: string | number): void => {
			table.createEl('dt', { text: label, cls: 'vs-stat-label' });
			table.createEl('dd', { text: String(value), cls: 'vs-stat-value' });
		};

		row('Server clock skew', `${stats.serverClockSkew} ms`);
		row('Api response time', `${stats.APIResponseTime} ms`);
		row('Bulk sharing passes', stats.bulkSyncPasses);
		row('Single file shares', stats.singleFileSyncCount);
		row('Files pushed', stats.filesPushed);
		row('Files pulled', stats.filesPulled);
		row('Files merged', stats.filesMerged);
		row('Content conflicts', stats.contentConflicts);
		row('Delete conflicts', stats.deleteConflicts);

		// Drive API sub-section
		const driveHeading = body.createDiv({ cls: 'vs-subheading', text: 'Drive Api calls' });
		void driveHeading;
		const driveTable = body.createEl('dl', { cls: 'vs-stat-table' });
		const drow = (label: string, value: number): void => {
			driveTable.createEl('dt', { text: label, cls: 'vs-stat-label' });
			driveTable.createEl('dd', { text: String(value), cls: 'vs-stat-value' });
		};
		drow('List children', stats.driveListChildren);
		drow('Get file', stats.driveGetFile);
		drow('Read file (text)', stats.driveReadFile);
		drow('Read file (binary)', stats.driveReadFileBinary);
		drow('Write file', stats.driveWriteFile);
		drow('Delete file', stats.driveDeleteFile);
		drow('Create folder', stats.driveCreateFolder);
		drow('Resolve folder', stats.driveResolveFolder);
		drow('Find folder', stats.driveFindFolder);
		drow('Find file', stats.driveFindFile);
	}

	// --- Preview section ---

	private renderPreview(): void {
		const sec = this.previewSection;
		sec.empty();

		const heading = sec.createDiv({ cls: 'vs-section-heading' });
		heading.createSpan({ text: 'Bulk sharing status', cls: 'vs-heading-text' });
		heading.createDiv({ cls: 'vs-heading-btns' })
			.createEl('button', { text: 'Refresh', cls: 'vs-btn' })
			.addEventListener('click', () => { void this.refreshPreview(); });

		const body = sec.createDiv({ cls: 'vs-section-body' });

		body.createSpan({
			cls: 'vs-collected-at',
			text: this.preview ? `Collected: ${formatDatetime(this.preview.collectedAt)}` : 'Click Refresh to compute.',
		});

		// Status row: badge on the left, Pause/Resume button pushed to the right.
		const status = this.plugin.scheduler?.getStatus() ?? 'enabled';
		const statusRow = body.createDiv({ cls: 'vs-status-row' });
		statusRow.createSpan({ text: 'Status: ' });
		statusRow.createSpan({
			text: status.charAt(0).toUpperCase() + status.slice(1),
			cls: `vs-status-badge vs-status-${status}`,
		});
		const isPaused = status === 'paused';
		statusRow.createEl('button', {
			text: isPaused ? 'Resume sharing' : 'Pause sharing',
			cls: 'vs-btn vs-status-action-btn',
		}).addEventListener('click', () => {
			if (isPaused) {
				this.plugin.scheduler?.setPaused(false);
				this.plugin.scheduler?.triggerBulkSync();
			} else {
				this.plugin.scheduler?.setPaused(true);
				this.plugin.scheduler?.abortCurrentPass();
			}
		});

		if (this.previewLoading) {
			body.createDiv({ cls: 'vs-loading', text: 'Computing…' });
			return;
		}

		if (this.previewError) {
			body.createDiv({ cls: 'vs-error', text: this.previewError });
		} else if (this.preview) {
			this.renderPreviewData(body, this.preview);
		}
	}

	private renderPreviewData(body: HTMLElement, p: SyncPreviewResult): void {
		const isPaused = this.plugin.scheduler?.getStatus() === 'paused';

		const subsection = (title: string): HTMLElement => {
			body.createDiv({ cls: 'vs-sub-heading', text: title });
			return body.createEl('dl', { cls: 'vs-stat-table' });
		};

		const row = (dl: HTMLElement, label: string, value: number): void => {
			dl.createEl('dt', { text: label, cls: 'vs-stat-label' });
			dl.createEl('dd', { text: String(value), cls: 'vs-stat-value' });
		};

		const reviewRow = (dl: HTMLElement, label: string, value: number, paths: string[]): void => {
			dl.createEl('dt', { text: label, cls: 'vs-stat-label' });
			const dd = dl.createEl('dd', { cls: 'vs-stat-value-cell' });
			dd.createSpan({ text: String(value), cls: 'vs-stat-value' });
			const btn = dd.createEl('button', { text: 'Review…', cls: 'vs-btn vs-review-btn' });
			if (!isPaused) {
				btn.setAttribute('disabled', 'true');
				btn.setAttribute('title', 'Pause sync to enable');
			} else {
				btn.addEventListener('click', () => {
					new ReviewModal(this.app, label, paths).open();
				});
			}
		};

		const group = subsection('Group vault');
		row(group, 'New files pushed', p.groupNew);
		row(group, 'Updated files pushed', p.groupUpdated);
		reviewRow(group, 'Deleted files', p.groupDeleted, p.groupDeletedPaths);

		const local = subsection('Local vault');
		row(local, 'New files pulled', p.localNew);
		row(local, 'Updated files pulled', p.localUpdated);
		reviewRow(local, 'Deleted files', p.localDeleted, p.localDeletedPaths);
		reviewRow(local, 'Content conflicts', p.contentConflicts, p.contentConflictPaths);
		reviewRow(local, 'Delete conflicts', p.deleteConflicts, p.deleteConflictPaths);
		reviewRow(local, 'Text files to merge', p.textMergeFiles, p.textMergeFilePaths);
	}

	// --- Refresh actions ---

	private async refreshPreview(): Promise<void> {
		if (!this.plugin.sharePreview) return;
		this.previewLoading = true;
		this.previewError = null;
		this.renderPreview();
		try {
			this.preview = await this.plugin.sharePreview.compute();
		} catch (err) {
			this.previewError = err instanceof Error ? err.message : String(err);
		} finally {
			this.previewLoading = false;
		}
		this.renderPreview();
	}
}

/** Read-only modal listing the files in a preview category. */
class ReviewModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly paths: string[],
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: this.heading });

		if (this.paths.length === 0) {
			contentEl.createDiv({ cls: 'vs-empty', text: 'No files in this category.' });
		} else {
			const list = contentEl.createEl('ul', { cls: 'vs-review-list' });
			for (const path of this.paths) {
				list.createEl('li', { text: path, cls: 'vs-review-list-item' });
			}
		}

		contentEl.createDiv({ cls: 'modal-button-container' })
			.createEl('button', { text: 'Close', cls: 'mod-cta' })
			.addEventListener('click', () => { this.close(); });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function formatDatetime(epochMs: number): string {
	return new Date(epochMs).toLocaleString(undefined, {
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
		hour12: false,
	});
}
