import { App, Editor, Modal, Notice } from 'obsidian';
import { MARKER_LOCAL, MARKER_BASE, MARKER_SEP, MARKER_GROUP } from '../sync/merge';

/**
 * A parsed conflict block found in the editor.
 * Corresponds to one `> <<<<< local` … `> >>>>> group` region.
 */
interface ConflictBlock {
	/** Line index of the `> <<<<< local` marker. */
	startLine: number;
	/** Line index of the `> ||||| base` marker. */
	baseLine: number;
	/** Line index of the `> =====` marker. */
	sepLine: number;
	/** Line index of the `> >>>>> group` marker. */
	endLine: number;
	/** Lines belonging to the local (A) side. */
	localLines: string[];
	/** Lines belonging to the common base (O). */
	baseLines: string[];
	/** Lines belonging to the remote/group (B) side. */
	remoteLines: string[];
}

/**
 * Navigates between vault-share conflict marker blocks in an Obsidian editor and
 * offers resolution options (keep local, keep group, revert to base, keep all, skip).
 *
 * Conflict markers use the format produced by {@link threeWayMerge}:
 * ```
 * > <<<<< local
 * ...local lines...
 * > ||||| base
 * ...base lines...
 * > =====
 * ...remote lines...
 * > >>>>> group
 * ```
 *
 * Used by the **Find next conflict** and **Find previous conflict** editor commands.
 * After navigating to a block, a {@link ConflictResolutionModal} is opened so the user
 * can choose how to resolve it without leaving the editor.
 */
export class ConflictMarkerNavigator {
	constructor(private readonly app: App) {}

	/**
	 * Find the next conflict block after the cursor and open the resolution modal.
	 * Wraps to the first block if the cursor is past the last one.
	 * Shows "No conflicts found" if the document has none.
	 */
	navigateForward(editor: Editor): void {
		this.navigate(editor, 'forward');
	}

	/**
	 * Find the previous conflict block before the cursor and open the resolution modal.
	 * Wraps to the last block if the cursor is before the first one.
	 * Shows "No conflicts found" if the document has none.
	 */
	navigateBackward(editor: Editor): void {
		this.navigate(editor, 'backward');
	}

	/** Apply a resolution to a block by replacing it with `replacement` lines. */
	applyResolution(editor: Editor, block: ConflictBlock, replacement: string[]): void {
		const from = { line: block.startLine, ch: 0 };
		const to = { line: block.endLine, ch: editor.getLine(block.endLine).length };
		editor.replaceRange(replacement.join('\n'), from, to);
		editor.setCursor({ line: block.startLine, ch: 0 });
	}

	private navigate(editor: Editor, direction: 'forward' | 'backward'): void {
		const blocks = this.parseBlocks(editor);
		if (blocks.length === 0) {
			new Notice('No conflicts found.');
			return;
		}

		const cursorLine = editor.getCursor().line;
		const target = this.findTarget(blocks, cursorLine, direction);

		// If there is only one block and the cursor is already on it, say so.
		if (blocks.length === 1 && cursorLine >= target.startLine && cursorLine <= target.endLine) {
			new Notice('No other conflicts.');
		}

		editor.setCursor({ line: target.startLine, ch: 0 });
		editor.scrollIntoView(
			{ from: { line: target.startLine, ch: 0 }, to: { line: target.endLine, ch: 0 } },
			true,
		);

		new ConflictResolutionModal(this.app, editor, target, this).open();
	}

	/**
	 * Return the target block to navigate to.
	 * Precondition: `blocks` is non-empty.
	 */
	private findTarget(
		blocks: ConflictBlock[],
		cursorLine: number,
		direction: 'forward' | 'backward',
	): ConflictBlock {
		if (direction === 'forward') {
			// First block whose start is strictly after the cursor; wrap to first.
			return blocks.find(b => b.startLine > cursorLine) ?? blocks[0]!;
		}
		// Last block whose start is strictly before the cursor; wrap to last.
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i]!;
			if (block.startLine < cursorLine) return block;
		}
		return blocks[blocks.length - 1]!;
	}

	/** Parse all conflict blocks in the editor, in document order. */
	private parseBlocks(editor: Editor): ConflictBlock[] {
		const lineCount = editor.lineCount();
		const blocks: ConflictBlock[] = [];

		let i = 0;
		while (i < lineCount) {
			if (editor.getLine(i) !== MARKER_LOCAL) {
				i++;
				continue;
			}

			const startLine = i;
			let baseLine = -1;
			let sepLine = -1;
			let endLine = -1;

			for (let j = i + 1; j < lineCount; j++) {
				const line = editor.getLine(j);
				if (line === MARKER_BASE && baseLine === -1) {
					baseLine = j;
				} else if (line === MARKER_SEP && baseLine !== -1 && sepLine === -1) {
					sepLine = j;
				} else if (line === MARKER_GROUP && sepLine !== -1) {
					endLine = j;
					break;
				}
			}

			if (baseLine !== -1 && sepLine !== -1 && endLine !== -1) {
				blocks.push({
					startLine,
					baseLine,
					sepLine,
					endLine,
					localLines: this.lineRange(editor, startLine + 1, baseLine),
					baseLines: this.lineRange(editor, baseLine + 1, sepLine),
					remoteLines: this.lineRange(editor, sepLine + 1, endLine),
				});
				i = endLine + 1;
			} else {
				i++;
			}
		}

		return blocks;
	}

	/** Collect lines from `from` (inclusive) to `to` (exclusive). */
	private lineRange(editor: Editor, from: number, to: number): string[] {
		const lines: string[] = [];
		for (let i = from; i < to; i++) {
			lines.push(editor.getLine(i));
		}
		return lines;
	}
}

/**
 * Small modal that presents resolution choices for a single conflict block.
 *
 * Opened by {@link ConflictMarkerNavigator} immediately after the cursor is moved to
 * a block.  Choosing an option calls {@link ConflictMarkerNavigator.applyResolution}
 * and closes the modal; **Skip** closes without making any changes.
 */
class ConflictResolutionModal extends Modal {
	constructor(
		app: App,
		private readonly editor: Editor,
		private readonly block: ConflictBlock,
		private readonly navigator: ConflictMarkerNavigator,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('vault-share-conflict-resolution-modal');
		contentEl.createEl('h3', { text: 'Resolve conflict' });

		const addBtn = (label: string, lines: string[]): void => {
			contentEl.createEl('button', { cls: 'vault-share-conflict-btn', text: label })
				.addEventListener('click', () => {
					this.navigator.applyResolution(this.editor, this.block, lines);
					this.close();
				});
		};

		addBtn('Keep local version', this.block.localLines);
		addBtn('Keep group version', this.block.remoteLines);
		addBtn('Revert to base', this.block.baseLines);
		addBtn(
			'Keep all',
			[...this.block.localLines, ...this.block.baseLines, ...this.block.remoteLines],
		);

		contentEl.createEl('button', { cls: 'vault-share-conflict-btn', text: 'Skip' })
			.addEventListener('click', () => { this.close(); });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
