import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { App } from 'obsidian';
import { SyncLogView } from './sync-log-view';
import { Logger } from '../logger';

function makeLeaf(): WorkspaceLeaf {
	return { app: new App() } as unknown as WorkspaceLeaf;
}

function makeLogger(): Logger {
	return new Logger(() => 'DEBUG', () => 100);
}

describe('SyncLogView', () => {
	let view: SyncLogView;
	let logger: Logger;

	beforeEach(() => {
		logger = makeLogger();
		view = new SyncLogView(makeLeaf(), logger);
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
		it('renders log entries in containerEl.children[1]', () => {
			logger.info('hello world');
			view.refresh();

			const container = view.containerEl.children[1] as HTMLElement;
			expect(container.children.length).toBe(1);
			const row = container.children[0] as HTMLElement;
			expect(row.classList.contains('vault-share-log-info')).toBe(true);
			expect(row.textContent).toContain('hello world');
			expect(row.textContent).toContain('[INFO]');
		});

		it('renders detail when present', () => {
			logger.error('something broke', 'stack trace here');
			view.refresh();

			const container = view.containerEl.children[1] as HTMLElement;
			const detail = container.querySelector('.vault-share-log-detail');
			expect(detail?.textContent).toBe('stack trace here');
		});

		it('renders multiple entries in order', () => {
			logger.info('first');
			logger.warning('second');
			view.refresh();

			const container = view.containerEl.children[1] as HTMLElement;
			expect(container.children.length).toBe(2);
			expect(container.children[0]!.textContent).toContain('first');
			expect(container.children[1]!.textContent).toContain('second');
		});

		it('clears previous entries on re-render', () => {
			logger.info('old');
			view.refresh();
			logger.clear();
			logger.info('new');
			view.refresh();

			const container = view.containerEl.children[1] as HTMLElement;
			expect(container.children.length).toBe(1);
			expect(container.textContent).toContain('new');
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

		it('sets tabIndex on the content container', async () => {
			await view.onOpen();
			const container = view.containerEl.children[1] as HTMLElement;
			expect(container.tabIndex).toBe(0);
		});

		it('adds two action buttons', async () => {
			const addActionSpy = vi.spyOn(view, 'addAction');
			await view.onOpen();
			expect(addActionSpy).toHaveBeenCalledTimes(2);
			expect(addActionSpy).toHaveBeenCalledWith('copy', 'Copy log to clipboard', expect.any(Function));
			expect(addActionSpy).toHaveBeenCalledWith('trash', 'Clear log', expect.any(Function));
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
			logger.info('msg');
			view.refresh();
			await view.onClose();
			expect(view.containerEl.children.length).toBe(0);
		});

		it('calls onViewClose callback if provided', async () => {
			const onClose = vi.fn();
			const view2 = new SyncLogView(makeLeaf(), logger, onClose);
			await view2.onClose();
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not throw when onViewClose is not provided', async () => {
			await view.onClose();
		});
	});
});
