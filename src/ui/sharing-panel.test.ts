import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, type WorkspaceLeaf } from 'obsidian';
import { SharingPanelView, SHARING_STATUS_VIEW_TYPE } from './sharing-panel';
import { Logger, type LogSeverity } from '../logger';
import type { Candidate, SyncContext } from '../sync/types';
import type { CandidateStore } from '../sync/candidate-store';
import type { BulkSync } from '../sync/bulk-sync';

// Platform is not exported by the obsidian mock; provide it so the view's
// `Platform.isMobile` read in onOpen resolves. Everything else comes from the
// real mock so ItemView / DropdownComponent / ExtraButtonComponent behave.
vi.mock('obsidian', async () => {
	const mod = await vi.importActual<typeof import('obsidian')>('obsidian');
	return { ...mod, Platform: { isMobile: false } };
});

// Stubbed on interaction so the test stays focused on the panel and doesn't
// pull in the modal dependency stacks.
const { promptMock } = vi.hoisted(() => ({ promptMock: vi.fn() }));
vi.mock('./pending-list-modal', () => ({
	PendingListModal: vi.fn(function () { return { open: vi.fn() }; }),
}));
vi.mock('./confirmation-modal', () => ({
	ConfirmationModal: { prompt: promptMock },
}));
import { PendingListModal } from './pending-list-modal';

function makeLeaf(): WorkspaceLeaf {
	return { app: new App() } as unknown as WorkspaceLeaf;
}

function makeCandidate(partial: Partial<Candidate>): Candidate {
	return {
		path: 'f.md', state: 'Default', actionType: 'push',
		driveFileId: '', syncedLocalMtime: 0, syncedRemoteMtime: 0,
		syncedLocalSize: 0, syncedRemoteSize: 0, syncedAt: 0,
		deferredAt: 0, deferredLocalMtime: 0, deferredRemoteMtime: 0,
		...partial,
	};
}

interface Harness {
	view: SharingPanelView;
	store: {
		isPaused: ReturnType<typeof vi.fn>;
		isPausedSync: ReturnType<typeof vi.fn>;
		getAll: ReturnType<typeof vi.fn>;
		setPaused: ReturnType<typeof vi.fn>;
	};
	bulkSync: { planOnly: ReturnType<typeof vi.fn> };
	logger: Logger;
	severity: { value: LogSeverity };
	setSeverity: ReturnType<typeof vi.fn>;
	nextSyncAt: { value: number };
}

function makeView(opts: {
	paused?: boolean;
	candidates?: Candidate[];
	bulkRunning?: boolean;
	currentPath?: string | null;
	nextSyncAt?: number;
} = {}): Harness {
	const snapshot = { bulkRunning: opts.bulkRunning ?? false, currentPath: opts.currentPath ?? null };
	const store = {
		isPaused: vi.fn(() => Promise.resolve(opts.paused ?? false)),
		isPausedSync: vi.fn(() => opts.paused ?? false),
		getAll: vi.fn(() => opts.candidates ?? []),
		setPaused: vi.fn(() => Promise.resolve()),
	};
	const bulkSync = { planOnly: vi.fn(() => Promise.resolve()) };
	const ctx = { activity: { getSnapshot: () => snapshot } } as unknown as SyncContext;
	const logger = new Logger(() => 'DEBUG', () => 100);
	const severity = { value: 'DEBUG' as LogSeverity };
	const setSeverity = vi.fn((s: LogSeverity) => { severity.value = s; });
	const nextSyncAt = { value: opts.nextSyncAt ?? 0 };
	const view = new SharingPanelView(
		makeLeaf(),
		store as unknown as CandidateStore,
		bulkSync as unknown as BulkSync,
		ctx,
		logger,
		() => severity.value,
		setSeverity,
		() => nextSyncAt.value,
	);
	return { view, store, bulkSync, logger, severity, setSeverity, nextSyncAt };
}

/** The content area (children[1]) the view renders into. */
function content(view: SharingPanelView): HTMLElement {
	return view.containerEl.children[1] as HTMLElement;
}

