import { describe, it, expect, vi, beforeEach } from 'vitest';
// Side-effect import: installs obsidian-mock's DOM augmentations (createDiv /
// createSpan / createEl / empty) used by the panel. The module under test reaches
// Obsidian's DOM helpers but doesn't itself import 'obsidian' at runtime (its
// obsidian-touching dep, resolution-executor, is mocked below).
import 'obsidian';
import { loadFilePanels, type TextareaRef } from './pending-file-panel';
import type { Candidate, SyncContext } from '../sync/types';

// computeMerge pulls the full merge/IDB stack; stub it so these tests stay focused
// on panel rendering. isMergeEligible is left real — it keys purely off the path
// extension (.md = mergeable text, .png = binary).
vi.mock('../sync/resolution-executor', () => ({ computeMerge: vi.fn() }));
import { computeMerge } from '../sync/resolution-executor';

beforeEach(() => { vi.clearAllMocks(); });

/** Build a Candidate with all required scalar fields defaulted; override per test. */
function makeCandidate(partial: Partial<Candidate>): Candidate {
	return {
		path: 'note.md',
		state: 'Default',
		actionType: 'push',
		driveFileId: '',
		syncedLocalMtime: 0, syncedRemoteMtime: 0,
		syncedLocalSize: 0, syncedRemoteSize: 0, syncedAt: 0,
		deferredAt: 0, deferredLocalMtime: 0, deferredRemoteMtime: 0,
		...partial,
	};
}

/**
 * A SyncContext whose localFs/driveFs return the given text. Returns the spies
 * standalone so assertions reference them directly (member access on the typed
 * SyncContext would trip @typescript-eslint/unbound-method).
 */
function makeCtx(opts: { local?: string; remote?: string; localThrows?: Error } = {}) {
	const enc = new TextEncoder();
	const read = vi.fn(() => opts.localThrows
		? Promise.reject(opts.localThrows)
		: Promise.resolve(enc.encode(opts.local ?? '')));
	const readBinary = vi.fn(() => Promise.resolve(enc.encode(opts.remote ?? '')));
	const ctx = { localFs: { read }, driveFs: { readBinary } } as unknown as SyncContext;
	return { ctx, read, readBinary };
}

function freshContainer(): HTMLElement {
	return createDiv();
}

function makeRef(): TextareaRef { return { el: null }; }

describe('loadFilePanels — read-only (push / deleteRemote)', () => {
	it('renders the local vault content for a push', async () => {
		const container = freshContainer();
		const { ctx, read } = makeCtx({ local: 'hello local' });
		await loadFilePanels(container, makeCandidate({ actionType: 'push', path: 'a.md' }), ctx, makeRef());

		expect(container.querySelector('.vault-share-file-panel-label')?.textContent).toBe('Local vault');
		expect(container.querySelector('.vault-share-file-panel-content')?.textContent).toBe('hello local');
		expect(read).toHaveBeenCalledWith('a.md');
		// Loading placeholder is gone once the panel renders.
		expect(container.querySelector('.vault-share-pending-panel-loading')).toBeNull();
	});

	it('treats deleteRemote like a local read-only preview', async () => {
		const container = freshContainer();
		await loadFilePanels(container, makeCandidate({ actionType: 'deleteRemote' }), makeCtx({ local: 'x' }).ctx, makeRef());
		expect(container.querySelector('.vault-share-file-panel-label')?.textContent).toBe('Local vault');
	});
});

describe('loadFilePanels — remote (pull / deleteLocal)', () => {
	it('downloads and renders remote content when a drive file id is present', async () => {
		const container = freshContainer();
		const { ctx, readBinary } = makeCtx({ remote: 'remote body' });
		const cand = makeCandidate({ actionType: 'pull', driveFileId: 'drive-1' });
		await loadFilePanels(container, cand, ctx, makeRef());

		expect(container.querySelector('.vault-share-file-panel-label')?.textContent).toBe('Group vault');
		expect(container.querySelector('.vault-share-file-panel-content')?.textContent).toBe('remote body');
		expect(readBinary).toHaveBeenCalledWith('drive-1');
	});

	it('shows "unavailable" when no drive file id is resolvable', async () => {
		const container = freshContainer();
		await loadFilePanels(container, makeCandidate({ actionType: 'pull' }), makeCtx().ctx, makeRef());
		expect(container.querySelector('.vault-share-pending-panel-error')?.textContent)
			.toBe('Remote file is unavailable.');
	});

	it('prefers candidate.remote.driveFileId over the top-level driveFileId', async () => {
		const container = freshContainer();
		const { ctx, readBinary } = makeCtx({ remote: 'r' });
		const cand = makeCandidate({
			actionType: 'pull',
			driveFileId: 'fallback',
			remote: { driveFileId: 'preferred' } as Candidate['remote'],
		});
		await loadFilePanels(container, cand, ctx, makeRef());
		expect(readBinary).toHaveBeenCalledWith('preferred');
	});
});

