import { App, Modal, Notice } from 'obsidian';
import type { DeferralManager } from '../sync/deferral-manager';
import type { DeferredCandidate, SyncActionType, SyncContext, ViewCandidate } from '../sync/types';
import {
	executeAction,
	executeBackOut,
	executeConflictBackOut,
	executeKeepLocal,
	executeKeepGroupVault,
	executeDeleteBoth,
	writeResolvedMerge,
} from '../sync/resolution-executor';
import { hasConflictMarkers } from '../sync/merge';
import { loadFilePanels, type TextareaRef } from './pending-file-panel';

const TEXT_EXTENSIONS = new Set([
	'.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv',
	'.html', '.css', '.js', '.ts',
]);

function isTextFile(path: string): boolean {
	const dotIdx = path.lastIndexOf('.');
	return dotIdx >= 0 && TEXT_EXTENSIONS.has(path.slice(dotIdx).toLowerCase());
}

const MODAL_TITLE: Record<SyncActionType, string> = {
	push:         'Push operations',
	pull:         'Pull operations',
	deleteRemote: 'Group vault deletions',
	deleteLocal:  'Local vault deletions',
	conflict:     'Conflict resolutions',
	noOp:         'Operations',
};

const MODAL_DESCRIPTION: Record<SyncActionType, string> = {
	push:         'Sharing will push these files to the group vault. Accept the ones you want to allow.',
	pull:         'Sharing will pull these files from the group vault. Accept the ones you want to allow.',
	deleteRemote: 'Sharing will delete these files from the group vault. Accept the ones you want to allow.',
	deleteLocal:  'Sharing will delete these files from your local vault. Accept the ones you want to allow.',
	conflict:     'Sharing detected conflicting edits to these files. Select the ones you want to resolve.',
	noOp:         '',
};

function candidateDescription(candidate: ViewCandidate): string {
	switch (candidate.actionType) {
		case 'push':         return 'Sharing will push this file to the group vault.';
		case 'pull':         return 'Sharing will pull this file from the group vault.';
		case 'deleteRemote': return 'Sharing will delete this file from the group vault.';
		case 'deleteLocal':  return 'Sharing will delete this file from your local vault.';
		case 'conflict':     return isTextFile(candidate.path)
			? 'Sharing detected conflicting edits. Review both versions and choose a resolution.'
			: 'Sharing detected conflicting edits to a non-text file. Choose which version to keep.';
		default:             return '';
	}
}

/**
 * Modal that lists all candidates (pending and deferred) for a single operation type.
 *
 * Pending candidates have their checkbox initially checked; deferred candidates are
 * initially unchecked. The user reviews the list and taps **Apply** to release chosen
 * deferred candidates (no Drive call) or **Cancel** to dismiss. Each row can be tapped
 * to expand an inline detail section with resolution buttons.
 *
 * Resolution buttons execute operations immediately via {@link resolution-executor}:
 * - Non-conflict: **Proceed** runs the planned action; **Back out** runs the reverse.
 * - Text conflict: **Merge** runs a diff3 three-way merge; **Back out** restores the
 *   last-synced common base to both vaults.
 * - Binary conflict: **Keep local**, **Keep group vault**, or **Delete both**.
 *
 * After a successful resolution the candidate is removed from the modal list.
 * `onResolved(path)` notifies the parent view to update its candidate list and
 * re-render the count table without a full Drive re-plan.
 *
 * After **Apply**, `onCandidatesChanged(released, deferred)` notifies the parent view to
 * flip `isDeferred` on affected candidates and re-render — no Drive call in either direction.
 *
 * TODO: add unit tests once the obsidian-mock package supports `Modal.open()` and allows
 * querying the rendered DOM.
 */
export class PendingListModal extends Modal {
	private candidates: ViewCandidate[];
	private readonly accepted = new Map<string, boolean>();
	private expandedPath: string | null = null;
	private listEl: HTMLUListElement | null = null;

