import { ItemView, WorkspaceLeaf } from 'obsidian';
import type VaultSharePlugin from '../main';
import type { SyncPreviewResult } from '../sync/types';

export const VAULT_SHARING_VIEW_TYPE = 'vault-share-view';

/**
 * Instrumentation view for Vault Share.
 * Shows cumulative statistics and a live preview of what the next bulk sync
 * would do. Opens in the right-hand sidebar via the "Open Vault Sharing view"
 * command; collapses to headings in narrow mode, side-by-side in wide mode.
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
	getDisplayText(): string { return 'Vault shareing'; }
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

		// Kick off the initial preview computation without blocking onOpen.
		void this.refreshPreview();
	}

	async onClose(): Promise<void> {
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
		this.renderPreviewStatusRow();
	}

	// --- Stats section ---

	private renderStats(): void {
		const sec = this.statsSection;
		sec.empty();

		const heading = sec.createDiv({ cls: 'vs-section-heading' });
		this.makeCollapseToggle(heading, sec, 'vs-stats-collapsed');

		const titleSpan = heading.createSpan({ text: 'Statistics', cls: 'vs-heading-text' });
		// In wide mode the buttons sit in the heading row; in narrow they stack below.
		const btnRow = heading.createDiv({ cls: 'vs-heading-btns' });
		btnRow.createEl('button', { text: 'Refresh', cls: 'vs-btn' }).addEventListener('click', () => {
			this.renderStats();
		});
		btnRow.createEl('button', { text: 'Reset', cls: 'vs-btn vs-btn-warning' }).addEventListener('click', () => {
			void (async () => {
				await this.plugin.statsTracker?.reset();
				this.renderStats();
			})();
		});
		// Suppress unused-var lint — titleSpan is created for DOM side-effect only.
		void titleSpan;

		const body = sec.createDiv({ cls: 'vs-section-body' });

		const stats = this.plugin.statsTracker?.getCurrent();

		const resetAt = stats?.statsResetAt ?? 0;
		body.createDiv({
			cls: 'vs-reset-line',
			text: resetAt > 0
				? `Last reset: ${formatDatetime(resetAt)}`
				: 'Last reset: Never',
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
		this.makeCollapseToggle(heading, sec, 'vs-preview-collapsed');
		heading.createSpan({ text: 'Sharing status', cls: 'vs-heading-text' });

		const body = sec.createDiv({ cls: 'vs-section-body' });

		// Status row (always rendered; updated in-place by onStatusChange)
		this.renderPreviewStatusRow();

		if (this.previewLoading) {
			body.createDiv({ cls: 'vs-loading', text: 'Computing…' });
			return;
		}

		body.createDiv({ cls: 'vs-next-label', text: 'Next bulk share will:' });

		if (this.previewError) {
			body.createDiv({ cls: 'vs-error', text: this.previewError });
		} else if (!this.preview) {
			body.createDiv({ cls: 'vs-empty', text: 'Click Refresh to compute.' });
		} else {
			this.renderPreviewData(body, this.preview);
		}

		// Footer
		const footer = body.createDiv({ cls: 'vs-preview-footer' });
		if (this.preview) {
			footer.createSpan({
				cls: 'vs-collected-at',
				text: `Collected: ${formatDatetime(this.preview.collectedAt)}`,
			});
		}
		footer.createEl('button', { text: 'Refresh', cls: 'vs-btn' })
			.addEventListener('click', () => { void this.refreshPreview(); });
	}

	private renderPreviewStatusRow(): void {
		// Remove any existing status row and rebuild it in the section body.
		const body = this.previewSection.querySelector('.vs-section-body');
		if (!body) return;

		const existing = body.querySelector('.vs-status-row');
		existing?.remove();

		const status = this.plugin.scheduler?.getStatus() ?? 'enabled';
		const statusRow = createDiv({ cls: 'vs-status-row' });
		statusRow.createSpan({ text: 'Status: ' });
		statusRow.createSpan({
			text: status.charAt(0).toUpperCase() + status.slice(1),
			cls: `vs-status-badge vs-status-${status}`,
		});

		const isPaused = status === 'paused';
		const btn = statusRow.createEl('button', {
			text: isPaused ? 'Resume sharing' : 'Pause sharing',
			cls: 'vs-btn',
		});
		btn.addEventListener('click', () => {
			if (isPaused) {
				this.plugin.scheduler?.setPaused(false);
				this.plugin.scheduler?.triggerBulkSync();
			} else {
				this.plugin.scheduler?.setPaused(true);
				this.plugin.scheduler?.abortCurrentPass();
			}
		});

		// Insert before the first child of the body so it leads the section.
		body.insertBefore(statusRow, body.firstChild);
	}

	private renderPreviewData(body: HTMLElement, p: SyncPreviewResult): void {
		const subsection = (title: string): HTMLElement => {
			body.createDiv({ cls: 'vs-sub-heading', text: title });
			return body.createEl('dl', { cls: 'vs-stat-table' });
		};

		const row = (dl: HTMLElement, label: string, value: number): void => {
			dl.createEl('dt', { text: label, cls: 'vs-stat-label' });
			dl.createEl('dd', { text: String(value), cls: 'vs-stat-value' });
		};

		const group = subsection('Group vault');
		row(group, 'New files', p.groupNew);
		row(group, 'Updated files', p.groupUpdated);
		row(group, 'Deleted files', p.groupDeleted);

		const local = subsection('Local vault');
		row(local, 'New files', p.localNew);
		row(local, 'Updated files', p.localUpdated);
		row(local, 'Deleted files', p.localDeleted);
		row(local, 'Content conflicts', p.contentConflicts);
		row(local, 'Delete conflicts', p.deleteConflicts);
		row(local, 'Text files to merge', p.textMergeFiles);
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

	// --- Collapse toggle ---

	/**
	 * Attach a ▼/▶ toggle to headingEl that hides/shows the section body.
	 * Collapse state is stored as a CSS class on the section element so the
	 * wide-mode stylesheet can override visibility via container query.
	 */
	private makeCollapseToggle(
		headingEl: HTMLElement,
		sectionEl: HTMLElement,
		collapsedClass: string,
	): void {
		const arrow = headingEl.createSpan({ cls: 'vs-collapse-arrow' });
		const isCollapsed = (): boolean => sectionEl.hasClass(collapsedClass);
		const update = (): void => { arrow.setText(isCollapsed() ? '▶' : '▼'); };
		update();
		arrow.addEventListener('click', () => {
			sectionEl.toggleClass(collapsedClass, !isCollapsed());
			update();
		});
	}
}

function formatDatetime(epochMs: number): string {
	return new Date(epochMs).toLocaleString(undefined, {
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
		hour12: false,
	});
}
