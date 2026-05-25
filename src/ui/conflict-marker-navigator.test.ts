import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type Editor, Notice } from 'obsidian';
import { ConflictMarkerNavigator } from './conflict-marker-navigator';
import { MARKER_LOCAL, MARKER_BASE, MARKER_SEP, MARKER_GROUP } from '../sync/merge';

// ---------------------------------------------------------------------------
// Mock Notice so tests can verify which messages are emitted.
// vi.mock is hoisted, so this replaces the import in the module under test.
// ---------------------------------------------------------------------------

vi.mock('obsidian', async () => {
	const mod = await vi.importActual<typeof import('obsidian')>('obsidian');
	return { ...mod, Notice: vi.fn() };
});

beforeEach(() => {
	vi.clearAllMocks(); // reset Notice call history between tests
});

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
		getCursor:    () => ({ ...cursor }),
		setCursor:    (pos: { line: number; ch: number }) => { cursor.line = pos.line; cursor.ch = pos.ch; },
		getLine:      (n: number) => current[n] ?? '',
		lineCount:    () => current.length,
		scrollIntoView: () => { /* noop */ },
		setSelection: () => { /* noop */ },
		replaceRange: (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
			const before = current.slice(0, from.line);
			const after  = current.slice(to.line + 1);
			current.splice(0, current.length, ...before, ...text.split('\n'), ...after);
		},
	} as unknown as Editor;

	return { editor, cursor, getLines: () => [...current] };
}

// ---------------------------------------------------------------------------
// Shared document fixtures
// ---------------------------------------------------------------------------

/** Minimal 7-line conflict block (A side = local, base, remote). */
const BLOCK_A = [
	MARKER_LOCAL,
	'LOCAL LINE',
	MARKER_BASE,
	'BASE LINE',
	MARKER_SEP,
	'REMOTE LINE',
	MARKER_GROUP,
];

/** A distinct second conflict block. */
const BLOCK_B = [
	MARKER_LOCAL,
	'X',
	MARKER_BASE,
	'Y',
	MARKER_SEP,
	'Z',
	MARKER_GROUP,
];

/** Two blocks separated by a plain line (the typical real-world layout). */
const MID           = 'mid';
const TWO_BLOCK_DOC = [...BLOCK_A, MID, ...BLOCK_B];
const BLOCK_B_START = BLOCK_A.length + 1; // 8 — line where BLOCK_B's MARKER_LOCAL sits

// Shared block descriptor for the first block in a BLOCK_A-only document.
const BLOCK_A_DESC = {
	startLine:   0,
	baseLine:    2,
	sepLine:     4,
	endLine:     6,
	localLines:  ['LOCAL LINE'],
	baseLines:   ['BASE LINE'],
	remoteLines: ['REMOTE LINE'],
};

// ---------------------------------------------------------------------------
// Forward navigation
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — navigateForward', () => {
	it('moves cursor to the startLine of the first conflict block', () => {
		const { editor } = makeEditor([...BLOCK_A]);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('advances from the first block to the second', () => {
		const { editor } = makeEditor(TWO_BLOCK_DOC);
		// cursor starts at 0 (inside block A)
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(BLOCK_B_START);
	});

	it('wraps from the last block back to the first', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = TWO_BLOCK_DOC.length - 1; // past the last block
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('advances to the next block when cursor sits between two blocks', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = BLOCK_A.length; // on the 'mid' separator line
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(BLOCK_B_START);
	});

	it('advances to the next when blocks are adjacent (no gap line)', () => {
		const doc = [...BLOCK_A, ...BLOCK_B];
		const { editor, cursor } = makeEditor(doc);
		cursor.line = 0; // inside block A
		new ConflictMarkerNavigator().navigateForward(editor);
		// Block B starts immediately after block A.
		expect(editor.getCursor().line).toBe(BLOCK_A.length);
	});
});

