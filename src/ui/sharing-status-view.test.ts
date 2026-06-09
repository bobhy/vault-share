import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, type WorkspaceLeaf } from 'obsidian';
import { SharingStatusView, SHARING_STATUS_VIEW_TYPE } from './sharing-status-view';
import type { Candidate, SyncContext } from '../sync/types';
import type { CandidateStore } from '../sync/candidate-store';
import type { BulkSync } from '../sync/bulk-sync';

// The view constructs these on interaction; stub them so the test stays focused
// on the status panel and doesn't pull their dependency stacks.
const { promptMock } = vi.hoisted(() => ({ promptMock: vi.fn() }));
vi.mock('./pending-list-modal', () => ({
	// Regular function (not arrow) so it is constructable with `new`; returns an
	// object with `open` so the view's `.open()` call succeeds. Still a vi.fn, so
	// construction can be asserted.
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
	view: SharingStatusView;
	store: { isPaused: ReturnType<typeof vi.fn>; getAll: ReturnType<typeof vi.fn>; setPaused: ReturnType<typeof vi.fn> };
	bulkSync: { planOnly: ReturnType<typeof vi.fn> };
	snapshot: { bulkRunning: boolean; currentPath: string | null };
}

function makeView(opts: { paused?: boolean; candidates?: Candidate[]; bulkRunning?: boolean; currentPath?: string | null } = {}): Harness {
	const snapshot = { bulkRunning: opts.bulkRunning ?? false, currentPath: opts.currentPath ?? null };
	const store = {
		isPaused: vi.fn(() => Promise.resolve(opts.paused ?? false)),
		getAll: vi.fn(() => opts.candidates ?? []),
		setPaused: vi.fn(() => Promise.resolve()),
	};
	const bulkSync = { planOnly: vi.fn(() => Promise.resolve()) };
	const ctx = { activity: { getSnapshot: () => snapshot } } as unknown as SyncContext;
	const view = new SharingStatusView(
		makeLeaf(),
		store as unknown as CandidateStore,
		bulkSync as unknown as BulkSync,
		ctx,
	);
	return { view, store, bulkSync, snapshot };
}

/** The content area (children[1]) the view renders into. */
function content(view: SharingStatusView): HTMLElement {
	return view.containerEl.children[1] as HTMLElement;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('SharingStatusView — metadata', () => {
	it('reports its view type, display text, and icon', () => {
		const { view } = makeView();
		expect(view.getViewType()).toBe(SHARING_STATUS_VIEW_TYPE);
		expect(view.getDisplayText()).toBe('Sharing status');
		expect(view.getIcon()).toBe('alert-triangle');
	});
});

describe('SharingStatusView — onOpen', () => {
	it('plans only when already paused, then refreshes', async () => {
		const { view, bulkSync } = makeView({ paused: true });
		await view.onOpen();
		expect(bulkSync.planOnly).toHaveBeenCalledTimes(1);
		expect(content(view).querySelector('.vault-share-sharing-status-header')).not.toBeNull();
	});

	it('does not plan when not paused', async () => {
		const { view, bulkSync } = makeView({ paused: false });
		await view.onOpen();
		expect(bulkSync.planOnly).not.toHaveBeenCalled();
	});
});

describe('SharingStatusView — refresh status line + empty state', () => {
	it('shows the empty message when no candidates are waiting', async () => {
		const { view } = makeView({ paused: true, candidates: [] });
		await view.refresh();
		expect(content(view).querySelector('.vault-share-sharing-status-empty')?.textContent)
			.toBe('No files waiting for review.');
		expect(content(view).querySelector('table')).toBeNull();
	});

	it('summarises bulk state with pending and deferred counts', async () => {
		const candidates = [
			makeCandidate({ actionType: 'push', state: 'Default' }),
			makeCandidate({ actionType: 'push', state: 'Default' }),
			makeCandidate({ actionType: 'pull', state: 'Deferred' }),
		];
		const { view } = makeView({ paused: true, candidates });
		await view.refresh();
		const status = content(view).querySelector('.vault-share-sharing-status-activity')?.textContent;
		expect(status).toContain('Paused');
		expect(status).toContain('pending files: 2');
		expect(status).toContain('deferred: 1');
	});

	it('reports Running when a bulk pass is in flight and not paused', async () => {
		const { view } = makeView({ paused: false, bulkRunning: true, candidates: [makeCandidate({})] });
		await view.refresh();
		expect(content(view).querySelector('.vault-share-sharing-status-activity')?.textContent).toContain('Running');
	});

	it('renders the current file path from activity', async () => {
		const { view } = makeView({ paused: true, currentPath: 'folder/active.md', candidates: [makeCandidate({})] });
		await view.refresh();
		expect(content(view).querySelector('.vault-share-sharing-status-activity-path')?.textContent)
			.toBe('folder/active.md');
	});
});

describe('SharingStatusView — buttons', () => {
	it('labels the pause button "Pause sharing" when running and "Resume sharing" when paused', async () => {
		const running = makeView({ paused: false });
		await running.view.refresh();
		expect(content(running.view).querySelector('.vault-share-sharing-status-btn')?.textContent).toBe('Pause sharing');

		const paused = makeView({ paused: true });
		await paused.view.refresh();
		expect(content(paused.view).querySelector('.vault-share-sharing-status-btn')?.textContent).toBe('Resume sharing');
	});

	it('clicking pause sets paused and plans', async () => {
		const { view, store, bulkSync } = makeView({ paused: false });
		await view.refresh();
		const btn = content(view).querySelector('.vault-share-sharing-status-btn') as HTMLButtonElement;
		btn.click();
		await Promise.resolve(); await Promise.resolve();
		expect(store.setPaused).toHaveBeenCalledWith(true);
		expect(bulkSync.planOnly).toHaveBeenCalled();
	});

	it('disables Refresh unless paused', async () => {
		const running = makeView({ paused: false });
		await running.view.refresh();
		const btns = content(running.view).querySelectorAll('button.vault-share-sharing-status-btn');
		expect((btns[1] as HTMLButtonElement).disabled).toBe(true);

		const paused = makeView({ paused: true });
		await paused.view.refresh();
		const pbtns = content(paused.view).querySelectorAll('button.vault-share-sharing-status-btn');
		expect((pbtns[1] as HTMLButtonElement).disabled).toBe(false);
	});

	it('clicking Refresh re-plans via planOnly', async () => {
		const { view, bulkSync } = makeView({ paused: true });
		await view.refresh();
		const refresh = content(view).querySelectorAll('button.vault-share-sharing-status-btn')[1] as HTMLButtonElement;
		refresh.click();
		await Promise.resolve(); await Promise.resolve();
		expect(bulkSync.planOnly).toHaveBeenCalled();
	});
});

describe('SharingStatusView — count table', () => {
	it('renders one row per action type that has candidates, with pending/deferred counts', async () => {
		const candidates = [
			makeCandidate({ actionType: 'push', state: 'Default' }),
			makeCandidate({ actionType: 'push', state: 'Approved' }),
			makeCandidate({ actionType: 'pull', state: 'Deferred' }),
		];
		const { view } = makeView({ paused: true, candidates });
		await view.refresh();

		const rows = content(view).querySelectorAll('tbody tr');
		expect(rows.length).toBe(2); // push + pull (deleteRemote/deleteLocal/conflict absent)
		const pushCells = [...rows[0]!.querySelectorAll('td')].map(td => td.textContent);
		expect(pushCells).toEqual(['Group vault', 'Push local changes to group vault', '2', '0']);
		const pullCells = [...rows[1]!.querySelectorAll('td')].map(td => td.textContent);
		expect(pullCells).toEqual(['Local vault', 'Pull group vault changes to local', '0', '1']);
	});

	it('marks rows clickable and opens PendingListModal only while paused', async () => {
		const candidates = [makeCandidate({ actionType: 'push', state: 'Default' })];
		const { view } = makeView({ paused: true, candidates });
		await view.refresh();
		const row = content(view).querySelector('tbody tr') as HTMLElement;
		expect(row.classList.contains('is-clickable')).toBe(true);
		row.click();
		expect(PendingListModal).toHaveBeenCalledTimes(1);
	});

	it('the onChange callback handed to PendingListModal re-renders the view', async () => {
		const { view } = makeView({ paused: true, candidates: [makeCandidate({ actionType: 'push' })] });
		await view.refresh();
		const refreshSpy = vi.spyOn(view, 'refresh');
		(content(view).querySelector('tbody tr') as HTMLElement).click();

		// The 5th constructor arg is `() => { void this.refresh(); }`; invoke it.
		const onChange = vi.mocked(PendingListModal).mock.calls[0]![4];
		onChange();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it('rows are inert (not clickable, no modal) while running', async () => {
		const candidates = [makeCandidate({ actionType: 'push', state: 'Default' })];
		const { view } = makeView({ paused: false, candidates });
		await view.refresh();
		const row = content(view).querySelector('tbody tr') as HTMLElement;
		expect(row.classList.contains('is-clickable')).toBe(false);
		row.click();
		expect(PendingListModal).not.toHaveBeenCalled();
	});
});

describe('SharingStatusView — onClose', () => {
	it('empties the container and does not prompt when not paused', async () => {
		const { view } = makeView({ paused: false });
		await view.onClose();
		expect(view.containerEl.children.length).toBe(0);
		expect(promptMock).not.toHaveBeenCalled();
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