describe('loadFilePanels — conflict (text, merge-eligible)', () => {
	it('renders an editable textarea seeded with the merge result and sets the ref', async () => {
		vi.mocked(computeMerge).mockResolvedValue({ content: 'merged!', hasConflicts: false });
		const container = freshContainer();
		const ref = makeRef();
		await loadFilePanels(container, makeCandidate({ actionType: 'conflict', path: 'doc.md' }), makeCtx().ctx, ref);

		const ta = container.querySelector<HTMLTextAreaElement>('textarea.vault-share-file-panel-textarea');
		expect(ta).not.toBeNull();
		expect(ta?.value).toBe('merged!');
		expect(ref.el).toBe(ta);
		expect(container.querySelector('.vault-share-pending-conflict-hint')).toBeNull();
	});

	it('shows the conflict hint when the merge still has conflict markers', async () => {
		vi.mocked(computeMerge).mockResolvedValue({ content: 'x', hasConflicts: true });
		const container = freshContainer();
		await loadFilePanels(container, makeCandidate({ actionType: 'conflict', path: 'doc.md' }), makeCtx().ctx, makeRef());
		expect(container.querySelector('.vault-share-pending-conflict-hint')?.textContent)
			.toContain('Conflict markers are present');
	});
});

describe('loadFilePanels — conflict (binary, not merge-eligible)', () => {
	it('stacks local and remote read-only panels', async () => {
		const container = freshContainer();
		const { ctx } = makeCtx({ local: 'LOCAL', remote: 'REMOTE' });
		const cand = makeCandidate({ actionType: 'conflict', path: 'image.png', driveFileId: 'd1' });
		await loadFilePanels(container, cand, ctx, makeRef());

		const labels = [...container.querySelectorAll('.vault-share-file-panel-label')].map(e => e.textContent);
		expect(labels).toEqual(['Local vault', 'Group vault']);
		const bodies = [...container.querySelectorAll('.vault-share-file-panel-content')].map(e => e.textContent);
		expect(bodies).toEqual(['LOCAL', 'REMOTE']);
	});

	it('renders local panel plus an unavailable notice when remote is missing', async () => {
		const container = freshContainer();
		const cand = makeCandidate({ actionType: 'conflict', path: 'image.png' }); // no driveFileId
		await loadFilePanels(container, cand, makeCtx({ local: 'LOCAL' }).ctx, makeRef());

		expect(container.querySelector('.vault-share-file-panel-label')?.textContent).toBe('Local vault');
		expect(container.querySelector('.vault-share-pending-panel-error')?.textContent)
			.toBe('Remote file is unavailable.');
	});
});

describe('loadFilePanels — unhandled action type', () => {
	it('renders nothing for an action type with no panel (e.g. noOp)', async () => {
		const container = freshContainer();
		await loadFilePanels(container, makeCandidate({ actionType: 'noOp' }), makeCtx().ctx, makeRef());
		expect(container.children.length).toBe(0);
	});
});

describe('loadFilePanels — error handling', () => {
	it('renders an error message when content loading throws', async () => {
		const container = freshContainer();
		const { ctx } = makeCtx({ localThrows: new Error('disk gone') });
		await loadFilePanels(container, makeCandidate({ actionType: 'push' }), ctx, makeRef());

		expect(container.querySelector('.vault-share-pending-panel-error')?.textContent)
			.toBe('Could not load file content: disk gone');
		expect(container.querySelector('.vault-share-pending-panel-loading')).toBeNull();
	});
});
