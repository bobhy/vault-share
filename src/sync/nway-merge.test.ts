/**
 * Executable contract for the flat N-way conflict engine.
 *
 * These tests encode the design in `specs/nway-conflict.md`. They are written
 * tests-first: `parseConflictFile` / `emitConflictFile` / `reconcileText` are
 * stubbed and throw, so this whole file is RED until the engine is implemented.
 *
 * Format reminder: a region is `base` plus alternatives `A1`, `A2`, … each
 * introduced by `` `===== <label>` ``. Labelling is append-only and
 * Drive-anchored: a fold preserves the incoming (remote/Drive) file's labels and
 * appends its own new contribution LAST with the next free number — not sorted by
 * content. The push decision is set-based; a no-op fold adopts Drive's bytes.
 */
import { describe, it, expect } from 'vitest';
import {
	MARKER_OPEN, MARKER_CLOSE, segmentMarker,
	hasConflictMarkers, isMergeEligible, parseConflictFile, emitConflictFile, reconcileText,
	type RegionSegment,
} from './nway-merge';

/** Build a one-region file. `segs` are emitted in the given order (caller supplies canonical order). */
function nway(segs: Array<[string, string[]]>, prefix: string[] = [], suffix: string[] = []): string {
	const lines = [...prefix, MARKER_OPEN];
	for (const [label, l] of segs) lines.push(segmentMarker(label), ...l);
	lines.push(MARKER_CLOSE, ...suffix);
	return lines.join('\n');
}

/** Pull the single region's segments out of a reconcile/parse result for assertions. */
function regionSegments(text: string): RegionSegment[] {
	const seg = parseConflictFile(text)!.segments.find(s => s.kind === 'region');
	if (seg?.kind !== 'region') throw new Error('no region found');
	return seg.region.segments;
}

describe('hasConflictMarkers', () => {
	it('detects a region', () => {
		expect(hasConflictMarkers(nway([['base', ['o']], ['A1', ['a']], ['A2', ['b']]]))).toBe(true);
	});
	it('is false for plain text', () => {
		expect(hasConflictMarkers('just a note')).toBe(false);
	});
});

describe('isMergeEligible', () => {
	it('accepts .md and .txt, case-insensitively', () => {
		expect(isMergeEligible('note.md')).toBe(true);
		expect(isMergeEligible('subdir/note.md')).toBe(true);
		expect(isMergeEligible('readme.txt')).toBe(true);
		expect(isMergeEligible('NOTE.MD')).toBe(true);
	});
	it('rejects non-text, no-extension, and dotfile names', () => {
		expect(isMergeEligible('data.json')).toBe(false);
		expect(isMergeEligible('image.png')).toBe(false);
		expect(isMergeEligible('noextension')).toBe(false);
		expect(isMergeEligible('note.md.bak')).toBe(false);
		expect(isMergeEligible('.obsidian')).toBe(false); // eslint-disable-line obsidianmd/hardcoded-config-path
	});
});

describe('parse / emit round-trip (invariant 4)', () => {
	it('parse∘emit reproduces a two-alternative file byte-for-byte', () => {
		const text = nway([['base', ['base']], ['A1', ['local']], ['A2', ['remote']]], ['# title', ''], ['', 'tail']);
		expect(emitConflictFile(parseConflictFile(text)!)).toBe(text);
	});

	it('parse∘emit reproduces a three-alternative file', () => {
		const text = nway([['base', ['O']], ['A1', ['A']], ['A2', ['B']], ['A3', ['C']]]);
		expect(emitConflictFile(parseConflictFile(text)!)).toBe(text);
	});

	it('parses base and labelled alternatives as distinct segments', () => {
		const segs = regionSegments(nway([['base', ['O']], ['A1', ['A']], ['A2', ['B']]]));
		expect(segs).toEqual([
			{ label: 'base', lines: ['O'] },
			{ label: 'A1', lines: ['A'] },
			{ label: 'A2', lines: ['B'] },
		]);
	});

	it('handles multiple disjoint regions in one file', () => {
		const text = [
			nway([['base', ['o1']], ['A1', ['a1']], ['A2', ['b1']]]),
			'stable middle',
			nway([['base', ['o2']], ['A1', ['a2']], ['A2', ['b2']]]),
		].join('\n');
		const parsed = parseConflictFile(text)!;
		expect(parsed.segments.filter(s => s.kind === 'region')).toHaveLength(2);
		expect(emitConflictFile(parsed)).toBe(text);
	});
});