/** Find a ribbon control by its tooltip (aria-label set by ExtraButtonComponent). */
function ribbonBtn(view: SharingPanelView, label: string): HTMLElement {
	return content(view).querySelector(`[aria-label="${label}"]`) as HTMLElement;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('SharingPanelView — metadata', () => {
	it('reports its view type, display text, and icon', () => {
		const { view } = makeView();
		expect(view.getViewType()).toBe(SHARING_STATUS_VIEW_TYPE);
		expect(view.getDisplayText()).toBe('Sharing status');
		expect(view.getIcon()).toBe('alert-triangle');
	});
});

describe('SharingPanelView — onOpen layout', () => {
	it('plans only when already paused, then renders the status and log sections', async () => {
		const { view, bulkSync } = makeView({ paused: true });
		await view.onOpen();
		expect(bulkSync.planOnly).toHaveBeenCalledTimes(1);
		expect(content(view).querySelector('.vault-share-panel-section-status')).not.toBeNull();
		expect(content(view).querySelector('.vault-share-panel-section-log')).not.toBeNull();
		expect(content(view).querySelector('.vault-share-panel-status')).not.toBeNull();
		expect(content(view).querySelector('.vault-share-log-container')).not.toBeNull();
	});

	it('does not plan when not paused', async () => {
		const { view, bulkSync } = makeView({ paused: false });
		await view.onOpen();
		expect(bulkSync.planOnly).not.toHaveBeenCalled();
	});

	it('groups controls by function: share controls in the status header, log controls in the log header', async () => {
		const { view } = makeView({ paused: false });
		await view.onOpen();

		// Share controls live in the status section header.
		const statusHeader = content(view).querySelector('.vault-share-panel-section-status .vault-share-panel-section-header') as HTMLElement;
		expect(statusHeader.querySelector('[aria-label="Pause sharing"]')).not.toBeNull();
		expect(statusHeader.querySelector('[aria-label="Refresh sharing plan"]')).not.toBeNull();

		// Log controls live in the log section header.
		const logHeader = content(view).querySelector('.vault-share-panel-section-log .vault-share-panel-section-header') as HTMLElement;
		expect(logHeader.querySelector('[aria-label="Clear log"]')).not.toBeNull();
		expect(logHeader.querySelector('[aria-label="Copy log to clipboard"]')).not.toBeNull();
		const select = logHeader.querySelector('select') as HTMLSelectElement;
		expect(select).not.toBeNull();
		expect(select.value).toBe('DEBUG');
	});
});

describe('SharingPanelView — log region', () => {
	it('renders log entries with severity class and detail', async () => {
		const { view, logger } = makeView();
		await view.onOpen();
		logger.error('something broke', 'stack here');

		const list = content(view).querySelector('.vault-share-log-container') as HTMLElement;
		const row = list.children[0] as HTMLElement;
		expect(row.classList.contains('vault-share-log-error')).toBe(true);
		expect(row.textContent).toContain('something broke');
		expect(list.querySelector('.vault-share-log-detail')?.textContent).toBe('stack here');
	});

	it('re-renders on logger append', async () => {
		const { view, logger } = makeView();
		await view.onOpen();
		const spy = vi.spyOn(view, 'refresh');
		logger.info('trigger');
		expect(spy).toHaveBeenCalled();
	});

	it('clears the log when the clear control is clicked', async () => {
		const { view, logger } = makeView();
		await view.onOpen();
		logger.info('one');
		ribbonBtn(view, 'Clear log').click();
		const list = content(view).querySelector('.vault-share-log-container') as HTMLElement;
		expect(list.children.length).toBe(0);
	});

	it('changing the severity dropdown persists the new value', async () => {
		const { view, setSeverity, severity } = makeView();
		await view.onOpen();
		const select = content(view).querySelector('.vault-share-panel-section-log select') as HTMLSelectElement;
		select.value = 'WARNING';
		select.dispatchEvent(new Event('change'));
		expect(setSeverity).toHaveBeenCalledWith('WARNING');
		expect(severity.value).toBe('WARNING');
	});
});

describe('SharingPanelView — status line', () => {
	it('shows Paused with pending and deferred counts', async () => {
		const candidates = [
			makeCandidate({ actionType: 'push', state: 'Default' }),
			makeCandidate({ actionType: 'push', state: 'Default' }),
			makeCandidate({ actionType: 'pull', state: 'Deferred' }),
		];
		const { view } = makeView({ paused: true, candidates });
		await view.onOpen();
		const status = content(view).querySelector('.vault-share-sharing-status-activity')?.textContent;
		expect(status).toContain('Paused');
		expect(status).toContain('pending files: 2');
		expect(status).toContain('deferred: 1');
	});

	it('reports Running when a bulk pass is in flight and not paused', async () => {
		const { view } = makeView({ paused: false, bulkRunning: true, candidates: [makeCandidate({})] });
		await view.onOpen();
		expect(content(view).querySelector('.vault-share-sharing-status-activity')?.textContent).toContain('Running');
	});

	it('reports "Idle till HH:MM:SS" with the next scheduled run', async () => {
		const at = Date.now() + 3_600_000;
		const { view } = makeView({ paused: false, nextSyncAt: at });
		await view.onOpen();
		const expected = new Date(at).toLocaleTimeString(undefined, { hour12: false });
		const status = content(view).querySelector('.vault-share-sharing-status-activity')?.textContent;
		expect(status).toContain(`Idle till ${expected}`);
	});

	it('reports plain "Idle" when no future run time is known', async () => {
		const { view } = makeView({ paused: false, nextSyncAt: 0 });
		await view.onOpen();
		const status = content(view).querySelector('.vault-share-sharing-status-activity')?.textContent;
		expect(status).toContain('Idle,');
		expect(status).not.toContain('till');
	});
});

describe('SharingPanelView — pending table', () => {
	it('renders one row per action type with pending/deferred counts', async () => {
		const candidates = [
			makeCandidate({ actionType: 'push', state: 'Default' }),
			makeCandidate({ actionType: 'push', state: 'Approved' }),
			makeCandidate({ actionType: 'pull', state: 'Deferred' }),
		];
		const { view } = makeView({ paused: true, candidates });
		await view.onOpen();

		const rows = content(view).querySelectorAll('tbody tr');
		expect(rows.length).toBe(2);
		expect([...rows[0]!.querySelectorAll('td')].map(td => td.textContent))
			.toEqual(['Group vault', 'Push local changes to group vault', '2', '0']);
		expect([...rows[1]!.querySelectorAll('td')].map(td => td.textContent))
			.toEqual(['Local vault', 'Pull group vault changes to local', '0', '1']);
	});

	it('shows the empty message when nothing is waiting', async () => {
		const { view } = makeView({ paused: true, candidates: [] });
		await view.onOpen();
		expect(content(view).querySelector('.vault-share-sharing-status-empty')?.textContent)
			.toBe('No files waiting for review.');
		expect(content(view).querySelector('table')).toBeNull();
	});

	it('opens PendingListModal on row click only while paused', async () => {
		const { view } = makeView({ paused: true, candidates: [makeCandidate({ actionType: 'push' })] });
		await view.onOpen();
		const row = content(view).querySelector('tbody tr') as HTMLElement;
		expect(row.classList.contains('is-clickable')).toBe(true);
		row.click();
		expect(PendingListModal).toHaveBeenCalledTimes(1);
	});

	it('rows are inert (no modal) while running', async () => {
		const { view } = makeView({ paused: false, candidates: [makeCandidate({ actionType: 'push' })] });
		await view.onOpen();
		const row = content(view).querySelector('tbody tr') as HTMLElement;
		expect(row.classList.contains('is-clickable')).toBe(false);
		row.click();
		expect(PendingListModal).not.toHaveBeenCalled();
	});
});

describe('SharingPanelView — pause/refresh controls', () => {
	it('clicking pause sets paused and plans', async () => {
		const { view, store, bulkSync } = makeView({ paused: false });
		await view.onOpen();
		ribbonBtn(view, 'Pause sharing').click();
		await Promise.resolve(); await Promise.resolve();
		expect(store.setPaused).toHaveBeenCalledWith(true);
		expect(bulkSync.planOnly).toHaveBeenCalled();
	});

	it('refresh re-plans via planOnly while paused', async () => {
		const { view, bulkSync } = makeView({ paused: true });
		await view.onOpen();
		bulkSync.planOnly.mockClear();
		ribbonBtn(view, 'Refresh sharing plan').click();
		await Promise.resolve(); await Promise.resolve();
		expect(bulkSync.planOnly).toHaveBeenCalled();
	});

	it('refresh is disabled while not paused', async () => {
		const { view, bulkSync } = makeView({ paused: false });
		await view.onOpen();
		expect(ribbonBtn(view, 'Refresh sharing plan').classList.contains('is-disabled')).toBe(true);
		ribbonBtn(view, 'Refresh sharing plan').click();
		expect(bulkSync.planOnly).not.toHaveBeenCalled();
	});
});

describe('SharingPanelView — section splitter', () => {
	/**
	 * The ItemView mock's registerDomEvent is a no-op, so DOM dispatch won't fire
	 * handlers. Recover the keydown handler the view registered on the splitter and
	 * invoke it directly to exercise the resize/clamp logic.
	 */
	function splitterKeydown(view: SharingPanelView): (e: { key: string; preventDefault: () => void }) => void {
		const splitter = content(view).querySelector('.vault-share-panel-splitter');
		const reg = (view as unknown as { registerDomEvent: { mock: { calls: unknown[][] } } }).registerDomEvent;
		const call = reg.mock.calls.find(c => c[0] === splitter && c[1] === 'keydown');
		return call![2] as (e: { key: string; preventDefault: () => void }) => void;
	}

	function press(handler: (e: { key: string; preventDefault: () => void }) => void, key: string, times: number): void {
		for (let i = 0; i < times; i++) handler({ key, preventDefault: () => { /* noop */ } });
	}

	it('renders a separator divider defaulting to a 50/50 split', async () => {
		const { view } = makeView();
		await view.onOpen();
		const splitter = content(view).querySelector('.vault-share-panel-splitter') as HTMLElement;
		expect(splitter).not.toBeNull();
		expect(splitter.getAttribute('role')).toBe('separator');
		expect(splitter.getAttribute('aria-valuenow')).toBe('50');
		expect(content(view).style.getPropertyValue('--vault-share-split')).toBe('0.5');
	});

	it('does not let the user drag past 80% (status section cannot fill the panel)', async () => {
		const { view } = makeView();
		await view.onOpen();
		const handler = splitterKeydown(view);
		press(handler, 'ArrowDown', 20); // each press grows status by 5%
		const splitter = content(view).querySelector('.vault-share-panel-splitter') as HTMLElement;
		expect(splitter.getAttribute('aria-valuenow')).toBe('80');
		expect(content(view).style.getPropertyValue('--vault-share-split')).toBe('0.8');
	});

	it('does not let the user drag past 20% (status section cannot collapse)', async () => {
		const { view } = makeView();
		await view.onOpen();
		const handler = splitterKeydown(view);
		press(handler, 'ArrowUp', 20);
		const splitter = content(view).querySelector('.vault-share-panel-splitter') as HTMLElement;
		expect(splitter.getAttribute('aria-valuenow')).toBe('20');
		expect(content(view).style.getPropertyValue('--vault-share-split')).toBe('0.2');
	});
});

describe('SharingPanelView — onClose', () => {
	it('clears the logger callback and empties the container when not paused', async () => {
		const { view, logger } = makeView({ paused: false });
		await view.onOpen();
		await view.onClose();
		expect(view.containerEl.children.length).toBe(0);
		expect(promptMock).not.toHaveBeenCalled();
		// Callback detached: a later append must not throw against the emptied view.
		expect(() => logger.info('after close')).not.toThrow();
	});

	it('prompts to resume when paused and resumes on confirmation', async () => {
		promptMock.mockResolvedValue(true);
		const { view, store } = makeView({ paused: true });
		await view.onClose();
		expect(promptMock).toHaveBeenCalled();
		expect(store.setPaused).toHaveBeenCalledWith(false);
	});

	it('keeps paused when the user declines to resume', async () => {
		promptMock.mockResolvedValue(false);
		const { view, store } = makeView({ paused: true });
		await view.onClose();
		expect(store.setPaused).not.toHaveBeenCalled();
	});
});
