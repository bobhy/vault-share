import { App, Modal, Notice } from 'obsidian';
import type { DeferralManager } from '../sync/deferral-manager';
import type { DeferredCandidate, SyncActionType } from '../sync/types';

const TEXT_EXTENSIONS = new Set([
	'.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv',
	'.html', '.css', '.js', '.ts',
]);

function isTextFile(path: string): boolean {
	const dotIdx = path.lastIndexOf('.');
	return dotIdx >= 0 && TEXT_EXTENSIONS.has(path.slice(dotIdx).toLowerCase());
}

const MODAL_TITLE: Record<SyncActionType, string> = {
	push:         'Deferred push operations',
	pull:         'Deferred pull operations',
	deleteRemote: 'Deferred group vault deletions',
	deleteLocal:  'Deferred local vault deletions',
	conflict:     'Deferred conflict resolutions',
	noOp:         'Deferred operations',
};

const MODAL_DESCRIPTION: Record<SyncActionType, string> = {
	push:         'Sharing plans to push these files to the group vault. Select the ones you want to allow.',
	pull:         'Sharing plans to pull these files from the group vault. Select the ones you want to allow.',
	deleteRemote: 'Sharing plans to delete these files from the group vault. Select the ones you want to allow.',
	deleteLocal:  'Sharing plans to delete these files from your local vault. Select the ones you want to allow.',
	conflict:     'Sharing detected conflicting edits to these files. Select the ones you want to resolve.',
	noOp:         '',
};

function candidateDescription(candidate: DeferredCandidate): string {
	switch (candidate.actionType) {
		case 'push':         return 'Sharing plans to push this file to the group vault.';
		case 'pull':         return 'Sharing plans to pull this file from the group vault.';
		case 'deleteRemote': return 'Sharing plans to delete this file from the group vault.';
		case 'deleteLocal':  return 'Sharing plans to delete this file from your local vault.';
		case 'conflict':     return isTextFile(candidate.path)
			? 'Sharing detected conflicting edits. A 3-way merge is available in the local vault file.'
			: 'Sharing detected conflicting edits to a non-text file.';
		default:             return '';
	}
}

/**
 * Modal that lists all deferred candidates for a single operation type.
 *
 * The user reviews the list, accepts candidates via checkboxes, then taps Apply
 * to release those candidates from deferral (they will be processed in the next
 * bulk sync pass). Each row can be tapped — not the checkbox — to expand an inline
 * Manual Review section showing the planned operation and resolution buttons.
 *
 * Resolution buttons other than Skip are stubs pending full implementation.
 *
 * TODO: add unit tests once the obsidian-mock package supports `Modal.open()` and allows
 * querying the rendered DOM (`.modal-button-container`, list items, checkboxes).
 * TODO: accept `SyncContext` in the constructor so resolution buttons can call `syncOneFile`
 * and `driveFs` for on-demand remote file downloads.
 */
export class DeferredListModal extends Modal {
	private readonly accepted = new Map<string, boolean>();
	private expandedPath: string | null = null;

