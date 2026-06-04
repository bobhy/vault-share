import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type Editor, Notice } from 'obsidian';
import { ConflictMarkerNavigator, type ConflictBlock } from './conflict-marker-navigator';
import { MARKER_OPEN, MARKER_CLOSE, segmentMarker } from '../sync/nway-merge';

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
// Shared document fixtures (N-way: base + A1 + A2 = 8 lines per region)
// ---------------------------------------------------------------------------

function regionLines(segs: Array<[string, string[]]>): string[] {
	const lines = [MARKER_OPEN];
	for (const [label, l] of segs) lines.push(segmentMarker(label), ...l);
	lines.push(MARKER_CLOSE);
	return lines;
}

/** Minimal 8-line conflict region (base + A1 + A2). */
const BLOCK_A = regionLines([['base', ['BASE LINE']], ['A1', ['LOCAL LINE']], ['A2', ['REMOTE LINE']]]);
/** A distinct second region. */
const BLOCK_B = regionLines([['base', ['Y']], ['A1', ['X']], ['A2', ['Z']]]);

const MID           = 'mid';
const TWO_BLOCK_DOC = [...BLOCK_A, MID, ...BLOCK_B];
const BLOCK_B_START = BLOCK_A.length + 1; // 9 — line where BLOCK_B's MARKER_OPEN sits

/** Block descriptor for the first region in a BLOCK_A-only document. */
const BLOCK_A_DESC: ConflictBlock = {
	startLine: 0,
	endLine: 7,
	segments: [
		{ label: 'base', lines: ['BASE LINE'] },
		{ label: 'A1', lines: ['LOCAL LINE'] },
		{ label: 'A2', lines: ['REMOTE LINE'] },
	],
};

// ---------------------------------------------------------------------------
// Forward navigation
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — navigateForward', () => {
	it('moves cursor to the startLine of the first conflict region', () => {
		const { editor } = makeEditor([...BLOCK_A]);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('advances from the first region to the second', () => {
		const { editor } = makeEditor(TWO_BLOCK_DOC);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(BLOCK_B_START);
	});

	it('wraps from the last region back to the first', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = TWO_BLOCK_DOC.length - 1;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('advances to the next region when cursor sits between two regions', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = BLOCK_A.length; // on the 'mid' separator line
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(BLOCK_B_START);
	});

	it('advances to the next when regions are adjacent (no gap line)', () => {
		const doc = [...BLOCK_A, ...BLOCK_B];
		const { editor, cursor } = makeEditor(doc);
		cursor.line = 0;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(BLOCK_A.length);
	});
});