describe('parse rejects malformed input → null (invariant 3, keep-both)', () => {
	it('rejects unbalanced markers (open without close)', () => {
		expect(parseConflictFile(`${MARKER_OPEN}\n${segmentMarker('base')}\no`)).toBeNull();
	});
	it('rejects a region with no base', () => {
		const t = `${MARKER_OPEN}\n${segmentMarker('A1')}\na\n${segmentMarker('A2')}\nb\n${MARKER_CLOSE}`;
		expect(parseConflictFile(t)).toBeNull();
	});
	it('rejects two base segments in one region', () => {
		const t = `${MARKER_OPEN}\n${segmentMarker('base')}\no\n${segmentMarker('base')}\no2\n${MARKER_CLOSE}`;
		expect(parseConflictFile(t)).toBeNull();
	});
	it('rejects a region with fewer than two alternatives', () => {
		const t = `${MARKER_OPEN}\n${segmentMarker('base')}\no\n${segmentMarker('A1')}\na\n${MARKER_CLOSE}`;
		expect(parseConflictFile(t)).toBeNull();
	});
	it('rejects the historical garbled file (unbalanced legacy markers)', () => {
		const garbled = ['`<<<<< local`', '`||||| base`', '`=====`', '`>>>>> group`', '`>>>>> group`'].join('\n');
		expect(parseConflictFile(garbled)).toBeNull();
	});
});

describe('reconcileText — clean short-circuits (decision table)', () => {
	it('local == base ⇒ adopt remote, clean', () => {
		expect(reconcileText('O', 'O', 'R')).toEqual({ kind: 'clean', content: 'R' });
	});
	it('remote == base ⇒ adopt local, clean (a resolution drains here)', () => {
		expect(reconcileText('O', 'L', 'O')).toEqual({ kind: 'clean', content: 'L' });
	});
	it('local == remote ⇒ that text, clean', () => {
		expect(reconcileText('O', 'S', 'S')).toEqual({ kind: 'clean', content: 'S' });
	});
	it('non-overlapping clean edits ⇒ clean diff3 merge, no markers', () => {
		expect(reconcileText('a\nb\nc', 'A\nb\nc', 'a\nb\nC')).toEqual({ kind: 'clean', content: 'A\nb\nC' });
	});
});

describe('reconcileText — mint (clean/clean overlap, the only diff3)', () => {
	it('two clean files diverging on the same line mint a 2-alternative region (local=A1, remote=A2)', () => {
		const r = reconcileText('a\nO\nc', 'a\nL\nc', 'a\nR\nc'); // local L, remote R
		expect(r.kind).toBe('folded');
		if (r.kind === 'folded') {
			expect(r.changed).toBe(true);
			expect(regionSegments(r.content)).toEqual([
				{ label: 'base', lines: ['O'] },
				{ label: 'A1', lines: ['L'] },
				{ label: 'A2', lines: ['R'] },
			]);
		}
	});
});

