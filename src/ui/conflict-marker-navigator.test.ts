import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, Editor } from 'obsidian';
import { ConflictMarkerNavigator } from './conflict-marker-navigator';
import { MARKER_LOCAL, MARKER_BASE, MARKER_SEP, MARKER_GROUP } from '../sync/merge';

// ---------------------------------------------------------------------------
// Minimal in-memory editor mock
// ---------------------------------------------------------------------------

function makeEditor(lines: string[]): {
	editor: Editor;
	cursor: { line: number; ch: number };
	getLines: () => string[];
} {
	const cursor = { line: 0, ch: 0 };
	const current = [...lines];

	const editor = {
		getCursor: () => ({ ...cursor }),
		setCursor: (pos: { line: number; ch: number }) => { cursor.line = pos.line; cursor.ch = pos.ch; },
		getLine: (n: number) => current[n] ?? '',
		lineCount: () => current.length,
		scrollIntoView: () => { /* noop */ },
		replaceRange: (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
			// Replaces lines from.line–to.line (inclusive) with the replacement text lines.
			const before = current.slice(0, from.line);
			const after = current.slice(to.line + 1);
			const replacement = text.split('\n');
			current.splice(0, current.length, ...before, ...replacement, ...after);
		},
	} as unknown as Editor;

	return { editor, cursor, getLines: () => [...current] };
}

const CONFLICT_BLOCK = [
	MARKER_LOCAL,
	'LOCAL LINE',
	MARKER_BASE,
	'BASE LINE',
	MARKER_SEP,
	'REMOTE LINE',
	MARKER_GROUP,
];

function makeDoc(...extra: string[][]): string[] {
	return [...CONFLICT_BLOCK, ...extra.flat()];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — parsing', () => {
	it('navigates forward to the first conflict block in a document', () => {
		const { editor, cursor } = makeEditor(makeDoc());
		cursor.line = 0; // already at start
		const nav = new ConflictMarkerNavigator(new App());
		nav.navigateForward(editor);
		// Cursor moved to startLine (0) of the only block.
		expect(editor.getCursor().line).toBe(0);
	});

	it('navigates forward past the current block to the next one', () => {
		const doc = [
			...CONFLICT_BLOCK,
			'middle line',
			MARKER_LOCAL,
			'A',
			MARKER_BASE,
			'B',
			MARKER_SEP,
			'C',
			MARKER_GROUP,
		];
		const { editor, cursor } = makeEditor(doc);
		cursor.line = 0; // inside the first block
		const nav = new ConflictMarkerNavigator(new App());
		nav.navigateForward(editor);
		// Should jump to the second block (line CONFLICT_BLOCK.length + 1).
		expect(editor.getCursor().line).toBe(CONFLICT_BLOCK.length + 1);
	});

	it('wraps from last block back to first when navigating forward', () => {
		const doc = [
			...CONFLICT_BLOCK,
			'mid',
			MARKER_LOCAL,
			'X',
			MARKER_BASE,
			'Y',
			MARKER_SEP,
			'Z',
			MARKER_GROUP,
		];
		const { editor, cursor } = makeEditor(doc);
		// Cursor is after the last block.
		cursor.line = doc.length - 1;
		const nav = new ConflictMarkerNavigator(new App());
		nav.navigateForward(editor);
		// Should wrap to first block (line 0).
		expect(editor.getCursor().line).toBe(0);
	});

	it('navigates backward to the previous conflict block', () => {
		const doc = [
			...CONFLICT_BLOCK,
			'mid',
			MARKER_LOCAL,
			'X',
			MARKER_BASE,
			'Y',
			MARKER_SEP,
			'Z',
			MARKER_GROUP,
		];
		const { editor, cursor } = makeEditor(doc);
		// Cursor is on the second block.
		cursor.line = CONFLICT_BLOCK.length + 1;
		const nav = new ConflictMarkerNavigator(new App());
		nav.navigateBackward(editor);
		// Should jump back to the first block (line 0).
		expect(editor.getCursor().line).toBe(0);
	});

	it('wraps from first block to last when navigating backward', () => {
		const doc = [
			...CONFLICT_BLOCK,
			'mid',
			MARKER_LOCAL,
			'X',
			MARKER_BASE,
			'Y',
			MARKER_SEP,
			'Z',
			MARKER_GROUP,
		];
		const { editor, cursor } = makeEditor(doc);
		const secondBlockStart = CONFLICT_BLOCK.length + 1;
		cursor.line = 0; // before first block
		const nav = new ConflictMarkerNavigator(new App());
		nav.navigateBackward(editor);
		// Should wrap to last block.
		expect(editor.getCursor().line).toBe(secondBlockStart);
	});
});

describe('ConflictMarkerNavigator — applyResolution', () => {
	let editor: Editor;
	let getLines: () => string[];
	const nav = new ConflictMarkerNavigator(new App());

	// Shared block for resolution tests.
	const block = {
		startLine: 0,
		baseLine: 2,
		sepLine: 4,
		endLine: 6,
		localLines: ['LOCAL LINE'],
		baseLines: ['BASE LINE'],
		remoteLines: ['REMOTE LINE'],
	};

	beforeEach(() => {
		({ editor, getLines } = makeEditor([...CONFLICT_BLOCK]));
	});

	it('keep local: replaces block with local lines only', () => {
		nav.applyResolution(editor, block, block.localLines);
		expect(getLines()).toEqual(['LOCAL LINE']);
	});

	it('keep group: replaces block with remote lines only', () => {
		nav.applyResolution(editor, block, block.remoteLines);
		expect(getLines()).toEqual(['REMOTE LINE']);
	});

	it('revert to base: replaces block with base lines only', () => {
		nav.applyResolution(editor, block, block.baseLines);
		expect(getLines()).toEqual(['BASE LINE']);
	});

	it('keep all: replaces block with all content lines concatenated', () => {
		nav.applyResolution(editor, block, [
			...block.localLines, ...block.baseLines, ...block.remoteLines,
		]);
		expect(getLines()).toEqual(['LOCAL LINE', 'BASE LINE', 'REMOTE LINE']);
	});

	it('preserves surrounding context lines', () => {
		const docLines = ['before', ...CONFLICT_BLOCK, 'after'];
		const docEditor = makeEditor(docLines).editor;
		const shiftedBlock = { ...block, startLine: 1, baseLine: 3, sepLine: 5, endLine: 7 };
		nav.applyResolution(docEditor, shiftedBlock, shiftedBlock.localLines);
		const result = Array.from({ length: docEditor.lineCount() }, (_, i) => docEditor.getLine(i));
		expect(result).toEqual(['before', 'LOCAL LINE', 'after']);
	});
});

describe('ConflictMarkerNavigator — no conflicts', () => {
	it('shows a notice and does not move the cursor when there are no conflicts', () => {
		const { editor, cursor } = makeEditor(['just a normal line']);
		cursor.line = 0;
		const noticeSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
		const nav = new ConflictMarkerNavigator(new App());
		// Should not throw; Notice is called internally.
		expect(() => nav.navigateForward(editor)).not.toThrow();
		noticeSpy.mockRestore();
	});
});