// ---------------------------------------------------------------------------
// Backward navigation
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — navigateBackward', () => {
	it('moves cursor to the previous conflict region', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = BLOCK_B_START;
		new ConflictMarkerNavigator().navigateBackward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('wraps from the first region to the last', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = 0;
		new ConflictMarkerNavigator().navigateBackward(editor);
		expect(editor.getCursor().line).toBe(BLOCK_B_START);
	});

	it('goes to the previous region when cursor sits between two regions', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = BLOCK_A.length;
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
		cursor.line = 3;
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

	it('completes navigation (no throw) with cursor anywhere in the conflict on first use', () => {
		for (const line of [0, 1, 2, 3, 4, 5, 6, 7]) {
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
		cursor.line = 0;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(1);
	});

	it('wraps to the conflict when cursor is after it (forward)', () => {
		const { editor, cursor } = makeEditor([...BLOCK_A, 'after']);
		cursor.line = BLOCK_A.length;
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
// Region parsing correctness
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — region parsing', () => {
	it('parses a region with multiple content lines per segment', () => {
		const doc = regionLines([
			['base', ['base 1', 'base 2']],
			['A1', ['local 1', 'local 2']],
			['A2', ['remote 1', 'remote 2']],
		]);
		const { editor } = makeEditor(doc);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('parses a region with three alternatives (A1/A2/A3)', () => {
		const doc = regionLines([['base', ['O']], ['A1', ['A']], ['A2', ['B']], ['A3', ['C']]]);
		const { editor } = makeEditor(doc);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(0);
	});

	it('finds all three regions in a three-conflict document', () => {
		const doc = [...BLOCK_A, MID, ...BLOCK_B, MID, ...BLOCK_A];
		const blockCStart = BLOCK_A.length + 1 + BLOCK_B.length + 1; // 18
		const { editor, cursor } = makeEditor(doc);
		cursor.line = BLOCK_B_START;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(editor.getCursor().line).toBe(blockCStart);
	});

	it('skips a region with only one segment (no real choice)', () => {
		const doc = [MARKER_OPEN, segmentMarker('A1'), 'only', MARKER_CLOSE];
		const { editor } = makeEditor(doc);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});

	it('does not parse an unterminated region (missing MARKER_CLOSE)', () => {
		const doc = [MARKER_OPEN, segmentMarker('base'), 'base', segmentMarker('A1'), 'a'];
		const { editor } = makeEditor(doc);
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});
});

// ---------------------------------------------------------------------------
// applyResolution — choosing exactly one segment
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — applyResolution', () => {
	const nav = new ConflictMarkerNavigator();
	let editor: Editor;
	let getLines: () => string[];

	beforeEach(() => {
		({ editor, getLines } = makeEditor([...BLOCK_A]));
	});

	it('choose A1: replaces the region with that alternative only', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, ['LOCAL LINE']);
		expect(getLines()).toEqual(['LOCAL LINE']);
	});

	it('choose A2: replaces the region with that alternative only', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, ['REMOTE LINE']);
		expect(getLines()).toEqual(['REMOTE LINE']);
	});

	it('choose base: replaces the region with the base segment only', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, ['BASE LINE']);
		expect(getLines()).toEqual(['BASE LINE']);
	});

	it('preserves lines before and after the replaced region', () => {
		const { editor: e } = makeEditor(['before', ...BLOCK_A, 'after']);
		const shifted: ConflictBlock = { ...BLOCK_A_DESC, startLine: 1, endLine: 8 };
		nav.applyResolution(e, shifted, ['LOCAL LINE']);
		expect(Array.from({ length: e.lineCount() }, (_, i) => e.getLine(i)))
			.toEqual(['before', 'LOCAL LINE', 'after']);
	});

	it('positions cursor at startLine of the replaced region', () => {
		const { editor: e } = makeEditor(['before', ...BLOCK_A, 'after']);
		const shifted: ConflictBlock = { ...BLOCK_A_DESC, startLine: 1, endLine: 8 };
		nav.applyResolution(e, shifted, ['LOCAL LINE']);
		expect(e.getCursor().line).toBe(1);
	});

	it('handles an empty resolution (removes all conflict lines)', () => {
		nav.applyResolution(editor, BLOCK_A_DESC, []);
		expect(editor.lineCount()).toBe(1);
		expect(editor.getLine(0)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Resolve-and-advance sequences
// ---------------------------------------------------------------------------

describe('ConflictMarkerNavigator — resolve and advance', () => {
	it('after resolving the first of two regions, navigates to the second', () => {
		const { editor } = makeEditor(TWO_BLOCK_DOC);
		const nav = new ConflictMarkerNavigator();

		// Resolve region A (8 lines → 1). Region B shifts up to line 2.
		nav.applyResolution(editor, BLOCK_A_DESC, ['LOCAL LINE']);
		nav.navigateForward(editor);
		expect(editor.getCursor().line).toBe(2);
	});

	it('after resolving the only conflict, reports no conflicts remain', () => {
		const { editor } = makeEditor([...BLOCK_A]);
		const nav = new ConflictMarkerNavigator();
		nav.applyResolution(editor, BLOCK_A_DESC, ['LOCAL LINE']);
		nav.navigateForward(editor);
		expect(vi.mocked(Notice)).toHaveBeenCalledWith('No conflicts found.');
	});

	it('sequences correctly through all three conflicts when resolving in order', () => {
		const doc = [...BLOCK_A, MID, ...BLOCK_B, MID, ...BLOCK_A];
		const { editor } = makeEditor(doc);
		const nav = new ConflictMarkerNavigator();

		// 1. Resolve region A (lines 0–7 → 1). Regions shift up by 7.
		nav.applyResolution(editor, BLOCK_A_DESC, ['LOCAL LINE']);
		nav.navigateForward(editor); // → region B at line 2
		expect(editor.getCursor().line).toBe(2);

		// 2. Resolve region B (now at lines 2–9 → 1).
		const block2: ConflictBlock = {
			startLine: 2, endLine: 9,
			segments: [{ label: 'base', lines: ['Y'] }, { label: 'A1', lines: ['X'] }, { label: 'A2', lines: ['Z'] }],
		};
		nav.applyResolution(editor, block2, ['X']);
		nav.navigateForward(editor); // → final region at line 4
		expect(editor.getCursor().line).toBe(4);

		// 3. Resolve the last region.
		const block3: ConflictBlock = { ...BLOCK_A_DESC, startLine: 4, endLine: 11 };
		nav.applyResolution(editor, block3, ['LOCAL LINE']);
		nav.navigateForward(editor);
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

	it('does not emit "No other conflicts." when navigating between multiple regions', () => {
		const { editor, cursor } = makeEditor(TWO_BLOCK_DOC);
		cursor.line = 0;
		new ConflictMarkerNavigator().navigateForward(editor);
		expect(vi.mocked(Notice)).not.toHaveBeenCalledWith('No other conflicts.');
		expect(vi.mocked(Notice)).not.toHaveBeenCalledWith('No conflicts found.');
	});
});