// ---------------------------------------------------------------------------
// Backward navigation
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — navigateBackward', () => {
	it('moves cursor to the previous conflict block', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = BLOCK_B_START; // at block B
		new ConflictMarkerNavigator().navigateBackward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('wraps from the first block to the last', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = 0; // at block A
		new ConflictMarkerNavigator().navigateBackward(editor);
		expect(editor.getCursor().line).toBe(BLOCK_B_START);
	});

	it('goes to the previous block when cursor sits between two blocks', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = BLOCK_A.length; // on the 'mid' separator line
		new ConflictMarkerNavigator().navigateBackward(editor);
		expect(editor.getCursor().line).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Single-conflict edge cases
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — single-conflict, cursor inside', () => {
	it('does not move cursor forward when already inside the only conflict', () => {
		const { editor, cursor } = makeEditor([...BLOCK_A]);
		cursor.line = 3; // deep inside the block
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(3);
	});

	it('does not move cursor backward when already inside the only conflict', () => {
		const { editor, cursor } = makeEditor([...BLOCK_A]);
		cursor.line = 3;
		new ConflictMarkerNavigator().navigateBackward(editor);
		expect(editor.getCursor().line).toBe(3);
	});

	it('emits "No other conflicts." when cursor is inside the only conflict', () => {
		const { editor, cursor } = makeEditor([...BLOCK_A]);
		cursor.line = 3;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No other conflicts.');
	});

	// The banner/highlight path must be reached even on the first invocation
	// when the cursor starts inside the only conflict.  We can't inspect CM6
	// panel state here, but we CAN confirm navigate() did NOT throw and DID
	// emit the notice — meaning it ran past the old early-return that skipped
	// showBanner/setHighlight entirely.
	it('completes navigation (no throw) with cursor anywhere in the conflict on first use', () => {
		for (const line of [0, 1, 2, 3, 4, 5, 6]) {
			const { editor, cursor } = makeEditor([...BLOCK_A]);
			cursor.line = line;
			vi.mocked(Notice).mockClear();
			expect(() => new ConflictMarkerNavigator().navigateForward(editor)).not.toThrow();
			expect(vi.mocked(Notice)).toHaveBeenCalledWith('No other conflicts.');
		}
	});
});

