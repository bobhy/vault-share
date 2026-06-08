/**
 * Editor-side support for vault-share conflict markers.
 *
 * Exposes a CM6 extension ({@link conflictHighlightExtension}) and the
 * {@link ConflictMarkerNavigator} class that backs the **Find next/previous
 * conflict** commands. The navigator parses {@link MARKER_OPEN} …
 * {@link MARKER_CLOSE} N-way regions, outlines the active region with a CM6 line
 * decoration, and floats a CM6-managed panel above the editor with one
 * resolution button **per labelled segment** (`base`, `A1`, `A2`, …) — choosing
 * one replaces the whole region with it — plus next/previous navigation.
 *
 * @packageDocumentation
 */
import { Editor, MarkdownView, Notice, setIcon } from 'obsidian';
import { type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, type Panel, showPanel } from '@codemirror/view';
import { MARKER_OPEN, MARKER_CLOSE, SEGMENT_MARKER_RE } from '../sync/nway-merge';

/** One labelled segment of a conflict region: `base` or an alternative `A<n>`. */
export interface ConflictSegment {
	/** `base`, or `A1` / `A2` / … */
	label: string;
	/** The content lines under this segment's marker. */
	lines: string[];
}

/**
 * A parsed conflict region found in the editor.
 * Corresponds to one {@link MARKER_OPEN} … {@link MARKER_CLOSE} region.
 */
export interface ConflictBlock {
	/** Line index of the {@link MARKER_OPEN} marker. */
	startLine: number;
	/** Line index of the {@link MARKER_CLOSE} marker. */
	endLine: number;
	/** The region's segments in document order (`base` plus the alternatives). */
	segments: ConflictSegment[];
}

// ---------------------------------------------------------------------------
// CodeMirror 6 extensions — conflict-block highlight + resolution panel
// ---------------------------------------------------------------------------

/**
 * State effect that sets (non-null) or clears (null) the conflict-block
 * highlight decorations.  Dispatched by {@link ConflictMarkerNavigator}.
 */
const setConflictHighlight = StateEffect.define<Range<Decoration>[] | null>();

const conflictHighlightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setConflictHighlight)) {
				deco = effect.value === null
					? Decoration.none
					: Decoration.set(effect.value, true);
			}
		}
		return deco;
	},
	provide: f => EditorView.decorations.from(f),
});

/**
 * State effect that shows (non-null panel constructor) or hides (null) the
 * conflict-resolution panel.  The constructor closure captures the conflict
 * state so the panel DOM can be built when CM6 mounts it.
 */
const setConflictPanel = StateEffect.define<((view: EditorView) => Panel) | null>();

const conflictPanelField = StateField.define<((view: EditorView) => Panel) | null>({
	create: () => null,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setConflictPanel)) return effect.value;
		}
		return value;
	},
	// showPanel.from reads the field and registers the constructor as a panel provider.
	// When the value is null no panel is shown; when non-null CM6 calls the constructor
	// and mounts the returned dom above the editor content (.cm-panels-top).
	provide: f => showPanel.from(f),
});

/**
 * CodeMirror 6 extension bundle that enables the rounded-rectangle conflict-block
 * highlight and the CM6-managed resolution panel used by {@link ConflictMarkerNavigator}.
 *
 * Register once via `Plugin.registerEditorExtension(conflictHighlightExtension)`
 * in `VaultSharePlugin.onload`.
 */
export const conflictHighlightExtension: Extension = [conflictHighlightField, conflictPanelField];

// ---------------------------------------------------------------------------
// Navigator
// ---------------------------------------------------------------------------

/**
 * Navigates between vault-share conflict marker blocks in an Obsidian editor and
 * offers inline resolution options without obscuring the editor.
 *
 * When a conflict is found:
 * - The region is outlined with a rounded rectangle via a CM6 line decoration.
 * - A resolution panel (hosted as a CM6 top panel, like the built-in find bar)
 *   appears above the editor and shows "Conflict N of M" with **one button per
 *   labelled segment** (`base`, `A1`, `A2`, …) — choosing one replaces the whole
 *   region with that segment — plus **↑ / ↓** navigation arrows and a **×**
 *   close button.
 *
 * Because the panel is managed by CM6 it survives editor re-renders and
 * post-edit DOM sweeps — the limitation of the previous `contentEl.prepend`
 * approach.
 *
 * Applying a resolution auto-advances to the next conflict. When the last
 * conflict is resolved the panel is dismissed and "All conflicts resolved" is
 * shown. **×** dismisses without changing the document.
 *
 * Used by the **Find next conflict** and **Find previous conflict** editor
 * commands. When no {@link MarkdownView} is available (e.g. in tests) navigation
 * and resolution still work; only the panel is skipped.
 */
export class ConflictMarkerNavigator {
	/**
	 * The CM6 EditorView currently hosting the panel and highlight.
	 * Nulled after every dismissBanner() so stale dispatches are avoided.
	 */
	private activeEditorView: EditorView | null = null;

