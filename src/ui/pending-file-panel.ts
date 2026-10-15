/**
 * File-preview panel rendered inside each {@link ui/pending-list-modal!PendingListModal} row.
 *
 * Lazily fetches the bytes the user needs to see (local-only for pushes,
 * remote-only for pulls, both sides for conflicts) and renders the
 * appropriate panel type (read-only, two-pane, or editable textarea for the
 * merge case). Kept separate from the modal so the modal stays focused on
 * row layout and action wiring.
 *
 * @packageDocumentation
 */
import type { Candidate, SyncContext } from '../sync/types';
import { computeMerge, readLocalText, readRemoteText } from '../sync/resolution-executor';
import { isMergeEligible } from '../sync/nway-merge';
import { errorMessage } from '../errors';

/**
 * Mutable reference to the editable textarea created for text-conflict candidates.
 * Held by {@link ui/pending-list-modal!PendingListModal} so the **Merge** button can read the current value.
 */
export interface TextareaRef {
	el: HTMLTextAreaElement | null;
}

/**
 * Async file-content panel renderer for {@link ui/pending-list-modal!PendingListModal}.
 *
 * Shows a loading placeholder while content is being fetched, then replaces it
 * with the appropriate panel:
 *
 * | Action type | Panel |
 * |-------------|-------|
 * | push / deleteRemote | Read-only local vault content |
 * | pull / deleteLocal | Read-only remote content (downloaded on demand) |
 * | conflict (text file) | Editable textarea pre-populated with the 3-way merge result |
 * | conflict (binary) | Two read-only panels stacked (local top, remote bottom) |
 *
 * On error, renders an error message in place of the panel.
 * For text-conflict candidates, sets {@link TextareaRef.el} once the textarea is ready.
 */
export async function loadFilePanels(
	container: HTMLElement,
	candidate: Candidate,
	ctx: SyncContext,
	textareaRef: TextareaRef,
): Promise<void> {
	container.empty();
	container.createSpan({ text: 'Loading…', cls: 'vault-share-pending-panel-loading' });

	try {
		await renderFilePanels(container, candidate, ctx, textareaRef);
	} catch (err: unknown) {
		container.empty();
		container.createEl('p', {
			cls: 'vault-share-pending-panel-error',
			text: `Could not load file content: ${errorMessage(err)}`,
		});
	}
}

async function renderFilePanels(
	container: HTMLElement,
	candidate: Candidate,
	ctx: SyncContext,
	textareaRef: TextareaRef,
): Promise<void> {
	switch (candidate.actionType) {
		case 'push':
		case 'deleteRemote': {
			// Local vault content (read-only).
			const text = await readLocalText(candidate, ctx);
			container.empty();
			renderReadOnlyPanel(container, 'Local vault', text);
			break;
		}

		case 'pull':
		case 'deleteLocal': {
			// Remote content (read-only, downloaded on demand).
			const text = await readRemoteText(candidate, ctx);
			container.empty();
			renderRemotePanel(container, text);
			break;
		}

		case 'conflict': {
			if (isMergeEligible(candidate.path)) {
				// Editable merged-result textarea.
				const result = await computeMerge(candidate, ctx);
				container.empty();
				const ta = renderEditablePanel(container, 'Merged result', result.content);
				textareaRef.el = ta;
				if (result.hasConflicts) {
					container.createEl('p', {
						cls: 'vault-share-pending-conflict-hint',
						text: 'Conflict markers are present. Edit to resolve them before merging.',
					});
				}
			} else {
				// Two stacked read-only panels for binary files.
				const [local, remote] = await Promise.all([
					readLocalText(candidate, ctx),
					readRemoteText(candidate, ctx),
				]);
				container.empty();
				renderReadOnlyPanel(container, 'Local vault', local);
				renderRemotePanel(container, remote);
			}
			break;
		}

		default:
			container.empty();
			break;
	}
}

/** Create a panel div with its label; the caller adds the content element. */
function createLabelledPanel(container: HTMLElement, label: string): HTMLElement {
	const panel = container.createDiv({ cls: 'vault-share-file-panel' });
	panel.createSpan({ cls: 'vault-share-file-panel-label', text: label });
	return panel;
}

function renderReadOnlyPanel(container: HTMLElement, label: string, content: string): void {
	createLabelledPanel(container, label)
		.createEl('pre', { cls: 'vault-share-file-panel-content', text: content });
}

/** Group vault panel, or an "unavailable" notice when the file has no Drive copy. */
function renderRemotePanel(container: HTMLElement, content: string | null): void {
	if (content === null) {
		container.createEl('p', { cls: 'vault-share-pending-panel-error', text: 'Remote file is unavailable.' });
	} else {
		renderReadOnlyPanel(container, 'Group vault', content);
	}
}

function renderEditablePanel(container: HTMLElement, label: string, content: string): HTMLTextAreaElement {
	const ta = createLabelledPanel(container, label)
		.createEl('textarea', { cls: 'vault-share-file-panel-textarea' });
	ta.value = content;
	return ta;
}
