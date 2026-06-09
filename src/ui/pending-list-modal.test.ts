import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, Notice } from 'obsidian';
import { PendingListModal } from './pending-list-modal';
import type { Candidate, SyncActionType, SyncContext } from '../sync/types';
import type { CandidateStore } from '../sync/candidate-store';
import { MARKER_OPEN } from '../sync/nway-merge';

// Keep the real obsidian-mock exports (Modal/App/DOM helpers) but capture Notice.
vi.mock('obsidian', async () => {
	const mod = await vi.importActual<typeof import('obsidian')>('obsidian');
	return { ...mod, Notice: vi.fn() };
});

// Resolution executors are exercised elsewhere; stub them so the modal tests
// focus on wiring (which button calls which executor and the success/error flow).
vi.mock('../sync/resolution-executor', () => ({
	executeAction: vi.fn(() => Promise.resolve()),
	executeBackOut: vi.fn(() => Promise.resolve()),
	executeConflictBackOut: vi.fn(() => Promise.resolve()),
	executeKeepLocal: vi.fn(() => Promise.resolve()),
	executeKeepGroupVault: vi.fn(() => Promise.resolve()),
	executeDeleteBoth: vi.fn(() => Promise.resolve()),
	writeResolvedMerge: vi.fn(() => Promise.resolve()),
}));
import {
	executeAction, executeBackOut, executeKeepLocal, writeResolvedMerge,
} from '../sync/resolution-executor';

// The async preview loader is covered by its own test; stub it here. Tests that
// need the merge textarea override its implementation to populate textareaRef.
vi.mock('./pending-file-panel', () => ({ loadFilePanels: vi.fn(() => Promise.resolve()) }));
import { loadFilePanels } from './pending-file-panel';

beforeEach(() => { vi.clearAllMocks(); });

function makeCandidate(partial: Partial<Candidate>): Candidate {
	return {
		path: 'f.md', state: 'Default', actionType: 'push',
		driveFileId: '', syncedLocalMtime: 0, syncedRemoteMtime: 0,
		syncedLocalSize: 0, syncedRemoteSize: 0, syncedAt: 0,
		deferredAt: 0, deferredLocalMtime: 0, deferredRemoteMtime: 0,
		...partial,
	};
}

function makeStore(initial: Candidate[]) {
	let changeCb: (() => void) | null = null;
	const getByType = vi.fn(() => initial);
	const onChange = vi.fn((cb: () => void) => { changeCb = cb; return () => { changeCb = null; }; });
	const approve = vi.fn(() => Promise.resolve());
	const defer = vi.fn(() => Promise.resolve());
	const store = { getByType, onChange, approve, defer } as unknown as CandidateStore;
	return { store, getByType, onChange, approve, defer, fireChange: () => changeCb?.() };
}

function openModal(opts: { type?: SyncActionType; candidates: Candidate[]; onResolved?: () => void }) {
	const s = makeStore(opts.candidates);
	const onResolved = opts.onResolved ?? vi.fn();
	const modal = new PendingListModal(new App(), opts.type ?? 'push', s.store, {} as SyncContext, onResolved);
	modal.open();
	return { modal, onResolved, ...s };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
	const b = [...root.querySelectorAll('button')].find(x => x.textContent === text);
	if (!b) throw new Error(`button not found: ${text}`);
	return b;
}

function expand(modal: PendingListModal, index = 0): HTMLElement {
	const paths = modal.contentEl.querySelectorAll<HTMLElement>('.vault-share-pending-path');
	paths[index]!.click();
	return modal.contentEl.querySelectorAll<HTMLElement>('.vault-share-pending-detail')[index]!;
}