	/**
	 * Find the next conflict block after the cursor, outline it, and show the
	 * resolution panel. Wraps to the first block if the cursor is past the last one.
	 * Shows "No conflicts found" if the document has none.
	 */
	navigateForward(editor: Editor, view?: MarkdownView): void {
		this.navigate(editor, 'forward', view);
	}

	/**
	 * Find the previous conflict block before the cursor, outline it, and show the
	 * resolution panel. Wraps to the last block if the cursor is before the first one.
	 * Shows "No conflicts found" if the document has none.
	 */
	navigateBackward(editor: Editor, view?: MarkdownView): void {
		this.navigate(editor, 'backward', view);
	}

	/**
	 * Wire `handler` to activate `el` by both mouse/keyboard (`click`) and touch
	 * (`touchend`). On Obsidian mobile a tap inside the editor's DOM is consumed
	 * by the editor's own touch-gesture handling and the synthetic `click` is
	 * never delivered to a CM6 panel button — so the buttons render but taps do
	 * nothing. Handling `touchend` and calling `preventDefault()` activates the
	 * control on touch and suppresses the would-be synthetic `click`, so the
	 * handler still fires exactly once.
	 *
	 * This workaround is specific to controls embedded in the CodeMirror editor.
	 * Controls hosted in a normal view or modal (e.g. the log view's toolbar) are
	 * not inside the editor, so plain taps reach them — use Obsidian's
	 * `ButtonComponent` / `ExtraButtonComponent` / `DropdownComponent` there
	 * instead. Do not apply this `touchend`/`preventDefault()` pattern to a native
	 * control such as a `<select>`: it would suppress the OS option picker.
	 */
	private bindActivate(el: HTMLElement, handler: () => void): void {
		el.addEventListener('click', handler);
		el.addEventListener('touchend', (e) => { e.preventDefault(); handler(); });
	}

	/** Apply a resolution to a block by replacing it with `replacement` lines. */
	applyResolution(editor: Editor, block: ConflictBlock, replacement: string[]): void {
		const from = { line: block.startLine, ch: 0 };
		const to = { line: block.endLine, ch: editor.getLine(block.endLine).length };
		editor.replaceRange(replacement.join('\n'), from, to);
		editor.setCursor({ line: block.startLine, ch: 0 });
	}

	private navigate(editor: Editor, direction: 'forward' | 'backward', view?: MarkdownView): void {
		const blocks = this.parseBlocks(editor);
		if (blocks.length === 0) {
			this.dismissBanner();
			new Notice('No conflicts found.');
			return;
		}

		const cursorLine = editor.getCursor().line;
		const target = this.findTarget(blocks, cursorLine, direction);
		const targetIndex = blocks.indexOf(target);

		// Determine whether the cursor is already sitting inside the target block.
		// When there is only one conflict and the cursor is inside it there is
		// nowhere else to go, so we skip the cursor move/scroll — but we still
		// open the banner and draw the highlight so the first invocation works.
		const alreadyInside =
			blocks.length === 1 &&
			cursorLine >= target.startLine &&
			cursorLine <= target.endLine;

		if (alreadyInside) {
			new Notice('No other conflicts.');
		} else {
			// Scroll the block into view and move the cursor.
			editor.setCursor({ line: target.startLine, ch: 0 });
			editor.scrollIntoView(
				{ from: { line: target.startLine, ch: 0 }, to: { line: target.endLine, ch: 0 } },
				true,
			);
		}

		// showBanner dispatches the new panel (after dismissing the old one).
		// setHighlight must come AFTER showBanner: showBanner calls dismissBanner
		// which clears the old highlight, so setting the new highlight last ensures
		// it is not immediately erased.
		if (view) {
			this.showBanner(editor, target, view, targetIndex, blocks.length);
		}
		this.setHighlight(editor, target);
	}

