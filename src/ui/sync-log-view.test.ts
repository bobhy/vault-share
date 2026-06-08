import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { App } from 'obsidian';
import { SyncLogView } from './sync-log-view';
import { Logger, type LogSeverity } from '../logger';

function makeLeaf(): WorkspaceLeaf {
	return { app: new App() } as unknown as WorkspaceLeaf;
}

function makeLogger(): Logger {
	return new Logger(() => 'DEBUG', () => 100);
}

/** The scrollable log list inside the view content (built by onOpen). */
function logList(view: SyncLogView): HTMLElement {
	const root = view.containerEl.children[1] as HTMLElement;
	return root.querySelector('.vault-share-log-container') as HTMLElement;
}

describe('SyncLogView', () => {
	let view: SyncLogView;
	let logger: Logger;
	let severity: LogSeverity;
	let setSeverity: ReturnType<typeof vi.fn<(s: LogSeverity) => void>>;

	beforeEach(() => {
		logger = makeLogger();
		severity = 'DEBUG';
		setSeverity = vi.fn<(s: LogSeverity) => void>(s => { severity = s; });
		view = new SyncLogView(makeLeaf(), logger, () => severity, setSeverity);
	});

	describe('metadata', () => {
		it('returns the correct view type', () => {
			expect(view.getViewType()).toBe('vault-share-log');
		});

		it('returns the correct display text', () => {
			expect(view.getDisplayText()).toBe('Vault share log');
		});

		it('returns the correct icon', () => {
			expect(view.getIcon()).toBe('scroll');
		});
	});

	describe('refresh()', () => {
		beforeEach(async () => {
			await view.onOpen();
		});

		it('renders log entries in the scrollable list', () => {
			logger.info('hello world');
			view.refresh();

			const list = logList(view);
			expect(list.children.length).toBe(1);
			const row = list.children[0] as HTMLElement;
			expect(row.classList.contains('vault-share-log-info')).toBe(true);
			expect(row.textContent).toContain('hello world');
			expect(row.textContent).toContain('[INFO]');
		});

		it('renders detail when present', () => {
			logger.error('something broke', 'stack trace here');
			view.refresh();

			const detail = logList(view).querySelector('.vault-share-log-detail');
			expect(detail?.textContent).toBe('stack trace here');
		});

		it('renders multiple entries in order', () => {
			logger.info('first');
			logger.warning('second');
			view.refresh();

			const list = logList(view);
			expect(list.children.length).toBe(2);
			expect(list.children[0]!.textContent).toContain('first');
			expect(list.children[1]!.textContent).toContain('second');
		});

		it('clears previous entries on re-render', () => {
			logger.info('old');
			view.refresh();
			logger.clear();
			logger.info('new');
			view.refresh();

			const list = logList(view);
			expect(list.children.length).toBe(1);
			expect(list.textContent).toContain('new');
		});
	});

	describe('logger append callback', () => {
		it('calls refresh() when logger appends an entry', () => {
			const refreshSpy = vi.spyOn(view, 'refresh');
			logger.info('trigger');
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('onOpen()', () => {
		it('calls refresh() on open', async () => {
			const refreshSpy = vi.spyOn(view, 'refresh');
			await view.onOpen();
			expect(refreshSpy).toHaveBeenCalled();
		});

		it('sets tabIndex on the scrollable list', async () => {
			await view.onOpen();
			expect(logList(view).tabIndex).toBe(0);
		});

		it('renders a toolbar with copy, clear, and a log-level dropdown', async () => {
			await view.onOpen();
			const root = view.containerEl.children[1] as HTMLElement;

			// Copy + clear render as two ExtraButtonComponent action elements.
			const actions = root.querySelectorAll('.vault-share-log-toolbar-actions .extra-settings-button');
			expect(actions.length).toBe(2);

			// Log-level dropdown reflects the current severity.
			const select = root.querySelector('.vault-share-log-toolbar select') as HTMLSelectElement;
			expect(select).not.toBeNull();
			expect(select.value).toBe('DEBUG');
		});

		it('changing the dropdown persists the new severity', async () => {
			await view.onOpen();
			const root = view.containerEl.children[1] as HTMLElement;
			const select = root.querySelector('.vault-share-log-toolbar select') as HTMLSelectElement;

			select.value = 'WARNING';
			select.dispatchEvent(new Event('change'));

			expect(setSeverity).toHaveBeenCalledWith('WARNING');
			expect(severity).toBe('WARNING');
		});
	});

	describe('onClose()', () => {
		it('clears the logger append callback', async () => {
			const callbackSpy = vi.fn();
			logger.setAppendCallback(callbackSpy);
			// onClose replaces callback with a no-op
			await view.onClose();
			logger.info('after close');
			expect(callbackSpy).not.toHaveBeenCalled();
		});

		it('empties the containerEl', async () => {
			await view.onOpen();
			logger.info('msg');
			await view.onClose();
			expect(view.containerEl.children.length).toBe(0);
		});

		it('closes cleanly without throwing', async () => {
			await view.onOpen();
			await view.onClose();
		});
	});
});