	constructor(
		app: App,
		private readonly candidates: DeferredCandidate[],
		private readonly actionType: SyncActionType,
		private readonly manager: DeferralManager,
	) {
		super(app);
		for (const c of candidates) {
			this.accepted.set(c.path, false);
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vault-share-deferred-modal');

		contentEl.createEl('h2', { text: MODAL_TITLE[this.actionType] });
		contentEl.createEl('p', {
			cls: 'vault-share-deferred-description',
			text: MODAL_DESCRIPTION[this.actionType],
		});

		// Select-all control — wired up after the list is rendered
		const selectAllRow = contentEl.createDiv({ cls: 'vault-share-deferred-select-all' });
		const selectAll = selectAllRow.createEl('input');
		selectAll.type = 'checkbox';
		selectAllRow.createSpan({ text: 'Select all' });

		const listEl = contentEl.createEl('ul', { cls: 'vault-share-deferred-list' });
		for (const candidate of this.candidates) {
			this.renderItem(listEl, candidate);
		}

		selectAll.addEventListener('change', () => {
			const checked = selectAll.checked;
			for (const path of this.accepted.keys()) {
				this.accepted.set(path, checked);
			}
			listEl.querySelectorAll<HTMLInputElement>('.vault-share-deferred-checkbox').forEach(cb => {
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
	}

	private renderItem(list: HTMLElement, candidate: DeferredCandidate): void {
		const li = list.createEl('li', { cls: 'vault-share-deferred-item' });

		const row = li.createDiv({ cls: 'vault-share-deferred-row' });

		const cb = row.createEl('input');
		cb.type = 'checkbox';
		cb.addClass('vault-share-deferred-checkbox');
		cb.addEventListener('change', () => { this.accepted.set(candidate.path, cb.checked); });

		row.createSpan({
			cls: 'vault-share-deferred-path is-clickable',
			text: candidate.path,
		}).addEventListener('click', () => { this.toggleAccordion(li, candidate); });

		// Hidden accordion section, populated on first expand
		li.createDiv({ cls: 'vault-share-deferred-detail is-hidden' });
	}

	private toggleAccordion(li: HTMLElement, candidate: DeferredCandidate): void {
		const detail = li.querySelector<HTMLElement>('.vault-share-deferred-detail');
		if (!detail) return;

		const isOpen = !detail.hasClass('is-hidden');

		// Collapse any other expanded item before changing this one
		if (this.expandedPath !== null && this.expandedPath !== candidate.path) {
			li.parentElement
				?.querySelectorAll<HTMLElement>('.vault-share-deferred-detail')
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

	private populateDetail(container: HTMLElement, candidate: DeferredCandidate): void {
		container.createEl('p', {
			cls: 'vault-share-deferred-detail-desc',
			text: candidateDescription(candidate),
		});

		// TODO: render real file content per operation type. Requires passing SyncContext to this
		// constructor so driveFs is available for on-demand downloads.
		// push / deleteLocal  → app.vault.read(tfile) (local, read-only)
		// pull / deleteRemote → driveFs.download(candidate.driveFileId) (remote, read-only)
		// text conflict       → app.vault.read(tfile) in an editable CodeMirror panel
		// non-text conflict   → two stacked panels: local (read-only) + remote (read-only, on demand)
		container.createDiv({ cls: 'vault-share-deferred-file-panel' })
			.setText('File preview — accept via checkbox above, or use a resolution button below.');

		this.addResolutionButtons(container.createDiv({ cls: 'vault-share-deferred-buttons' }), candidate);
	}

	private addResolutionButtons(container: HTMLElement, candidate: DeferredCandidate): void {
		const stub = (label: string) => {
			container.createEl('button', { text: label })
				.addEventListener('click', () => { new Notice(`${label}: not yet implemented.`); });
		};

		if (candidate.actionType === 'conflict') {
			if (isTextFile(candidate.path)) {
				// TODO: Merge — check the local file for remaining conflict markers; if none remain,
				// write the edited file to both vaults via syncOneFile or driveFs.upload + store update.
				stub('Merge');
				// TODO: Back out — restore the common base (from sync-content cache or Drive) to both
				// vaults, discarding both sides' edits; update sync records so both sides match base.
				stub('Back out');
			} else {
				// TODO: Keep local — upload the local file to the group vault; update sync records.
				stub('Keep local');
				// TODO: Keep group vault — download the group vault file to local; update sync records.
				stub('Keep group vault');
				// TODO: Delete both — trash the local file and delete from Drive; update sync records.
				stub('Delete both');
			}
		} else {
			// TODO: Proceed — reconstruct a SyncAction from the candidate and call syncOneFile
			// immediately (requires SyncContext passed to this modal constructor).
			stub('Proceed');
			// TODO: Back out — execute the reverse operation per spec:
			// push→trash local; pull→delete from Drive; deleteLocal→restore from Drive to local;
			// deleteRemote→upload local to Drive. Update sync records accordingly.
			stub('Back out');
		}

		// Skip always appears last and is fully functional
		const skip = container.createEl('button', { text: 'Skip' });
		skip.addEventListener('click', () => {
			const detail = skip.closest<HTMLElement>('.vault-share-deferred-detail');
			detail?.addClass('is-hidden');
			this.expandedPath = null;
		});
	}

	private async applyAccepted(): Promise<void> {
		const paths = [...this.accepted.entries()]
			.filter(([, ok]) => ok)
			.map(([path]) => path);
		if (paths.length > 0) {
			await this.manager.releaseByPath(paths);
		}
		this.close();
	}
}
