/**
 * Sidebar view that displays the {@link Logger}'s in-memory ring buffer.
 *
 * Renders oldest-first and re-renders on each append via the callback
 * registered with {@link Logger.setAppendCallback}. Opened automatically at
 * startup when `VaultShareSettings.logToSidebar` is enabled.
 *
 * The view owns an always-visible toolbar (copy log, clear log, and a log-level
 * dropdown) rendered as part of the view content rather than the leaf header, so
 * the controls show whether the view is docked in the sidebar or popped out into
 * its own window. The dropdown edits the same `logSeverity` setting the
 * {@link Logger} filters on, via the `getSeverity` / `setSeverity` callbacks.
 *
 * @packageDocumentation
 */
import { ItemView, WorkspaceLeaf, DropdownComponent, ExtraButtonComponent } from 'obsidian';
import type { Logger, LogEntry, LogSeverity } from '../logger';

/** Workspace view-type identifier registered with Obsidian. */
export const SYNC_LOG_VIEW_TYPE = 'vault-share-log';

/** Dropdown options, in ascending severity order. */
const SEVERITY_OPTIONS: Record<LogSeverity, string> = {
	DEBUG: 'Debug',
	INFO: 'Info',
	WARNING: 'Warning',
	ERROR: 'Error',
};

/**
 * Sidebar leaf that renders the in-memory log ring buffer.
 * Refreshes whenever the Logger appends a new entry.
 */
export class SyncLogView extends ItemView {
	/** Scrollable list element holding the log rows; built in {@link onOpen}. */
	private logEl: HTMLElement | null = null;
	/** Log-level dropdown; kept so {@link refresh} can re-sync its value. */
	private severityDropdown: DropdownComponent | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly logger: Logger,
		private readonly getSeverity: () => LogSeverity,
		private readonly setSeverity: (severity: LogSeverity) => void,
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
		const root = this.containerEl.children[1] as HTMLElement | undefined;
		if (!root) return;

		root.empty();
		root.addClass('vault-share-log-view');

		// ── Toolbar (always visible, docked or popped out) ──────────────────
		// Rendered in the view body rather than via this.addAction(): header
		// actions are hidden when the leaf is docked in a narrow sidebar, so the
		// copy/clear controls would only appear in a popout window.
		const toolbar = root.createDiv({ cls: 'vault-share-log-toolbar' });

		const actions = toolbar.createDiv({ cls: 'vault-share-log-toolbar-actions' });
		new ExtraButtonComponent(actions)
			.setIcon('copy')
			.setTooltip('Copy log to clipboard')
			.onClick(() => { this.copyToClipboard(); });
		new ExtraButtonComponent(actions)
			.setIcon('trash')
			.setTooltip('Clear log')
			.onClick(() => { this.logger.clear(); });

		// Log-level dropdown, top-right. Edits the shared logSeverity setting the
		// Logger filters on, so changing it takes effect on the next log line.
		this.severityDropdown = new DropdownComponent(toolbar)
			.addOptions(SEVERITY_OPTIONS)
			.setValue(this.getSeverity())
			.onChange(value => { this.setSeverity(value as LogSeverity); });
		this.severityDropdown.selectEl.setAttribute('aria-label', 'Log level');

		// ── Scrollable log list ─────────────────────────────────────────────
		const logEl = root.createDiv({ cls: 'vault-share-log-container' });
		this.logEl = logEl;

		// Must be focusable to receive keyboard events when docked in the sidebar.
		logEl.tabIndex = 0;

		// Steal keyboard focus on click so Ctrl+A goes to us, not the editor.
		this.registerDomEvent(logEl, 'mousedown', () => {
			logEl.focus({ preventScroll: true });
		});

		this.registerDomEvent(logEl, 'keydown', (evt: KeyboardEvent) => {
			if ((evt.ctrlKey || evt.metaKey) && evt.key === 'a') {
				evt.preventDefault();
				evt.stopImmediatePropagation();
				const sel = activeDocument.getSelection();
				if (!sel) return;
				const range = activeDocument.createRange();
				range.selectNodeContents(logEl);
				sel.removeAllRanges();
				sel.addRange(range);
			}
		});

		this.refresh();
	}

	async onClose(): Promise<void> {
		this.logger.setAppendCallback(() => {});
		this.containerEl.empty();
		this.logEl = null;
		this.severityDropdown = null;
		this.onViewClose?.();
	}

	refresh(): void {
		// Keep the dropdown in sync if the severity was changed elsewhere
		// (e.g. the settings tab) while the view is open.
		this.severityDropdown?.setValue(this.getSeverity());

		const logEl = this.logEl;
		if (!logEl) return;

		logEl.empty();

		for (const entry of this.logger.getEntries()) {
			const row = logEl.createDiv({ cls: `vault-share-log-entry vault-share-log-${entry.severity.toLowerCase()}` });

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
		logEl.scrollTop = logEl.scrollHeight;
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