describe('ConflictMarkerNavigator — single-conflict, cursor outside', () => {
	it('navigates forward to the conflict when cursor is before it', () => {
		const { editor, cursor } = makeEditor(['before', ...BLOCK_A]);
		cursor.line = 0; // above the conflict, which starts at line 1
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(1);
	});

	it('wraps to the conflict when cursor is after it (forward)', () => {
		const { editor, cursor } = makeEditor([...BLOCK_A, 'after']);
		cursor.line = BLOCK_A.length; // below the conflict
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('navigates backward to the conflict when cursor is after it', () => {
		const { editor, cursor } = makeEditor([...BLOCK_A, 'after']);
		cursor.line = BLOCK_A.length;
		new ConflictMarkerNavigator().navigateBackward(editor);
		expect(editor.getCursor().line).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Block parsing correctness
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — block parsing', () => {
	it('parses a block with multiple content lines in each section', () => {
		// Navigate successfully into a multi-line block.
		const doc = [
			MARKER_LOCAL,
			'local 1',
			'local 2',
			MARKER_BASE,
			'base 1',
			'base 2',
			MARKER_SEP,
			'remote 1',
			'remote 2',
			MARKER_GROUP,
		];
		const { editor } = makeEditor(doc);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0); // found the block
	});

	it('finds all three blocks in a three-conflict document', () => {
		const doc = [...BLOCK_A, MID, ...BLOCK_B, MID, ...BLOCK_A];
		const blockCStart = BLOCK_A.length + 1 + BLOCK_B.length + 1;
		const { editor, cursor } = makeEditor(doc);
		cursor.line = BLOCK_B_START; // at block B
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(blockCStart); // advanced to block C
	});

	it('does not parse a block where MARKER_SEP precedes MARKER_BASE', () => {
		// Parser requires BASE before SEP; wrong-order document yields no valid blocks.
		const doc = [
			MARKER_LOCAL,
			'local',
			MARKER_SEP,  // wrong order: should come after MARKER_BASE
			'remote',
			MARKER_BASE,
			'base',
			MARKER_GROUP,
		];
		const { editor, cursor } = makeEditor(doc);
		cursor.line = 4;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(4); // cursor did not move
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});

	it('does not parse an unterminated block (missing MARKER_GROUP)', () => {
		const doc = [MARKER_LOCAL, 'local', MARKER_BASE, 'base', MARKER_SEP, 'remote'];
		const { editor, cursor } = makeEditor(doc);
		cursor.line = 0;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});
});

// ---------------------------------------------------------------------------
// applyResolution
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — applyResolution', () => {
	const nav = new ConflictMarkerNavigator();
	let editor: Editor;
	let getLines: () => string[];

	beforeEach(() => {
		({ editor, getLines } = makeEditor([...BLOCK_A]));
	});

	it('keep local: replaces block with local lines only', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, BLOCK_A_DESC.localLines);
		expect(getLines()).toEqual(['LOCAL LINE']);
	});

	it('keep group: replaces block with remote lines only', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, BLOCK_A_DESC.remoteLines);
		expect(getLines()).toEqual(['REMOTE LINE']);
	});

	it('revert to base: replaces block with base lines only', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, BLOCK_A_DESC.baseLines);
		expect(getLines()).toEqual(['BASE LINE']);
	});

	it('keep all: concatenates all three content sections', () => {
		const all = [...BLOCK_A_DESC.localLines, ...BLOCK_A_DESC.baseLines, ...BLOCK_A_DESC.remoteLines];
		nav.applyResolution(editor, BLOCK_A_DESC, all);
		expect(getLines()).toEqual(['LOCAL LINE', 'BASE LINE', 'REMOTE LINE']);
	});

	it('preserves lines before and after the replaced block', () => {
		const { editor: e } = makeEditor(['before', ...BLOCK_A, 'after']);
		const shifted = { ...BLOCK_A_DESC, startLine: 1, baseLine: 3, sepLine: 5, endLine: 7 };
		nav.applyResolution(e, shifted, shifted.localLines);
		expect(Array.from({ length: e.lineCount() }, (_, i) => e.getLine(i)))
			.toEqual(['before', 'LOCAL LINE', 'after']);
	});

	it('positions cursor at startLine of the replaced block', () => {
		const { editor: e } = makeEditor(['before', ...BLOCK_A, 'after']);
		const shifted = { ...BLOCK_A_DESC, startLine: 1, baseLine: 3, sepLine: 5, endLine: 7 };
		nav.applyResolution(e, shifted, shifted.localLines);
		expect(e.getCursor().line).toBe(1); // startLine of the shifted block
	});

	it('handles an empty resolution (removes all conflict lines)', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, []);
		// replaceRange('', ...) leaves one empty line.
		expect(editor.lineCount()).toBe(1);
		expect(editor.getLine(0)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Resolve-and-advance sequences
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — resolve and advance', () => {
	it('after resolving the first of two blocks, navigates to the second', () => {
		const { editor } = makeEditor(TWO_BLOCK_DOC);
		// cursor starts at 0 (set by makeEditor default)
		const nav = new ConflictMarkerNavigator();

		// Resolve block A (7 lines → 1 'LOCAL LINE'). Block B shifts up by 6.
		nav.applyResolution(editor, BLOCK_A_DESC, BLOCK_A_DESC.localLines);
		// Document now: ['LOCAL LINE', 'mid', ...BLOCK_B] — block B starts at line 2.

		nav.navigateForward(editor);
		expect(editor.getCursor().line).toBe(2);
	});

	it('after resolving the only conflict, reports no conflicts remain', () => {
		const { editor } = makeEditor([...BLOCK_A]);
		const nav = new ConflictMarkerNavigator();
		nav.applyResolution(editor, BLOCK_A_DESC, BLOCK_A_DESC.localLines);
		nav.navigateForward(editor);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});

	it('sequences correctly through all three conflicts when resolving in order', () => {
		// Three conflict blocks, each separated by 'mid'.
		const doc = [...BLOCK_A, MID, ...BLOCK_B, MID, ...BLOCK_A];
		const { editor } = makeEditor(doc);
		const nav = new ConflictMarkerNavigator();

		// 1. Resolve block A (lines 0–6 → 1 line). Blocks shift up by 6.
		nav.applyResolution(editor, BLOCK_A_DESC, BLOCK_A_DESC.localLines);
		// Doc: ['LOCAL LINE', 'mid', ...BLOCK_B (at 2–8), 'mid', ...BLOCK_A (at 10–16)]

		nav.navigateForward(editor); // → block B at line 2
		expect(editor.getCursor().line).toBe(2);

		// 2. Resolve block B (now at lines 2–8 → 1 line). Remaining block shifts up.
		const block2 = { startLine: 2, baseLine: 4, sepLine: 6, endLine: 8,
			localLines: ['X'], baseLines: ['Y'], remoteLines: ['Z'] };
		nav.applyResolution(editor, block2, block2.localLines);
		// Doc: ['LOCAL LINE', 'mid', 'X', 'mid', ...BLOCK_A (at 4–10)]

		nav.navigateForward(editor); // → final block A at line 4
		expect(editor.getCursor().line).toBe(4);

		// 3. Resolve the last block.
		const block3 = { ...BLOCK_A_DESC, startLine: 4, baseLine: 6, sepLine: 8, endLine: 10 };
		nav.applyResolution(editor, block3, block3.localLines);

		nav.navigateForward(editor); // → no conflicts remain
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});
});

// ---------------------------------------------------------------------------
// Notice messages
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — notice messages', () => {
	it('emits "No conflicts found." on a document with no conflict markers', () => {
		const { editor } = makeEditor(['plain text', 'another line']);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});

	it('emits "No other conflicts." when cursor is inside the only conflict', () => {
		const { editor, cursor } = makeEditor([...BLOCK_A]);
		cursor.line = 2;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No other conflicts.');
	});

	it('does not emit "No other conflicts." when navigating between multiple blocks', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = 0;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(vi.mocked(Notice)).not.toHaveBeenCalledWith('No other conflicts.');
		expect(vi.mocked(Notice)).not.toHaveBeenCalledWith('No conflicts found.');
	});
});
