import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Logger } from '../logger';

export const SYNC_LOG_VIEW_TYPE = 'vault-share-log';

/**
 * Sidebar leaf that renders the in-memory log ring buffer.
 * Refreshes whenever the Logger appends a new entry.
 */
export class SyncLogView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly logger: Logger,
	) {
		super(leaf);
		logger.setAppendCallback(() => this.refresh());
	}

	getViewType(): string {
		return SYNC_LOG_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Vault share log';
	}

	getIcon(): string {
		return 'scroll';
	}

	async onOpen(): Promise<void> {
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.logger.setAppendCallback(() => {});
		this.containerEl.empty();
	}

	refresh(): void {
		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (!container) return;

		container.empty();
		container.addClass('vault-share-log-container');

		for (const entry of this.logger.getEntries()) {
			const row = container.createDiv({ cls: `vault-share-log-entry vault-share-log-${entry.severity.toLowerCase()}` });

			const ts = new Date(entry.timestamp);
			const timeStr = ts.toLocaleTimeString(undefined, { hour12: false });
			row.createSpan({ cls: 'vault-share-log-time', text: timeStr });
			row.createSpan({ cls: 'vault-share-log-severity', text: `[${entry.severity}]` });
			row.createSpan({ cls: 'vault-share-log-message', text: entry.message });

			if (entry.detail) {
				row.createDiv({ cls: 'vault-share-log-detail', text: entry.detail });
			}
		}

		// Scroll to bottom so newest entries are visible.
		container.scrollTop = container.scrollHeight;
	}
}