	constructor(
		app: App,
		candidates: ViewCandidate[],
		private readonly actionType: SyncActionType,
		private readonly manager: DeferralManager,
		private readonly ctx: SyncContext,
		private readonly onResolved: (path: string) => void,
		private readonly onCandidatesChanged: (released: string[], deferred: string[]) => void,
	) {
		super(app);
		this.candidates = [...candidates];
		for (const c of this.candidates) {
			// Pending candidates are pre-accepted; deferred ones require explicit opt-in.
			this.accepted.set(c.path, !c.isDeferred);
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vault-share-pending-modal');

		contentEl.createEl('h2', { text: MODAL_TITLE[this.actionType] });
		contentEl.createEl('p', {
			cls: 'vault-share-pending-description',
			text: MODAL_DESCRIPTION[this.actionType],
		});

		// Select-all control — wired up after the list is rendered
		const selectAllRow = contentEl.createDiv({ cls: 'vault-share-pending-select-all' });
		const selectAll = selectAllRow.createEl('input');
		selectAll.type = 'checkbox';
		selectAllRow.createSpan({ text: 'Select all' });

		this.listEl = contentEl.createEl('ul', { cls: 'vault-share-pending-list' });
		for (const candidate of this.candidates) {
			this.renderItem(this.listEl, candidate);
		}

		selectAll.addEventListener('change', () => {
			const checked = selectAll.checked;
			for (const path of this.accepted.keys()) {
				this.accepted.set(path, checked);
			}
			this.listEl?.querySelectorAll<HTMLInputElement>('.vault-share-pending-checkbox').forEach(cb => {
				cb.checked = checked;
			});
		});

		const footer = contentEl.createDiv({ cls: 'modal-button-container' });
		footer.createEl('button', { text: 'Apply', cls: 'mod-cta' })
			.addEventListener('click', () => { void this.applyAccepted(); });
		footer.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => { this.close(); });
	}

	onClose(): void {
		this.contentEl.empty();
		this.listEl = null;
	}

	/** Rebuild the candidate list in-place after a resolution succeeds. */
	private rerenderList(): void {
		if (!this.listEl) return;
		this.listEl.empty();
		for (const candidate of this.candidates) {
			this.renderItem(this.listEl, candidate);
		}
	}

	/**
	 * Called after a resolution button executes successfully.
	 * Removes the candidate from the local list, notifies the parent view,
	 * and closes the modal if no candidates remain.
	 */
	private handleSuccess(candidate: ViewCandidate): void {
		this.candidates = this.candidates.filter(c => c.path !== candidate.path);
		this.accepted.delete(candidate.path);
		this.rerenderList();
		this.onResolved(candidate.path);
		if (this.candidates.length === 0) this.close();
	}

	private renderItem(list: HTMLElement, candidate: ViewCandidate): void {
		const li = list.createEl('li', { cls: 'vault-share-pending-item' });

		const row = li.createDiv({ cls: 'vault-share-pending-row' });

		const cb = row.createEl('input');
		cb.type = 'checkbox';
		cb.checked = this.accepted.get(candidate.path) ?? !candidate.isDeferred;
		cb.addClass('vault-share-pending-checkbox');
		cb.addEventListener('change', () => { this.accepted.set(candidate.path, cb.checked); });

		row.createSpan({
			cls: 'vault-share-pending-path is-clickable',
			text: candidate.path,
		}).addEventListener('click', () => { this.toggleAccordion(li, candidate); });

		// Hidden accordion section, populated on first expand
		li.createDiv({ cls: 'vault-share-pending-detail is-hidden' });
	}

	private toggleAccordion(li: HTMLElement, candidate: ViewCandidate): void {
		const detail = li.querySelector<HTMLElement>('.vault-share-pending-detail');
		if (!detail) return;

		const isOpen = !detail.hasClass('is-hidden');

		// Collapse any other expanded item before changing this one
		if (this.expandedPath !== null && this.expandedPath !== candidate.path) {
			li.parentElement
				?.querySelectorAll<HTMLElement>('.vault-share-pending-detail')
				.forEach(d => d.addClass('is-hidden'));
		}

		if (isOpen) {
			detail.addClass('is-hidden');
			this.expandedPath = null;
		} else {
			detail.empty();
			this.populateDetail(detail, candidate);
			detail.removeClass('is-hidden');
			this.expandedPath = candidate.path;
		}
	}

	private populateDetail(container: HTMLElement, candidate: ViewCandidate): void {
		container.createEl('p', {
			cls: 'vault-share-pending-detail-desc',
			text: candidateDescription(candidate),
		});

		// File panel area: async content loading replaces the loading placeholder.
		const panelArea = container.createDiv({ cls: 'vault-share-pending-panel-area' });
		// Textarea ref: populated by loadFilePanels for text-conflict candidates so the
		// Merge button can read the current (possibly user-edited) content.
		const textareaRef: TextareaRef = { el: null };
		void loadFilePanels(panelArea, candidate, this.ctx, textareaRef);

		this.addResolutionButtons(container.createDiv({ cls: 'vault-share-pending-buttons' }), candidate, textareaRef);
	}