	/**
	 * Build the resolution panel DOM and dispatch a CM6 panel constructor so
	 * CM6 mounts it above the editor content (.cm-panels-top).  The panel
	 * survives editor re-renders because CM6 owns its DOM lifecycle.
	 */
	private showBanner(
		editor: Editor,
		block: ConflictBlock,
		view: MarkdownView,
		index: number,
		total: number,
	): void {
		const cm = (editor as unknown as { cm: EditorView }).cm;
		if (!cm) return;

		// Dismiss any existing panel/highlight, then record the new CM view.
		this.dismissBanner();
		this.activeEditorView = cm;

		cm.dispatch({
			effects: setConflictPanel.of(() => {
				const dom = createDiv({ cls: 'vault-share-conflict-banner' });

				// ── Left: label + resolution buttons ──────────────────────
				dom.createSpan({
					cls: 'vault-share-conflict-banner-label',
					text: `Conflict ${index + 1} of ${total}`,
				});

				const addBtn = (label: string, lines: string[]): void => {
					const btn = dom.createEl('button', { cls: 'vault-share-conflict-banner-btn', text: label });
					this.bindActivate(btn, () => {
							this.applyResolution(editor, block, lines);
							this.dismissBanner();
							const remaining = this.parseBlocks(editor);
							if (remaining.length > 0) {
								this.navigate(editor, 'forward', view);
							} else {
								new Notice('All conflicts resolved.');
							}
						});
				};

				// One button per labelled segment; choosing it replaces the whole
				// region with that segment (the base is selectable too).
				for (const seg of block.segments) addBtn(seg.label, seg.lines);

				// ── Right: separator | nav arrows | close ──────────────────
				dom.createSpan({ cls: 'vault-share-conflict-banner-sep' });

				const addNavBtn = (iconName: string, label: string, dir: 'forward' | 'backward'): void => {
					const btn = dom.createEl('button', {
						cls: 'vault-share-conflict-banner-nav',
						attr: { 'aria-label': label },
					});
					setIcon(btn, iconName);
					this.bindActivate(btn, () => { this.navigate(editor, dir, view); });
				};
				addNavBtn('chevron-up',   'Previous conflict', 'backward');
				addNavBtn('chevron-down', 'Next conflict',     'forward');

				const closeBtn = dom.createEl('button', {
					cls: 'vault-share-conflict-banner-close',
					text: '×',
					attr: { 'aria-label': 'Close' },
				});
				this.bindActivate(closeBtn, () => { this.dismissBanner(); });

				return { dom, top: true };
			}),
		});
	}

	/**
	 * Dispatch CM6 line decorations that draw a rounded rectangle around `block`.
	 * Each line gets the base class; the first and last also get modifier classes
	 * that supply the top/bottom border and rounded corners.
	 * No-ops gracefully when the underlying CM6 view is unavailable (e.g. tests).
	 */
	private setHighlight(editor: Editor, block: ConflictBlock): void {
		const cm = (editor as unknown as { cm: EditorView }).cm;
		if (!cm) return;
		// Keep activeEditorView current (may already be set by showBanner).
		this.activeEditorView = cm;

		const doc = cm.state.doc;
		// CM6 line numbers are 1-indexed; our block lines are 0-indexed.
		const firstCm = block.startLine + 1;
		const lastCm  = block.endLine   + 1;

		const decorations: Range<Decoration>[] = [];
		for (let l = firstCm; l <= lastCm; l++) {
			const cls = ['vault-share-conflict-line'];
			if (l === firstCm) cls.push('vault-share-conflict-line--first');
			if (l === lastCm)  cls.push('vault-share-conflict-line--last');
			decorations.push(
				Decoration.line({ attributes: { class: cls.join(' ') } })
					.range(doc.line(l).from),
			);
		}

		cm.dispatch({ effects: setConflictHighlight.of(decorations) });
	}

	/** Dismiss the CM6 panel and clear the highlight decoration. */
	private dismissBanner(): void {
		if (this.activeEditorView) {
			this.activeEditorView.dispatch({
				effects: [
					setConflictPanel.of(null),
					setConflictHighlight.of(null),
				],
			});
			this.activeEditorView = null;
		}
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
			return blocks.find(b => b.startLine > cursorLine) ?? blocks[0]!;
		}
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block = blocks[i]!;
			if (block.startLine < cursorLine) return block;
		}
		return blocks[blocks.length - 1]!;
	}

	/**
	 * Parse all N-way conflict regions in the editor, in document order. A region
	 * runs from {@link MARKER_OPEN} to {@link MARKER_CLOSE}, with each segment
	 * introduced by a `` `===== <label>` `` line. Only regions with at least two
	 * segments (a real choice) are returned; anything malformed is skipped.
	 */
	private parseBlocks(editor: Editor): ConflictBlock[] {
		const lineCount = editor.lineCount();
		const blocks: ConflictBlock[] = [];

		let i = 0;
		while (i < lineCount) {
			if (editor.getLine(i) !== MARKER_OPEN) {
				i++;
				continue;
			}

			const startLine = i;
			const segments: ConflictSegment[] = [];
			let current: ConflictSegment | null = null;
			let endLine = -1;

			for (let j = i + 1; j < lineCount; j++) {
				const line = editor.getLine(j);
				if (line === MARKER_CLOSE) { if (current) segments.push(current); endLine = j; break; }
				if (line === MARKER_OPEN) break; // malformed: nested open, bail
				const m = SEGMENT_MARKER_RE.exec(line);
				if (m) {
					if (current) segments.push(current);
					current = { label: m[1]!, lines: [] };
				} else if (current) {
					current.lines.push(line);
				}
			}

			if (endLine !== -1 && segments.length >= 2) {
				blocks.push({ startLine, endLine, segments });
				i = endLine + 1;
			} else {
				i++;
			}
		}

		return blocks;
	}
}
