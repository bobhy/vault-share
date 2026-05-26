import type { Candidate, SyncContext } from '../sync/types';
import { computeMerge } from '../sync/resolution-executor';
import { isMergeEligible } from '../sync/merge';

/**
 * Mutable reference to the editable textarea created for text-conflict candidates.
 * Held by {@link PendingListModal} so the **Merge** button can read the current value.
 */
export interface TextareaRef {
	el: HTMLTextAreaElement | null;
}

/**
 * Async file-content panel renderer for {@link PendingListModal}.
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
			text: `Could not load file content: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
}

async function renderFilePanels(
	container: HTMLElement,
	candidate: Candidate,
	ctx: SyncContext,
	textareaRef: TextareaRef,
): Promise<void> {
	const dec = new TextDecoder();

	/** Read the local vault file and decode to text. */
	const readLocal = async (): Promise<string> => {
		const bytes = await ctx.localFs.read(candidate.path);
		return dec.decode(bytes);
	};

	/** Download the remote file and decode to text, or return null if the Drive file ID is unavailable. */
	const readRemote = async (): Promise<string | null> => {
		const driveFileId = candidate.remote?.driveFileId ?? candidate.driveFileId;
		if (!driveFileId) return null;
		const bytes = await ctx.driveFs.readBinary(driveFileId);
		return dec.decode(bytes);
	};

	container.empty();

	switch (candidate.actionType) {
		case 'push':
		case 'deleteRemote': {
			// Local vault content (read-only).
			const text = await readLocal();
			renderReadOnlyPanel(container, 'Local vault', text);
			break;
		}

		case 'pull':
		case 'deleteLocal': {
			// Remote content (read-only, downloaded on demand).
			const text = await readRemote();
			if (text === null) {
				renderUnavailable(container, 'Remote file is unavailable.');
			} else {
				renderReadOnlyPanel(container, 'Group vault', text);
			}
			break;
		}

		case 'conflict': {
			if (isMergeEligible(candidate.path)) {
				// Editable merged-result textarea.
				const result = await computeMerge(candidate, ctx);
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
				const [local, remote] = await Promise.all([readLocal(), readRemote()]);
				renderReadOnlyPanel(container, 'Local vault', local);
				if (remote === null) {
					renderUnavailable(container, 'Remote file is unavailable.');
				} else {
					renderReadOnlyPanel(container, 'Group vault', remote);
				}
			}
			break;
		}

		default:
			break;
	}
}

function renderReadOnlyPanel(container: HTMLElement, label: string, content: string): void {
	const panel = container.createDiv({ cls: 'vault-share-file-panel' });
	panel.createSpan({ cls: 'vault-share-file-panel-label', text: label });
	panel.createEl('pre', { cls: 'vault-share-file-panel-content', text: content });
}

function renderEditablePanel(container: HTMLElement, label: string, content: string): HTMLTextAreaElement {
	const panel = container.createDiv({ cls: 'vault-share-file-panel' });
	panel.createSpan({ cls: 'vault-share-file-panel-label', text: label });
	const ta = panel.createEl('textarea', { cls: 'vault-share-file-panel-textarea' });
	ta.value = content;
	return ta;
}

function renderUnavailable(container: HTMLElement, message: string): void {
	container.createEl('p', { cls: 'vault-share-pending-panel-error', text: message });
}
