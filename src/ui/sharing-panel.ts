/**
 * Single consolidated sidebar panel ("Sharing status") that merges the former
 * log view and sharing-status view into one leaf, so the plugin contributes
 * just one icon to the right sidebar (see GitHub issue #12).
 *
 * Two stacked sections, each with its own header toolbar so controls sit next
 * to the content they act on (no single undifferentiated ribbon):
 *
 * 1. **Sharing section** (top ~half) — a header with the share controls
 *    (pause/resume, refresh plan), then one status line (Running / Paused /
 *    Idle till HH:MM:SS + pending/deferred counts) and the per-operation pending
 *    table. Table rows are clickable (opening {@link PendingListModal}) only
 *    while paused.
 * 2. **Log section** (bottom ~half) — a header with the log controls (severity
 *    dropdown, clear, copy), then a scrollable view of the {@link Logger}'s
 *    in-memory ring buffer, oldest-first.
 *
 * A draggable splitter separates the two sections; the user can resize them
 * (drag, or Up/Down when focused) within a 20–80% range so neither collapses.
 * On mobile each section's toolbar drops to the bottom of its section, staying
 * clear of the notification area.
 *
 * The panel re-renders reactively: {@link Logger.setAppendCallback} drives it on
 * every new log line, and `main.ts` wires {@link CandidateStore}, the
 * {@link sync/sync-activity!SyncActivity} stream, and the scheduler's next-run
 * notification to {@link SharingPanelView.refresh}. All display state is read
 * live from those sources — no in-memory snapshot is held here.
 *
 * @packageDocumentation
 */
import {
	ItemView,
	WorkspaceLeaf,
	DropdownComponent,
	ExtraButtonComponent,
	Platform,
} from 'obsidian';
import type { Candidate, SyncActionType, SyncContext } from '../sync/types';
import type { CandidateStore } from '../sync/candidate-store';
import type { BulkSync } from '../sync/bulk-sync';
import type { Logger, LogEntry, LogSeverity } from '../logger';
import { ConfirmationModal } from './confirmation-modal';
import { PendingListModal } from './pending-list-modal';

/**
 * Workspace view-type identifier registered with Obsidian.
 *
 * Intentionally unchanged from the former sharing-status view so existing saved
 * workspace layouts and the `open-sharing-status` / `open-log-panel` command
 * IDs continue to resolve to this consolidated panel.
 */
export const SHARING_STATUS_VIEW_TYPE = 'vault-share-sharing-status';

/** Dropdown options, in ascending severity order. */
const SEVERITY_OPTIONS: Record<LogSeverity, string> = {
	DEBUG: 'Debug',
	INFO: 'Info',
	WARNING: 'Warning',
	ERROR: 'Error',
};

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
 * Consolidated sidebar panel for inspecting and controlling sharing.
 *
 * Combines the log buffer and the sharing-status controls/table in one leaf.
 * Renders synchronously from {@link CandidateStore.isPausedSync},
 * {@link CandidateStore.getAll}, {@link sync/sync-activity!SyncActivity}, the
 * {@link Logger} buffer, and the scheduler's next-run getter, so frequent log
 * appends re-render cheaply without awaiting IndexedDB.
 */
export class SharingPanelView extends ItemView {
	private isRefreshing = false;
	/** Scrollable list element holding the log rows; built in {@link onOpen}. */
	private logEl: HTMLElement | null = null;
	/** Log-level dropdown; kept so {@link refresh} can re-sync its value. */
	private severityDropdown: DropdownComponent | null = null;
	/** Container for the status line + pending table; rebuilt by {@link refresh}. */
	private statusEl: HTMLElement | null = null;
	/** Panel root (`containerEl.children[1]`); carries the `--vault-share-split` var. */
	private rootEl: HTMLElement | null = null;
	/** Draggable divider between the two sections; kept for aria/clamp updates. */
	private splitterEl: HTMLElement | null = null;
	/** Whether a splitter drag is in progress. */
	private dragging = false;
	/** Status-section height fraction (0.2–0.8); the log section takes the rest. */
	private split = 0.5;