describe('reconcileText — fold clean into N-way (rule 2)', () => {
	const base = 'a\nO\nc';
	const nwayLR = nway([['base', ['O']], ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']);

	it('a genuinely new clean alternative is appended LAST with the next number (not sorted)', () => {
		// 'B' sorts before L and R, but append-only puts it last as A3.
		const r = reconcileText(base, 'a\nB\nc', nwayLR);
		expect(r.kind).toBe('folded');
		if (r.kind === 'folded') {
			expect(r.changed).toBe(true);
			expect(regionSegments(r.content)).toEqual([
				{ label: 'base', lines: ['O'] },
				{ label: 'A1', lines: ['L'] },
				{ label: 'A2', lines: ['R'] },
				{ label: 'A3', lines: ['B'] },
			]);
		}
	});

	it('a clean side equal to an existing alternative is a no-op (changed: false, anti-thrash)', () => {
		expect(reconcileText(base, 'a\nL\nc', nwayLR)).toMatchObject({ kind: 'folded', changed: false });
	});

	it('a clean side equal to the base contributes nothing (no-op)', () => {
		expect(reconcileText(base, base, nwayLR)).toMatchObject({ kind: 'folded', changed: false });
	});

	it('a clean side that also diverges OUTSIDE the region span ⇒ keep-both', () => {
		expect(reconcileText(base, 'Z\nX\nc', nwayLR)).toEqual({ kind: 'keepBoth' }); // changed stable line 1
	});
});

describe('reconcileText — fold N-way into N-way (rule 3, union)', () => {
	const base = 'a\nO\nc';

	it('same base & span ⇒ union, anchored to remote (Drive) labels, local extra appended last', () => {
		const remote = nway([['base', ['O']], ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']); // Drive = anchor
		const local  = nway([['base', ['O']], ['A1', ['M']], ['A2', ['R']]], ['a'], ['c']); // M new, R shared
		const r = reconcileText(base, local, remote);
		expect(r.kind).toBe('folded');
		if (r.kind === 'folded') {
			expect(r.changed).toBe(true);
			// Drive's L=A1, R=A2 are kept; local's new M is appended as A3 (not local's own A1).
			expect(regionSegments(r.content)).toEqual([
				{ label: 'base', lines: ['O'] },
				{ label: 'A1', lines: ['L'] },
				{ label: 'A2', lines: ['R'] },
				{ label: 'A3', lines: ['M'] },
			]);
		}
	});

	it('identical N-way on both sides ⇒ idempotent no-op (changed: false)', () => {
		const same = nway([['base', ['O']], ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']);
		expect(reconcileText(base, same, same)).toMatchObject({ kind: 'folded', changed: false });
	});

	it('same contribution set, different labels ⇒ no-op that adopts Drive bytes (set-based, no thrash)', () => {
		const remote = nway([['base', ['O']], ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']); // Drive
		const local  = nway([['base', ['O']], ['A1', ['R']], ['A2', ['L']]], ['a'], ['c']); // same set, swapped labels
		// Local adds nothing Drive lacks ⇒ no push, and the result is Drive's bytes verbatim.
		expect(reconcileText(base, local, remote)).toEqual({ kind: 'folded', changed: false, content: remote });
	});

	it('different embedded base ⇒ keep-both', () => {
		const local  = nway([['base', ['O']],  ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']);
		const remote = nway([['base', ['OO']], ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']);
		expect(reconcileText(base, local, remote)).toEqual({ kind: 'keepBoth' });
	});

	it('different region span ⇒ keep-both', () => {
		const local  = nway([['base', ['O']],      ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']);
		const remote = nway([['base', ['O', 'c']], ['A1', ['L']], ['A2', ['R']]], ['a'], []); // span swallows suffix
		expect(reconcileText(base, local, remote)).toEqual({ kind: 'keepBoth' });
	});
});

describe('reconcileText — keep-both on unparseable input', () => {
	it('a malformed/garbled marker file on either side ⇒ keep-both', () => {
		const garbled = `${MARKER_OPEN}\n${segmentMarker('base')}\n${MARKER_CLOSE}\n${MARKER_CLOSE}`;
		expect(reconcileText('O', 'L', garbled)).toEqual({ kind: 'keepBoth' });
	});
});

describe('reconcileText — N-way local vs clean remote (push the richer file)', () => {
	const base = 'a\nO\nc';
	const localNway = nway([['base', ['O']], ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']);

	it('clean remote equals an existing alternative ⇒ push our N-way unchanged (changed: true)', () => {
		// Drive went clean (== one alternative); we still hold the conflict → push the richer file.
		const r = reconcileText(base, localNway, 'a\nL\nc');
		expect(r).toEqual({ kind: 'folded', changed: true, content: localNway });
	});

	it('clean remote is a new version ⇒ fold it in and push (changed: true)', () => {
		const r = reconcileText(base, localNway, 'a\nX\nc');
		expect(r.kind).toBe('folded');
		if (r.kind === 'folded') {
			expect(r.changed).toBe(true);
			expect(regionSegments(r.content)).toEqual([
				{ label: 'base', lines: ['O'] },
				{ label: 'A1', lines: ['L'] },
				{ label: 'A2', lines: ['R'] },
				{ label: 'A3', lines: ['X'] },
			]);
		}
	});
});

describe('reconcileText — marker-bearing local == remote', () => {
	it('identical N-way text on both sides ⇒ folded no-op, content unchanged', () => {
		const m = nway([['base', ['O']], ['A1', ['L']], ['A2', ['R']]], ['a'], ['c']);
		expect(reconcileText('a\nO\nc', m, m)).toEqual({ kind: 'folded', changed: false, content: m });
	});
});

// --- multi-client simulation ------------------------------------------------
// Drive plus N devices, driven only through reconcileText. The harness encodes
// the base-management contract the syncer must follow: a device's stored base
// advances to whatever it last synced (clean OR N-way), and a clean result is
// pushed when it differs from Drive.

interface Client { base: string; local: string }
interface Drive { text: string }

function sync(c: Client, drive: Drive): void {
	const r = reconcileText(c.base, c.local, drive.text);
	if (r.kind === 'keepBoth') throw new Error('unexpected keep-both');
	c.local = r.content;
	c.base = r.content;            // base tracks last-synced content (may be N-way)
	if (r.kind === 'clean') { if (r.content !== drive.text) drive.text = r.content; }
	else if (r.changed) drive.text = r.content;
}

/** Bodies of the single region's alternatives (the lines under each `A<n>`), as a set. */
function altBodies(text: string): Set<string> {
	return new Set(regionSegments(text).filter(s => s.label !== 'base').map(s => s.lines.join('\n')));
}

describe('reconcileText — three clients contribute, one resolves, all converge', () => {
	const O = 'h\nO\nf';

	it('accumulates three contributions on Drive, then a clean resolution drains to every client', () => {
		const drive: Drive = { text: O };
		const A: Client = { base: O, local: O };
		const B: Client = { base: O, local: O };
		const C: Client = { base: O, local: O };

		// Each device edits the same line, then syncs in turn.
		A.local = 'h\nA\nf'; sync(A, drive); // clean push: Drive = A's version
		B.local = 'h\nB\nf'; sync(B, drive); // mint: Drive = conflict {A, B}
		C.local = 'h\nC\nf'; sync(C, drive); // fold:  Drive = conflict {A, B, C}

		expect(hasConflictMarkers(drive.text)).toBe(true);
		expect(altBodies(drive.text)).toEqual(new Set(['A', 'B', 'C']));

		// A and B catch up to the full three-way conflict (idempotent, no thrash).
		sync(A, drive); sync(B, drive);
		const full = drive.text;
		for (const dev of [A, B, C]) expect(dev.local).toBe(full);
		sync(A, drive); sync(B, drive); sync(C, drive);
		expect(drive.text).toBe(full); // second pass moves nothing

		// A resolves the conflict to B's version and syncs — a clean push.
		A.local = 'h\nB\nf'; sync(A, drive);
		expect(hasConflictMarkers(drive.text)).toBe(false);
		expect(drive.text).toBe('h\nB\nf');

		// The resolution drains to the other clients on their next sync.
		sync(B, drive); sync(C, drive);
		for (const dev of [A, B, C]) {
			expect(dev.local).toBe('h\nB\nf');
			expect(hasConflictMarkers(dev.local)).toBe(false);
		}
	});

	it('two clients resolving differently re-conflict cleanly (clean-base, no garble)', () => {
		const drive: Drive = { text: O };
		const A: Client = { base: O, local: O };
		const B: Client = { base: O, local: O };

		A.local = 'h\nA\nf'; sync(A, drive);
		B.local = 'h\nB\nf'; sync(B, drive); // Drive = conflict {A, B}
		sync(A, drive);                       // both at the conflict, base = N-way
		const conflict = drive.text;
		expect(A.base).toBe(conflict);
		expect(B.base).toBe(conflict);

		// A resolves to A's line and pushes a clean file.
		A.local = 'h\nA\nf'; sync(A, drive);
		expect(hasConflictMarkers(drive.text)).toBe(false);

		// B independently resolves to B's line BEFORE pulling, then syncs.
		// Its base is the N-way file (markers) — the engine must diff3 against the
		// embedded clean base, not the markers, producing a fresh, well-formed conflict.
		B.local = 'h\nB\nf'; sync(B, drive);
		expect(hasConflictMarkers(drive.text)).toBe(true);
		expect(parseConflictFile(drive.text)).not.toBeNull(); // balanced, not garbled
		expect(altBodies(drive.text)).toEqual(new Set(['A', 'B']));
	});
});
