import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { Logger, LogEntry } from '../logger';

export const SYNC_LOG_VIEW_TYPE = 'vault-share-log';

/**
 * Sidebar leaf that renders the in-memory log ring buffer.
 * Refreshes whenever the Logger appends a new entry.
 */
export class SyncLogView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly logger: Logger,
		private readonly onViewClose?: () => void,
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
		this.addAction('copy', 'Copy log to clipboard', () => { this.copyToClipboard(); });
		this.addAction('trash', 'Clear log', () => { this.logger.clear(); });

		const container = this.containerEl.children[1] as HTMLElement | undefined;
		if (container) {
			// Must be focusable to receive keyboard events when docked in the sidebar.
			container.tabIndex = 0;

			// Steal keyboard focus on click so Ctrl+A goes to us, not the editor.
			this.registerDomEvent(container, 'mousedown', () => {
				container.focus({ preventScroll: true });
			});

			this.registerDomEvent(container, 'keydown', (evt: KeyboardEvent) => {
				if ((evt.ctrlKey || evt.metaKey) && evt.key === 'a') {
					evt.preventDefault();
					evt.stopImmediatePropagation();
					const sel = activeDocument.getSelection();
					if (!sel) return;
					const range = activeDocument.createRange();
					range.selectNodeContents(container);
					sel.removeAllRanges();
					sel.addRange(range);
				}
			});
		}

		this.refresh();
	}

	async onClose(): Promise<void> {
		this.logger.setAppendCallback(() => {});
		this.containerEl.empty();
		this.onViewClose?.();
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
			row.createSpan({ cls: 'vault-share-log-time', text: timeStr + ' ' });
			row.createSpan({ cls: 'vault-share-log-severity', text: `[${entry.severity}] ` });
			row.createSpan({ cls: 'vault-share-log-message', text: entry.message });

			if (entry.detail) {
				row.createDiv({ cls: 'vault-share-log-detail', text: entry.detail });
			}
		}

		// Scroll to bottom so newest entries are visible.
		container.scrollTop = container.scrollHeight;
	}

	private copyToClipboard(): void {
		const lines: string[] = [];
		for (const entry of this.logger.getEntries()) {
			lines.push(formatEntry(entry));
		}
		void navigator.clipboard.writeText(lines.join('\n'));
	}
}

function formatEntry(entry: LogEntry): string {
	const ts = new Date(entry.timestamp);
	const timeStr = ts.toLocaleTimeString(undefined, { hour12: false });
	const line = `${timeStr} [${entry.severity}] ${entry.message}`;
	return entry.detail ? `${line}\n  ${entry.detail}` : line;
}