	/** Splitter travel limits: neither section can shrink past 20% or grow past 80%. */
	private static readonly MIN_SPLIT = 0.2;
	private static readonly MAX_SPLIT = 0.8;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly candidateStore: CandidateStore,
		private readonly bulkSync: BulkSync,
		private readonly ctx: SyncContext,
		private readonly logger: Logger,
		private readonly getSeverity: () => LogSeverity,
		private readonly setSeverity: (severity: LogSeverity) => void,
		private readonly getNextSyncAt: () => number,
	) {
		super(leaf);
		logger.setAppendCallback(() => this.refresh());
	}

	getViewType(): string { return SHARING_STATUS_VIEW_TYPE; }
	getDisplayText(): string { return 'Sharing status'; }
	getIcon(): string { return 'alert-triangle'; }

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1] as HTMLElement | undefined;
		if (!root) return;

		root.empty();
		root.addClass('vault-share-sharing-panel');
		// Drops each section's toolbar to the bottom on mobile (CSS keys off this).
		root.toggleClass('is-mobile', Platform.isMobile);
		this.rootEl = root;

		this.buildStatusSection(root);
		this.buildSplitter(root);
		this.buildLogSection(root);
		// Apply the current split (default 50/50, or last value on re-open).
		this.setSplit(this.split);

		// Only enumerate candidates if sharing is already paused; while running
		// the candidate list is a moving target and won't be displayed anyway.
		if (await this.candidateStore.isPaused()) {
			await this.bulkSync.planOnly();
		}
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.logger.setAppendCallback(() => {});
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
		this.logEl = null;
		this.severityDropdown = null;
		this.statusEl = null;
		this.rootEl = null;
		this.splitterEl = null;
		this.dragging = false;
	}

	/**
	 * Re-render the live regions (log, status line, pending table) from current
	 * state. Synchronous so it can run on every log append without awaiting IDB;
	 * paused state is read from the {@link CandidateStore.isPausedSync} cache.
	 */
	refresh(): void {
		this.renderLog();
		this.renderStatus();
	}

	// ── Sharing section (status + share controls) ─────────────────────────────

	/**
	 * Build the sharing section: a header carrying the share controls
	 * (pause/resume, refresh), then the live status block. The control slot is
	 * filled — and refilled on state change — by {@link renderShareControls} so
	 * the icons/enabled state track the paused flag.
	 */
	private buildStatusSection(root: HTMLElement): void {
		const section = root.createDiv({ cls: 'vault-share-panel-section vault-share-panel-section-status' });
		const header = section.createDiv({ cls: 'vault-share-panel-section-header' });
		header.createSpan({ cls: 'vault-share-panel-section-title', text: 'Sharing' });
		header.createDiv({ cls: 'vault-share-panel-section-controls vault-share-panel-share-controls' });
		this.statusEl = section.createDiv({ cls: 'vault-share-panel-status' });
	}

	// ── Splitter (draggable divider between the two sections) ──────────────────

	/**
	 * Build the draggable divider between the sharing and log sections. Dragging
	 * (or Up/Down when focused) resizes the two sections; travel is clamped to
	 * {@link MIN_SPLIT}–{@link MAX_SPLIT} so neither section can collapse to 0 or
	 * grow to fill the panel.
	 */
	private buildSplitter(root: HTMLElement): void {
		const splitter = root.createDiv({ cls: 'vault-share-panel-splitter' });
		this.splitterEl = splitter;
		splitter.setAttribute('role', 'separator');
		splitter.setAttribute('aria-orientation', 'horizontal');
		splitter.setAttribute('aria-label', 'Resize sharing and log sections');
		splitter.setAttribute('aria-valuemin', String(Math.round(SharingPanelView.MIN_SPLIT * 100)));
		splitter.setAttribute('aria-valuemax', String(Math.round(SharingPanelView.MAX_SPLIT * 100)));
		splitter.tabIndex = 0;

		this.registerDomEvent(splitter, 'pointerdown', (evt: PointerEvent) => {
			evt.preventDefault();
			this.dragging = true;
			splitter.setPointerCapture(evt.pointerId);
		});
		this.registerDomEvent(splitter, 'pointermove', (evt: PointerEvent) => {
			if (!this.dragging || !this.rootEl) return;
			const rect = this.rootEl.getBoundingClientRect();
			if (rect.height === 0) return;
			this.setSplit((evt.clientY - rect.top) / rect.height);
		});
		const endDrag = (evt: PointerEvent) => {
			if (!this.dragging) return;
			this.dragging = false;
			if (splitter.hasPointerCapture(evt.pointerId)) splitter.releasePointerCapture(evt.pointerId);
		};
		this.registerDomEvent(splitter, 'pointerup', endDrag);
		this.registerDomEvent(splitter, 'pointercancel', endDrag);

		this.registerDomEvent(splitter, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'ArrowUp') { this.setSplit(this.split - 0.05); evt.preventDefault(); }
			else if (evt.key === 'ArrowDown') { this.setSplit(this.split + 0.05); evt.preventDefault(); }
		});
	}

	/**
	 * Set the status-section height fraction, clamped to the 20–80% travel range,
	 * and publish it as the `--vault-share-split` CSS variable the section
	 * flex-grow values read.
	 */
	private setSplit(fraction: number): void {
		const clamped = Math.min(
			SharingPanelView.MAX_SPLIT,
			Math.max(SharingPanelView.MIN_SPLIT, fraction),
		);
		this.split = clamped;
		this.rootEl?.style.setProperty('--vault-share-split', String(clamped));
		this.splitterEl?.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
	}

	/** Rebuild the pause/resume + refresh controls to match the paused state. */
	private renderShareControls(paused: boolean): void {
		const slot = this.containerEl.querySelector('.vault-share-panel-share-controls');
		if (!(slot instanceof HTMLElement)) return;
		slot.empty();

		new ExtraButtonComponent(slot)
			.setIcon(paused ? 'play' : 'pause')
			.setTooltip(paused ? 'Resume sharing' : 'Pause sharing')
			.onClick(() => {
				const willPause = !paused;
				void this.candidateStore.setPaused(willPause).then(async () => {
					// Collect candidates as soon as we pause so the table populates immediately.
					if (willPause) await this.bulkSync.planOnly();
					this.refresh();
				});
			});

		// Refresh re-enumerates via planOnly. Only useful while paused — a running
		// pass keeps the counts live on its own — so it is disabled otherwise.
		const refresh = new ExtraButtonComponent(slot)
			.setIcon('refresh-cw')
			.setTooltip('Refresh sharing plan')
			.onClick(() => {
				if (!paused || this.isRefreshing) return;
				this.isRefreshing = true;
				this.refresh();
				void this.bulkSync.planOnly().then(() => {
					this.isRefreshing = false;
					this.refresh();
				});
			});
		refresh.setDisabled(!paused || this.isRefreshing);
	}

	// ── Log section (log list + log controls) ─────────────────────────────────

	/**
	 * Build the log section: a header carrying the log controls (severity
	 * dropdown, clear, copy), then the scrollable list.
	 */
	private buildLogSection(root: HTMLElement): void {
		const section = root.createDiv({ cls: 'vault-share-panel-section vault-share-panel-section-log' });
		const header = section.createDiv({ cls: 'vault-share-panel-section-header' });
		header.createSpan({ cls: 'vault-share-panel-section-title', text: 'Log' });
		const controls = header.createDiv({ cls: 'vault-share-panel-section-controls' });

		this.severityDropdown = new DropdownComponent(controls)
			.addOptions(SEVERITY_OPTIONS)
			.setValue(this.getSeverity())
			.onChange(value => { this.setSeverity(value as LogSeverity); });
		this.severityDropdown.selectEl.setAttribute('aria-label', 'Log level');

		new ExtraButtonComponent(controls)
			.setIcon('trash')
			.setTooltip('Clear log')
			.onClick(() => { this.logger.clear(); });
		new ExtraButtonComponent(controls)
			.setIcon('copy')
			.setTooltip('Copy log to clipboard')
			.onClick(() => { this.copyToClipboard(); });

		this.buildLogList(section);
	}

	private buildLogList(section: HTMLElement): void {
		const logEl = section.createDiv({ cls: 'vault-share-log-container' });
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
	}

	private renderLog(): void {
		// Keep the dropdown in sync if the severity was changed elsewhere
		// (e.g. the settings tab) while the panel is open.
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

	// ── Status region ─────────────────────────────────────────────────────────

	/** Re-render the share controls, status line, and pending table. */
	private renderStatus(): void {
		const paused = this.candidateStore.isPausedSync();
		this.renderShareControls(paused);

		const container = this.statusEl;
		if (!container) return;
		container.empty();

		const activity = this.ctx.activity.getSnapshot();
		const allCandidates = this.candidateStore.getAll().filter(c => c.state !== 'Synced');
		const totalCount = allCandidates.length;
		const deferred = allCandidates.filter(c => c.state === 'Deferred').length;
		const pending = totalCount - deferred;

		// One status line: Paused (user flag) takes precedence; otherwise Running
		// reflects an in-flight pass and Idle is the enabled-but-waiting state, with
		// the next scheduled pass time when known.
		const stateText = paused
			? 'Paused'
			: activity.bulkRunning
				? 'Running'
				: `Idle${this.formatNextRun()}`;
		const line = container.createDiv({ cls: 'vault-share-sharing-status-activity' });
		line.createSpan({ cls: 'vault-share-sharing-status-activity-label', text: 'Sharing: ' });
		line.createSpan({ text: `${stateText}, pending files: ${pending}, deferred: ${deferred}` });

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
			const rowPending = candidates.filter(c => c.state !== 'Deferred').length;
			const rowDeferred = candidates.length - rowPending;

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
			tr.createEl('td', { text: String(rowPending) });
			tr.createEl('td', { text: String(rowDeferred) });

			if (paused) {
				tr.addEventListener('click', () => {
					new PendingListModal(
						this.app, row.type, this.candidateStore, this.ctx,
						() => { this.refresh(); },
					).open();
				});
			}
		}
	}

	/**
	 * Format the " till HH:MM:SS" suffix for the Idle status line from the
	 * scheduler's next-run time. Empty string when the next pass is due now or
	 * unknown (`0`), so the line reads just "Idle".
	 */
	private formatNextRun(): string {
		const at = this.getNextSyncAt();
		if (!at || at <= Date.now()) return '';
		const timeStr = new Date(at).toLocaleTimeString(undefined, { hour12: false });
		return ` till ${timeStr}`;
	}
}

function formatEntry(entry: LogEntry): string {
	const ts = new Date(entry.timestamp);
	const timeStr = ts.toLocaleTimeString(undefined, { hour12: false });
	const line = `${timeStr} [${entry.severity}] ${entry.message}`;
	return entry.detail ? `${line}\n  ${entry.detail}` : line;
}
