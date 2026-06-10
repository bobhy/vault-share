/**
 * Reactive sync for the file the user is currently editing or viewing.
 *
 * {@link sync/scheduler!SyncScheduler} dispatches `singleFileSync` from its heartbeat after
 * either the post-edit hold-down expires or a monitored-file poll deadline
 * fires. The path-specific code that bulk sync does not need lives here:
 * refreshing the open editor view after a pull, reopening the leaf on a
 * conflict copy, and the "Syncing…" overlay shown while I/O is in flight.
 *
 * @packageDocumentation
 */
import type { Workspace } from 'obsidian';
import { MarkdownView } from 'obsidian';
import type { Candidate, SyncContext } from './types';
import type { CandidateStore } from './candidate-store';
import { planAction } from './decision-engine';
import { syncOneFile } from './file-syncer';
import { hasConflictMarkers, isMergeEligible } from './nway-merge';
import { ConfirmationModal } from '../ui/confirmation-modal';
import { GDriveError } from '../gdrive/errors';

/**
 * Sync a single file that is currently open or recently opened.
 * Saves in-memory editor content first, then syncs with Drive.
 * Updates all open views showing the file after a successful sync.
 */
export async function singleFileSync(
	path: string,
	ctx: SyncContext,
	candidateStore: CandidateStore,
	workspace: Workspace,
	setStatusBar: (text: string) => void,
	clearHoldDown?: (path: string) => void,
): Promise<void> {
	const rootFolderId = ctx.driveFolderId();
	if (!rootFolderId) return;

	ctx.statsTracker.recordSingleFileSync();

	ctx.logger.debug(`singleFileSync: ${path} — fetching remote status`);

	try {
		const [localSide, remoteSide] = await Promise.all([
			Promise.resolve(ctx.localFs.stat(path)),
			ctx.driveFs.stat(rootFolderId, path),
		]);

		// Look up the existing candidate from the store to get sync history.
		// If not found (brand-new path not yet discovered by a bulk pass),
		// build a transient Candidate with no history.
		const existing = candidateStore.get(path);
		const candidate: Candidate = existing
			? { ...existing, local: localSide ?? undefined, remote: remoteSide ?? undefined }
			: {
				path,
				state: 'Default',
				actionType: 'noOp',  // will be recomputed below
				driveFileId: remoteSide?.driveFileId ?? '',
				syncedLocalMtime: 0,
				syncedRemoteMtime: 0,
				syncedLocalSize: 0,
				syncedRemoteSize: 0,
				syncedAt: 0,
				deferredAt: 0,
				deferredLocalMtime: 0,
				deferredRemoteMtime: 0,
				local: localSide ?? undefined,
				remote: remoteSide ?? undefined,
			};

		const vaultHasHistory = candidateStore.hasSyncHistory();
		const actionType = planAction(
			existing ?? null,
			localSide ?? undefined,
			remoteSide ?? undefined,
			vaultHasHistory,
		);
		candidate.actionType = actionType;

		if (actionType === 'noOp') {
			ctx.logger.debug(`singleFileSync: ${path} — no action needed`);
			return;
		}

		// Push-hold: never share a file the user is still resolving. A local text
		// file that carries conflict markers stays put until it is conflict-free;
		// only the eventual clean resolution propagates upward.
		if (actionType === 'push' && isMergeEligible(path) && localSide) {
			const localText = new TextDecoder().decode(await ctx.localFs.read(path));
			if (hasConflictMarkers(localText)) {
				ctx.logger.info(`singleFileSync: holding push of ${path} — unresolved conflict markers`);
				setStatusBar(`Holding ${basename(path)} — resolve conflict markers to share`);
				return;
			}
		}

		ctx.logger.debug(`singleFileSync: ${path} — action=${actionType}`);

		const fileResult = await syncOneFile(candidate, ctx, vaultHasHistory);

		if (!fileResult.changed) return;

		// applyFileResult upserts (markSynced for cached, insertSynced for new),
		// so the existing/new distinction doesn't need to be handled here.
		// syncOneFile already managed the "Current file" activity signal.
		await candidateStore.applyFileResult(path, actionType, fileResult);

		// If conflict files were created (keep-both / delete-conflict), reopen the view.
		const localConflictPath = fileResult.newSyncedFiles?.[0]?.path;
		const remoteConflictPath = fileResult.newSyncedFiles?.[1]?.path;
		if (localConflictPath) {
			const overlay = showSyncOverlay(path, workspace);
			try {
				await reopenOnConflictFile(localConflictPath, workspace);
				await ConfirmationModal.prompt(
					ctx.app,
					'Sync conflict',
					`Sync downloaded a conflicting change to the currently open file. ` +
					`The conflicting file is <code>${remoteConflictPath ?? ''}</code>`,
				);
			} finally {
				overlay();
			}
		} else if (actionType === 'pull' || fileResult.merged) {
			// Content changed on disk — refresh the open view.
			const overlay = showSyncOverlay(path, workspace);
			try {
				await refreshOpenViews(path, workspace);
				// Pull/merge wrote the file, which fires a vault modify event and arms
				// the holdDown timer. Clear it so the scheduler does not push the file
				// back immediately after a remote pull.
				clearHoldDown?.(path);
			} finally {
				overlay();
			}
		}

		setStatusBar(`Updated ${basename(path)}`);
		await ctx.statsTracker.flush();

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const detail = err instanceof GDriveError
			? ` [${err.code}${err.status !== undefined ? `/${err.status}` : ''}]`
			: '';
		setStatusBar(`Interrupted ${basename(path)}: ${msg}`);
		ctx.logger.error(`Single-file sync failed: ${path}`, msg + detail);
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
		const scrollTop = view.currentMode?.getScroll?.() ?? 0;
		if (view.getMode() === 'source') {
			// openFile reloads from disk without marking the editor dirty, so
			// Obsidian's auto-save is not triggered and the file mtime stays stable.
			refreshes.push(
				leaf.openFile(file, { active: false }).then(() => {
					const freshView = leaf.view;
					if (freshView instanceof MarkdownView) {
						freshView.editor.scrollTo(0, scrollTop);
					}
				}),
			);
		} else {
			// Preview mode: trigger re-render via state change.
			void leaf.setViewState(leaf.getViewState());
		}
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