	private addResolutionButtons(container: HTMLElement, candidate: ViewCandidate, textareaRef: TextareaRef): void {
		/** Helper: create a button that runs an async executor and handles state/errors. */
		const actionBtn = (label: string, executor: () => Promise<void>): void => {
			const btn = container.createEl('button', { text: label });
			btn.addEventListener('click', () => {
				btn.disabled = true;
				btn.setText('Running…');
				void executor()
					.then(() => { this.handleSuccess(candidate); })
					.catch((err: unknown) => {
						btn.disabled = false;
						btn.setText(label);
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`${label} failed: ${msg}`);
					});
			});
		};

		if (candidate.actionType === 'conflict') {
			if (isTextFile(candidate.path)) {
				// Merge reads from the editable textarea (textareaRef.el) and checks for
				// unresolved conflict markers before writing to both vaults.
				const mergeBtn = container.createEl('button', { text: 'Merge' });
				mergeBtn.addEventListener('click', () => {
					const text = textareaRef.el?.value;
					if (text === undefined) {
						new Notice('File content not loaded yet — please wait and try again.');
						return;
					}
					if (hasConflictMarkers(text)) {
						new Notice('Resolve all conflict markers first.');
						textareaRef.el?.focus();
						return;
					}
					mergeBtn.disabled = true;
					mergeBtn.setText('Running…');
					void writeResolvedMerge(candidate, text, this.ctx)
						.then(() => { this.handleSuccess(candidate); })
						.catch((err: unknown) => {
							mergeBtn.disabled = false;
							mergeBtn.setText('Merge');
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Merge failed: ${msg}`);
						});
				});
				actionBtn('Back out', () => executeConflictBackOut(candidate, this.ctx));
			} else {
				actionBtn('Keep local', () => executeKeepLocal(candidate, this.ctx));
				actionBtn('Keep group vault', () => executeKeepGroupVault(candidate, this.ctx));
				actionBtn('Delete both', () => executeDeleteBoth(candidate, this.ctx));
			}
		} else {
			actionBtn('Proceed', () => executeAction(candidate, this.ctx));
			actionBtn('Back out', () => executeBackOut(candidate, this.ctx));
		}

		// Skip always appears last: collapses the accordion without executing anything.
		const skip = container.createEl('button', { text: 'Skip' });
		skip.addEventListener('click', () => {
			const detail = skip.closest<HTMLElement>('.vault-share-pending-detail');
			detail?.addClass('is-hidden');
			this.expandedPath = null;
		});
	}

	private async applyAccepted(): Promise<void> {
		const acceptedSet = new Set(
			[...this.accepted.entries()].filter(([, ok]) => ok).map(([p]) => p),
		);
		const rejectedSet = new Set(
			[...this.accepted.entries()].filter(([, ok]) => !ok).map(([p]) => p),
		);

		// Deferred candidates that the user checked → release them.
		const toRelease = this.candidates
			.filter(c => c.isDeferred && acceptedSet.has(c.path))
			.map(c => c.path);

		// Pending candidates that the user unchecked → defer them.
		const pendingToDefer = this.candidates.filter(
			c => !c.isDeferred && rejectedSet.has(c.path),
		);

		if (toRelease.length > 0) {
			await this.manager.releaseByPath(toRelease);
		}

		if (pendingToDefer.length > 0) {
			const now = Date.now();
			const newDeferredCandidates: DeferredCandidate[] = await Promise.all(
				pendingToDefer.map(async c => {
					const record = await this.ctx.store.getRecord(c.path);
					const local = this.ctx.localFs.stat(c.path);
					return {
						path: c.path,
						actionType: c.actionType,
						localMtime: local?.mtime ?? 0,
						remoteMtime: record?.remoteMtime ?? 0,
						driveFileId: c.driveFileId,
						deferredAt: now,
					};
				}),
			);
			await this.manager.addDeferred(newDeferredCandidates);
		}

		if (toRelease.length > 0 || pendingToDefer.length > 0) {
			this.onCandidatesChanged(toRelease, pendingToDefer.map(c => c.path));
		}
		this.close();
	}
}