describe('PendingListModal — rendering', () => {
	it('renders the title and description for the action type', () => {
		const { modal } = openModal({ type: 'pull', candidates: [makeCandidate({ actionType: 'pull' })] });
		expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Pull operations');
		expect(modal.contentEl.querySelector('.vault-share-pending-description')?.textContent)
			.toContain('pull these files');
	});

	it('renders one list item per candidate', () => {
		const { modal } = openModal({ candidates: [
			makeCandidate({ path: 'a.md' }), makeCandidate({ path: 'b.md' }),
		] });
		expect(modal.contentEl.querySelectorAll('.vault-share-pending-item').length).toBe(2);
	});

	it('checks Default and Approved candidates, leaves Deferred unchecked', () => {
		const { modal } = openModal({ candidates: [
			makeCandidate({ path: 'a', state: 'Default' }),
			makeCandidate({ path: 'b', state: 'Approved' }),
			makeCandidate({ path: 'c', state: 'Deferred' }),
		] });
		const checks = [...modal.contentEl.querySelectorAll<HTMLInputElement>('.vault-share-pending-checkbox')]
			.map(c => c.checked);
		expect(checks).toEqual([true, true, false]);
	});

	it('subscribes to store changes on open', () => {
		const { onChange } = openModal({ candidates: [makeCandidate({})] });
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});

describe('PendingListModal — select all', () => {
	it('toggles every checkbox', () => {
		const { modal } = openModal({ candidates: [
			makeCandidate({ path: 'a', state: 'Default' }),
			makeCandidate({ path: 'c', state: 'Deferred' }),
		] });
		const selectAll = modal.contentEl.querySelector<HTMLInputElement>('.vault-share-pending-select-all input')!;
		selectAll.checked = true;
		selectAll.dispatchEvent(new Event('change'));
		const checks = [...modal.contentEl.querySelectorAll<HTMLInputElement>('.vault-share-pending-checkbox')]
			.map(c => c.checked);
		expect(checks).toEqual([true, true]);
	});
});

describe('PendingListModal — accordion', () => {
	it('expands a row to show the preview and resolution buttons', () => {
		const { modal } = openModal({ candidates: [makeCandidate({ actionType: 'push' })] });
		const detail = expand(modal);
		expect(detail.hasClass('is-hidden')).toBe(false);
		expect(loadFilePanels).toHaveBeenCalledTimes(1);
		expect(detail.querySelector('.vault-share-pending-buttons')).not.toBeNull();
	});

	it('collapses on a second click', () => {
		const { modal } = openModal({ candidates: [makeCandidate({})] });
		const path = modal.contentEl.querySelector<HTMLElement>('.vault-share-pending-path')!;
		path.click();
		path.click();
		expect(modal.contentEl.querySelector('.vault-share-pending-detail')!.classList.contains('is-hidden')).toBe(true);
	});

	it('expanding another row collapses the first', () => {
		const { modal } = openModal({ candidates: [
			makeCandidate({ path: 'a.md' }), makeCandidate({ path: 'b.md' }),
		] });
		expand(modal, 0);
		expand(modal, 1);
		const details = modal.contentEl.querySelectorAll<HTMLElement>('.vault-share-pending-detail');
		expect(details[0]!.classList.contains('is-hidden')).toBe(true);
		expect(details[1]!.classList.contains('is-hidden')).toBe(false);
	});
});

describe('PendingListModal — resolution buttons by type', () => {
	it('non-conflict shows Proceed / Back out / Skip', () => {
		const { modal } = openModal({ type: 'push', candidates: [makeCandidate({ actionType: 'push' })] });
		const detail = expand(modal);
		const labels = [...detail.querySelectorAll('.vault-share-pending-buttons button')].map(b => b.textContent);
		expect(labels).toEqual(['Proceed', 'Back out', 'Skip']);
	});

	it('text conflict shows Merge / Back out / Skip', () => {
		const { modal } = openModal({ type: 'conflict', candidates: [makeCandidate({ actionType: 'conflict', path: 'doc.md' })] });
		const detail = expand(modal);
		const labels = [...detail.querySelectorAll('.vault-share-pending-buttons button')].map(b => b.textContent);
		expect(labels).toEqual(['Merge', 'Back out', 'Skip']);
	});

	it('binary conflict shows Keep local / Keep group vault / Delete both / Skip', () => {
		const { modal } = openModal({ type: 'conflict', candidates: [makeCandidate({ actionType: 'conflict', path: 'img.png' })] });
		const detail = expand(modal);
		const labels = [...detail.querySelectorAll('.vault-share-pending-buttons button')].map(b => b.textContent);
		expect(labels).toEqual(['Keep local', 'Keep group vault', 'Delete both', 'Skip']);
	});
});

describe('PendingListModal — executing a resolution', () => {
	it('Proceed runs executeAction, removes the row, notifies, and closes when empty', async () => {
		const onResolved = vi.fn();
		const { modal } = openModal({ candidates: [makeCandidate({ actionType: 'push' })], onResolved });
		const closeSpy = vi.spyOn(modal, 'close');
		const detail = expand(modal);
		buttonByText(detail, 'Proceed').click();
		await Promise.resolve(); await Promise.resolve();
		expect(executeAction).toHaveBeenCalledTimes(1);
		expect(onResolved).toHaveBeenCalledTimes(1);
		expect(closeSpy).toHaveBeenCalled();
	});

	it('Back out runs executeBackOut', async () => {
		const { modal } = openModal({ candidates: [makeCandidate({ actionType: 'push' })] });
		buttonByText(expand(modal), 'Back out').click();
		await Promise.resolve();
		expect(executeBackOut).toHaveBeenCalledTimes(1);
	});

	it('binary "Keep local" runs executeKeepLocal', async () => {
		const { modal } = openModal({ type: 'conflict', candidates: [makeCandidate({ actionType: 'conflict', path: 'img.png' })] });
		buttonByText(expand(modal), 'Keep local').click();
		await Promise.resolve();
		expect(executeKeepLocal).toHaveBeenCalledTimes(1);
	});

	it('shows a Notice and re-enables the button when the executor rejects', async () => {
		vi.mocked(executeAction).mockRejectedValueOnce(new Error('boom'));
		const { modal } = openModal({ candidates: [makeCandidate({ actionType: 'push' })] });
		const btn = buttonByText(expand(modal), 'Proceed');
		btn.click();
		await Promise.resolve(); await Promise.resolve();
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('Proceed failed: boom');
		expect(btn.disabled).toBe(false);
		expect(btn.textContent).toBe('Proceed');
	});

	it('Skip collapses the accordion without executing anything', () => {
		const { modal } = openModal({ candidates: [makeCandidate({ actionType: 'push' })] });
		const detail = expand(modal);
		buttonByText(detail, 'Skip').click();
		expect(detail.classList.contains('is-hidden')).toBe(true);
		expect(executeAction).not.toHaveBeenCalled();
	});
});

describe('PendingListModal — merge', () => {
	it('warns when the file content has not loaded yet', () => {
		const { modal } = openModal({ type: 'conflict', candidates: [makeCandidate({ actionType: 'conflict', path: 'doc.md' })] });
		buttonByText(expand(modal), 'Merge').click();
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('File content not loaded yet — please wait and try again.');
		expect(writeResolvedMerge).not.toHaveBeenCalled();
	});

	it('warns when unresolved conflict markers remain', () => {
		vi.mocked(loadFilePanels).mockImplementation((_c, _cand, _ctx, ref) => {
			const ta = createEl('textarea');
			ta.value = `keep\n${MARKER_OPEN}\nstuff`;
			ref.el = ta;
			return Promise.resolve();
		});
		const { modal } = openModal({ type: 'conflict', candidates: [makeCandidate({ actionType: 'conflict', path: 'doc.md' })] });
		buttonByText(expand(modal), 'Merge').click();
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('Resolve all conflict markers first.');
		expect(writeResolvedMerge).not.toHaveBeenCalled();
	});

	it('writes the resolved merge when the textarea is clean', async () => {
		vi.mocked(loadFilePanels).mockImplementation((_c, _cand, _ctx, ref) => {
			const ta = createEl('textarea');
			ta.value = 'fully resolved content';
			ref.el = ta;
			return Promise.resolve();
		});
		const { modal, onResolved } = openModal({ type: 'conflict', candidates: [makeCandidate({ actionType: 'conflict', path: 'doc.md' })] });
		buttonByText(expand(modal), 'Merge').click();
		await Promise.resolve(); await Promise.resolve();
		expect(writeResolvedMerge).toHaveBeenCalledTimes(1);
		expect(onResolved).toHaveBeenCalled();
	});
});

describe('PendingListModal — Apply', () => {
	it('approves Default candidates kept checked and closes', async () => {
		const { modal, approve, defer } = openModal({ candidates: [makeCandidate({ path: 'a', state: 'Default' })] });
		const closeSpy = vi.spyOn(modal, 'close');
		buttonByText(modal.contentEl, 'Apply').click();
		await Promise.resolve(); await Promise.resolve();
		expect(approve).toHaveBeenCalledWith(['a']);
		expect(defer).not.toHaveBeenCalled();
		expect(closeSpy).toHaveBeenCalled();
	});

	it('defers a Default candidate the user unchecked', async () => {
		const { modal, approve, defer } = openModal({ candidates: [makeCandidate({ path: 'a', state: 'Default' })] });
		const cb = modal.contentEl.querySelector<HTMLInputElement>('.vault-share-pending-checkbox')!;
		cb.checked = false;
		cb.dispatchEvent(new Event('change'));
		buttonByText(modal.contentEl, 'Apply').click();
		await Promise.resolve(); await Promise.resolve();
		expect(defer).toHaveBeenCalledWith(['a']);
		expect(approve).not.toHaveBeenCalled();
	});

	it('approves a Deferred candidate the user checked', async () => {
		const { modal, approve } = openModal({ candidates: [makeCandidate({ path: 'd', state: 'Deferred' })] });
		const cb = modal.contentEl.querySelector<HTMLInputElement>('.vault-share-pending-checkbox')!;
		cb.checked = true;
		cb.dispatchEvent(new Event('change'));
		buttonByText(modal.contentEl, 'Apply').click();
		await Promise.resolve(); await Promise.resolve();
		expect(approve).toHaveBeenCalledWith(['d']);
	});

	it('Cancel closes without approving or deferring', () => {
		const { modal, approve, defer } = openModal({ candidates: [makeCandidate({})] });
		const closeSpy = vi.spyOn(modal, 'close');
		buttonByText(modal.contentEl, 'Cancel').click();
		expect(closeSpy).toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
		expect(defer).not.toHaveBeenCalled();
	});
});

describe('PendingListModal — store change refresh', () => {
	it('re-renders and auto-closes when the store empties this view', () => {
		const { modal, getByType, fireChange } = openModal({ candidates: [makeCandidate({ path: 'a' })] });
		const closeSpy = vi.spyOn(modal, 'close');
		getByType.mockReturnValue([]);
		fireChange();
		expect(modal.contentEl.querySelectorAll('.vault-share-pending-item').length).toBe(0);
		expect(closeSpy).toHaveBeenCalled();
	});

	it('drops a removed candidate but keeps the remaining rows', () => {
		const { modal, getByType, fireChange } = openModal({ candidates: [
			makeCandidate({ path: 'a' }), makeCandidate({ path: 'b' }),
		] });
		getByType.mockReturnValue([makeCandidate({ path: 'b' })]);
		fireChange();
		const paths = [...modal.contentEl.querySelectorAll('.vault-share-pending-path')].map(p => p.textContent);
		expect(paths).toEqual(['b']);
	});
});

describe('PendingListModal — onClose', () => {
	it('unsubscribes from the store and empties the content', () => {
		const { modal } = openModal({ candidates: [makeCandidate({})] });
		modal.close();
		expect(modal.contentEl.children.length).toBe(0);
	});
});
