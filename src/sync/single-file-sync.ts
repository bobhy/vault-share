import type { Workspace } from 'obsidian';
import { MarkdownView } from 'obsidian';
import type { SyncContext } from './types';
import { buildMixedEntries } from './change-detector';
import { planActions } from './decision-engine';
import { syncOneFile } from './file-syncer';
import { ConfirmationModal } from '../ui/confirmation-modal';

/**
 * Sync a single file that is currently open or recently opened.
 * Saves in-memory editor content first, then syncs with Drive.
 * Updates all open views showing the file after a successful sync.
 */
export async function singleFileSync(
	path: string,
	ctx: SyncContext,
	workspace: Workspace,
	setStatusBar: (text: string) => void,
): Promise<void> {
	const rootFolderId = ctx.driveFolderId();
	if (!rootFolderId) return;

	// Flush in-memory editor content for this path before reading from disk.
	await ctx.localFs.saveOpenFileContent(path, workspace);

	ctx.statsTracker.recordSingleFileSync();

	try {
		const [localSide, remoteSide, record] = await Promise.all([
			Promise.resolve(ctx.localFs.stat(path)),
			ctx.driveFs.stat(rootFolderId, path),
			ctx.store.getRecord(path),
		]);

		const hasHistory = !!record;
		const entries = buildMixedEntries(
			localSide ? [localSide] : [],
			remoteSide ? [remoteSide] : [],
			record ? [record] : [],
		);

		const actions = planActions(entries, hasHistory).filter(a => a.type !== 'noOp');
		if (actions.length === 0) return;

		const action = actions[0]!;
		const overlay = showSyncOverlay(path, workspace);

		try {
			const fileResult = await syncOneFile(action, ctx, hasHistory);

			if (!fileResult.changed) return;

			if (fileResult.conflictLocalPath) {
				// Conflict files created — reopen view on the local conflict file.
				await reopenOnConflictFile(fileResult.conflictLocalPath, workspace);
				await ConfirmationModal.prompt(
					ctx.app,
					'Sync conflict',
					`Sync downloaded a conflicting change to the currently open file. ` +
					`The conflicting file is <code>${fileResult.conflictRemotePath ?? ''}</code>`,
				);
			} else if (action.type === 'pull' || fileResult.merged) {
				// Content changed on disk — refresh the open view.
				await refreshOpenViews(path, workspace);
			}

			setStatusBar(`Updated ${basename(path)}`);
			await ctx.statsTracker.flush();

		} finally {
			overlay();
		}

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		setStatusBar(`Interrupted ${basename(path)}: ${msg}`);
		ctx.logger.error(`Single-file sync failed: ${path}`, msg);
	}
}

/**
 * Show a "Syncing..." overlay on all visible leaves displaying path.
 * Returns a function that removes the overlay.
 */
export function showSyncOverlay(path: string, workspace: Workspace): () => void {
	const overlays: HTMLElement[] = [];

	workspace.iterateAllLeaves(leaf => {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		if (view.file?.path !== path) return;

		const el = view.containerEl;
		const overlay = el.createDiv({ cls: 'vault-share-sync-overlay' });
		overlay.setText('Syncing…');
		Object.assign(overlay.style, {
			position: 'absolute',
			inset: '0',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			background: 'rgba(var(--background-primary-rgb, 0,0,0), 0.4)',
			zIndex: '1000',
			pointerEvents: 'none',
			fontSize: 'var(--font-ui-medium)',
			color: 'var(--text-normal)',
		});
		overlays.push(overlay);
	});

	return () => { for (const el of overlays) el.remove(); };
}

/** Reload content in all open MarkdownView leaves showing path. */
async function refreshOpenViews(path: string, workspace: Workspace): Promise<void> {
	const file = workspace.getActiveViewOfType(MarkdownView)?.app.vault.getFileByPath(path);
	if (!file) return;

	const refreshes: Promise<void>[] = [];
	workspace.iterateAllLeaves(leaf => {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		if (view.file?.path !== path) return;
		// Save scroll position and reload.
		const scrollTop = view.currentMode?.getScroll?.() ?? 0;
		refreshes.push(
			view.app.vault.read(file).then(content => {
				if (view.getMode() === 'source') {
					view.editor.setValue(content);
					view.editor.scrollTo(0, scrollTop);
				} else {
					// Preview mode: trigger re-render via state change.
					void leaf.setViewState(leaf.getViewState());
				}
			}),
		);
	});
	await Promise.all(refreshes);
}

/** Open the conflict file in the same leaf that was showing the original. */
async function reopenOnConflictFile(conflictPath: string, workspace: Workspace): Promise<void> {
	const activeLeaf = workspace.getMostRecentLeaf();
	if (!activeLeaf) return;
	const file = activeLeaf.view instanceof MarkdownView
		? activeLeaf.view.app.vault.getFileByPath(conflictPath)
		: null;
	if (file) {
		await activeLeaf.openFile(file);
	}
}

function basename(path: string): string {
	return path.split('/').pop() ?? path;
}
