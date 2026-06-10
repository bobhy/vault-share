/**
 * Flat, N-way text conflict representation and combination.
 *
 * Replaces the original two-way `diff3` marker scheme for unresolved conflicts. The governing rule: `diff3` runs **only on clean
 * text**; marker-bearing text is never fed to a three-way merge. Once a conflict
 * exists it only grows by **union of distinct contributions that share a common
 * base**, de-duplicated by content. Anything that does not fit falls back to
 * *keep-both*.
 *
 * Each divergent version is labelled `A1`, `A2`, … (the base is labelled
 * `base`). A label names a *contribution* — one coherent across-region version —
 * not a device: the same label is stamped in every region a single fold touched,
 * so "choose `A2` in every region" reconstructs the whole version that
 * contribution introduced. Labels are **append-only and Drive-anchored**: a fold
 * preserves the incoming (Drive) file's labels and gives its own new contribution
 * the next free number (taken across *all* regions), placing it **last** in each
 * region it touches. Identity for de-dup is **content**; the push decision is
 * **set-based** (push only when our contributions add something Drive lacks), so
 * Drive's contribution set grows monotonically and devices converge to Drive's
 * bytes. Concurrent independent folds may briefly assign the same local number to
 * different content; the set-based no-thrash rule keeps them from fighting and the
 * first push wins the anchor.
 *
 * Conceptual reference: [`specs/nway-conflict.md`](../../specs/nway-conflict.md).
 *
 * @packageDocumentation
 */
import { diff3Merge, diffIndices } from 'node-diff3';

/** Region delimiters. Backtick-fenced so they render as inline code and never
 * collide with Markdown's `=====` setext underline. */
export const MARKER_OPEN  = '`<<<<< conflict`';
export const MARKER_CLOSE = '`>>>>> conflict`';

/** Reserved label for the common-ancestor segment. */
export const BASE_LABEL = 'base';

/** The line that introduces a segment with the given label, e.g. `` `===== A1` ``. */
export function segmentMarker(label: string): string {
	return `\`===== ${label}\``;
}

/** Matches a segment-introducer line and captures its label. */
export const SEGMENT_MARKER_RE = /^`===== (base|A\d+)`$/;

/** One labelled segment of a region: the base or one alternative. */
export interface RegionSegment {
	/** `base`, or `A1` / `A2` / … */
	label: string;
	lines: string[];
}

/**
 * One contiguous conflicted span. Carries the common ancestor (`base`, always
 * present and itself a selectable resolution target) plus N ≥ 2 alternatives,
 * each labelled. Ordering is canonical (`base` first, then `A1…An` by content).
 */
export interface ConflictRegion {
	segments: RegionSegment[];
}

/** A run of stable lines, or one conflict region. */
export type Segment =
	| { kind: 'stable'; lines: string[] }
	| { kind: 'region'; region: ConflictRegion };

/** A file decomposed into stable runs interleaved with conflict regions. */
export interface ParsedFile {
	segments: Segment[];
}

/**
 * Outcome of {@link reconcileText}.
 * - `clean`  — the sides reduce to a single marker-free version.
 * - `folded` — a (possibly grown) N-way file; `changed` is false for an
 *   idempotent no-op (every contribution already present).
 * - `keepBoth` — the caller must fall back to keep-both conflict copies.
 */
export type ReconcileResult =
	| { kind: 'clean'; content: string }
	| { kind: 'folded'; content: string; changed: boolean }
	| { kind: 'keepBoth' };

/** True when `text` contains at least one well-formed conflict region. */
export function hasConflictMarkers(text: string): boolean {
	return text.includes(MARKER_OPEN);
}

/** Text file extensions eligible for three-way merge. */
const MERGE_ELIGIBLE_EXTS = new Set(['.md', '.txt']);

/**
 * Returns true when the file at `path` is eligible for text merge.
 * Only `.md` and `.txt` are eligible; JSON, YAML, and binary are not.
 */
export function isMergeEligible(path: string): boolean {
	const dot = path.lastIndexOf('.');
	if (dot === -1) return false;
	return MERGE_ELIGIBLE_EXTS.has(path.slice(dot).toLowerCase());
}

/** Any line that begins like one of our (or the legacy) conflict markers. */
const MARKER_LIKE_RE = /^`(<<<<<|>>>>>|=====|\|\|\|\|\|)/;

function splitLines(text: string): string[] {
	return text.split('\n');
}

function joinLines(lines: string[]): string {
	return lines.join('\n');
}

function isMarkerLike(line: string): boolean {
	return MARKER_LIKE_RE.test(line);
}

/** True when any line looks like a conflict marker (new or legacy/garbled). */
function looksLikeConflict(text: string): boolean {
	return splitLines(text).some(isMarkerLike);
}

function validRegion(segs: RegionSegment[]): boolean {
	const baseCount = segs.filter(s => s.label === BASE_LABEL).length;
	const altCount = segs.length - baseCount;
	return baseCount === 1 && altCount >= 2;
}

/** Parse the body of one region starting just after {@link MARKER_OPEN}. */
function parseRegion(lines: string[], start: number): { region: ConflictRegion; next: number } | null {
	const segs: RegionSegment[] = [];
	let current: RegionSegment | null = null;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i]!;
		if (line === MARKER_CLOSE) {
			if (current) segs.push(current);
			return validRegion(segs) ? { region: { segments: segs }, next: i + 1 } : null;
		}
		if (line === MARKER_OPEN) return null; // no nesting
		const m = SEGMENT_MARKER_RE.exec(line);
		if (m) {
			if (current) segs.push(current);
			current = { label: m[1]!, lines: [] };
			continue;
		}
		if (isMarkerLike(line)) return null; // stray/legacy marker inside a region
		if (!current) return null;           // content before the first segment marker
		current.lines.push(line);
	}
	return null; // ran off the end with no close
}

/**
 * Parse `text` into stable runs and conflict regions. Returns `null` when the
 * text is not well-formed (unbalanced markers, missing/duplicate base, a region
 * with < 2 alternatives, a stray/legacy marker line) — the caller then resolves
 * as keep-both. Round-trips with {@link emitConflictFile}.
 */
export function parseConflictFile(text: string): ParsedFile | null {
	const lines = splitLines(text);
	const segments: Segment[] = [];
	let stable: string[] = [];
	const flush = (): void => { if (stable.length) { segments.push({ kind: 'stable', lines: stable }); stable = []; } };

	for (let i = 0; i < lines.length;) {
		const line = lines[i]!;
		if (line === MARKER_OPEN) {
			flush();
			const parsed = parseRegion(lines, i + 1);
			if (!parsed) return null;
			segments.push({ kind: 'region', region: parsed.region });
			i = parsed.next;
			continue;
		}
		if (isMarkerLike(line)) return null; // a marker line outside any region
		stable.push(line);
		i++;
	}
	flush();
	return { segments };
}

/** Serialize a {@link ParsedFile} back to text. Inverse of {@link parseConflictFile}. */
export function emitConflictFile(parsed: ParsedFile): string {
	const out: string[] = [];
	for (const seg of parsed.segments) {
		if (seg.kind === 'stable') {
			out.push(...seg.lines);
		} else {
			out.push(MARKER_OPEN);
			for (const s of seg.region.segments) {
				out.push(segmentMarker(s.label));
				out.push(...s.lines);
			}
			out.push(MARKER_CLOSE);
		}
	}
	return joinLines(out);
}

// --- internal helpers for reconcileText ----------------------------------

interface DiffBlock { buffer1: [number, number]; buffer2: [number, number]; }

function regionsOf(p: ParsedFile): ConflictRegion[] {
	return p.segments.filter((s): s is { kind: 'region'; region: ConflictRegion } => s.kind === 'region').map(s => s.region);
}

function baseSegmentOf(r: ConflictRegion): string[] {
	return r.segments.find(s => s.label === BASE_LABEL)?.lines ?? [];
}

/** The full base reconstruction: stable runs plus each region's base segment. */
function baseReconLines(p: ParsedFile): string[] {
	const out: string[] = [];
	for (const seg of p.segments) {
		if (seg.kind === 'stable') out.push(...seg.lines);
		else out.push(...baseSegmentOf(seg.region));
	}
	return out;
}

/** Region base-line ranges within {@link baseReconLines}, as `[start, end)`. */
function regionRanges(p: ParsedFile): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let idx = 0;
	for (const seg of p.segments) {
		if (seg.kind === 'stable') { idx += seg.lines.length; continue; }
		const len = baseSegmentOf(seg.region).length;
		ranges.push({ start: idx, end: idx + len });
		idx += len;
	}
	return ranges;
}

/** Structural skeleton (stable runs + per-region base) for equality between two N-way files. */
function skeletonOf(p: ParsedFile): string {
	return JSON.stringify(p.segments.map(s => s.kind === 'stable' ? ['S', s.lines] : ['R', baseSegmentOf(s.region)]));
}

function linesEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((l, i) => l === b[i]);
}

/** A contribution: its lines per region (`null` where it equals the base / is absent). */
type Vec = Array<string[] | null>;

function normKey(vec: Vec, regions: ConflictRegion[]): string {
	return JSON.stringify(vec.map((s, i) => s ?? baseSegmentOf(regions[i]!)));
}

/** Extract contributions (label → per-region lines) in first-seen label order. */
function contributionsOf(p: ParsedFile): { order: string[]; map: Map<string, Vec> } {
	const regions = regionsOf(p);
	const map = new Map<string, Vec>();
	const order: string[] = [];
	regions.forEach((reg, ri) => {
		for (const seg of reg.segments) {
			if (seg.label === BASE_LABEL) continue;
			let vec = map.get(seg.label);
			if (!vec) { vec = new Array<string[] | null>(regions.length).fill(null); map.set(seg.label, vec); order.push(seg.label); }
			vec[ri] = seg.lines;
		}
	});
	return { order, map };
}

function maxAltNumber(labels: string[]): number {
	let max = 0;
	for (const l of labels) { const m = /^A(\d+)$/.exec(l); if (m) max = Math.max(max, Number(m[1])); }
	return max;
}

/** Rebuild file text from a structure (stable runs + region bases) plus ordered contributions. */
function emitFromContributions(skeleton: ParsedFile, regions: ConflictRegion[], contribs: Array<{ label: string; vec: Vec }>): string {
	const segments: Segment[] = [];
	let ri = 0;
	for (const seg of skeleton.segments) {
		if (seg.kind === 'stable') { segments.push(seg); continue; }
		const region = regions[ri]!;
		const segs: RegionSegment[] = [{ label: BASE_LABEL, lines: baseSegmentOf(region) }];
		for (const c of contribs) {
			const lines = c.vec[ri];
			if (lines != null) segs.push({ label: c.label, lines });
		}
		segments.push({ kind: 'region', region: { segments: segs } });
		ri++;
	}
	return emitConflictFile({ segments });
}

/** Localize a clean file into the region structure of `anchor`; returns per-region slices or `null`. */
function localizeClean(anchor: ParsedFile, base: string, cleanText: string): Vec | null {
	if (joinLines(baseReconLines(anchor)) !== base) return null; // base mismatch
	const recon = baseReconLines(anchor);
	const cleanLines = splitLines(cleanText);
	const ranges = regionRanges(anchor);
	const blocks = diffIndices(recon, cleanLines) as unknown as DiffBlock[];

	// Every change must fall entirely within a single region span.
	for (const b of blocks) {
		const [o, l] = b.buffer1;
		const inside = ranges.some(r => o >= r.start && o + l <= r.end && (l > 0 || (o >= r.start && o <= r.end)));
		if (!inside) return null;
	}

	const regions = regionsOf(anchor);
	const slices: Vec = new Array<string[] | null>(ranges.length).fill(null);
	const delta = (b: DiffBlock): number => b.buffer2[1] - b.buffer1[1];
	const endsBy = (b: DiffBlock, pos: number): boolean => b.buffer1[0] + b.buffer1[1] <= pos;
	let shift = 0;
	let bi = 0;
	ranges.forEach(({ start, end }, ri) => {
		for (let b = blocks[bi]; b && endsBy(b, start); b = blocks[bi]) { shift += delta(b); bi++; }
		const cStart = start + shift;
		let withinDelta = 0;
		for (let b = blocks[bi]; b && b.buffer1[0] >= start && endsBy(b, end); b = blocks[bi]) { withinDelta += delta(b); bi++; }
		shift += withinDelta;
		const slice = cleanLines.slice(cStart, end + shift);
		const region = regions[ri];
		slices[ri] = region && linesEqual(slice, baseSegmentOf(region)) ? null : slice;
	});
	return slices;
}

/** Mint a fresh conflict from two clean files via diff3 (the only diff3 call). */
function mint(base: string, local: string, remote: string): ReconcileResult {
	const regions = diff3Merge(splitLines(local), splitLines(base), splitLines(remote));
	const segments: Segment[] = [];
	let stable: string[] = [];
	let conflicted = false;
	const flush = (): void => { if (stable.length) { segments.push({ kind: 'stable', lines: stable }); stable = []; } };
	for (const r of regions) {
		if (r.ok) { stable.push(...r.ok); continue; }
		if (r.conflict) {
			conflicted = true;
			flush();
			segments.push({ kind: 'region', region: { segments: [
				{ label: BASE_LABEL, lines: r.conflict.o ?? [] },
				{ label: 'A1', lines: r.conflict.a ?? [] },
				{ label: 'A2', lines: r.conflict.b ?? [] },
			] } });
		}
	}
	flush();
	const content = emitConflictFile({ segments });
	return conflicted ? { kind: 'folded', changed: true, content } : { kind: 'clean', content };
}

/** Fold a set of incoming contributions into an anchor file, keeping the anchor's labels. */
function foldInto(anchor: ParsedFile, anchorText: string, base: string, incoming: Vec[]): ReconcileResult {
	if (joinLines(baseReconLines(anchor)) !== base) return { kind: 'keepBoth' };
	const regions = regionsOf(anchor);
	const ac = contributionsOf(anchor);
	const seen = new Set([...ac.map.values()].map(v => normKey(v, regions)));
	const baseKey = normKey(new Array<string[] | null>(regions.length).fill(null), regions);

	const fresh: Vec[] = [];
	for (const vec of incoming) {
		const key = normKey(vec, regions);
		if (key === baseKey || seen.has(key)) continue;
		seen.add(key);
		fresh.push(vec);
	}
	if (fresh.length === 0) return { kind: 'folded', changed: false, content: anchorText };

	let n = maxAltNumber(ac.order);
	const contribs = ac.order.map(label => ({ label, vec: ac.map.get(label)! }));
	for (const vec of fresh) contribs.push({ label: `A${++n}`, vec });
	return { kind: 'folded', changed: true, content: emitFromContributions(anchor, regions, contribs) };
}

/**
 * Reconcile `local` and `remote` text given their common `base`.
 *
 * Routes per the decision table in [`specs/nway-conflict.md`](../../specs/nway-conflict.md):
 * clean/clean → mint via `diff3`; clean/N-way or N-way/N-way with the same base
 * → fold (union of distinct contributions, anchored to the remote/Drive labels);
 * base mismatch / malformed / out-of-span → keep-both. Never feeds marker-bearing
 * text to `diff3`.
 */
export function reconcileText(base: string, local: string, remote: string): ReconcileResult {
	// Cheap short-circuits before any parsing. These use the *raw* base as the
	// provenance record (the last-synced content, which may itself be N-way): a
	// resolver whose Drive copy still equals its base drains via `remote === base`.
	if (local === remote) return asResult(local, false);
	if (local === base) return asResult(remote, false);   // local contributes nothing
	if (remote === base) return asResult(local, true);    // remote (Drive) lacks local's content

	// The diff3/localize ancestor must be clean text. If the stored base is itself
	// an N-way file (because the device last synced a conflict), use its embedded
	// base segment as the ancestor — never feed markers to diff3.
	let cleanBase = base;
	if (looksLikeConflict(base)) {
		const bp = parseConflictFile(base);
		if (!bp) return { kind: 'keepBoth' };
		cleanBase = joinLines(baseReconLines(bp));
	}

	const localMarked = looksLikeConflict(local);
	const remoteMarked = looksLikeConflict(remote);

	if (!localMarked && !remoteMarked) return mint(cleanBase, local, remote);

	const localParsed = localMarked ? parseConflictFile(local) : null;
	const remoteParsed = remoteMarked ? parseConflictFile(remote) : null;
	if ((localMarked && !localParsed) || (remoteMarked && !remoteParsed)) return { kind: 'keepBoth' };

	// clean local folded into N-way remote (the common rule-2 case): anchor = remote/Drive.
	if (!localMarked && remoteParsed) {
		const vec = localizeClean(remoteParsed, cleanBase, local);
		if (!vec) return { kind: 'keepBoth' };
		return foldInto(remoteParsed, remote, cleanBase, [vec]);
	}

	// N-way local, clean remote: anchor = local (remote has no labels); we must push our richer file.
	if (localParsed && !remoteMarked) {
		const vec = localizeClean(localParsed, cleanBase, remote);
		if (!vec) return { kind: 'keepBoth' };
		const r = foldInto(localParsed, local, cleanBase, [vec]);
		return r.kind === 'folded' ? { kind: 'folded', changed: true, content: r.content } : r;
	}

	// Both N-way: anchor = remote/Drive; fold local's contributions in.
	if (localParsed && remoteParsed) {
		if (skeletonOf(localParsed) !== skeletonOf(remoteParsed)) return { kind: 'keepBoth' };
		const lc = contributionsOf(localParsed);
		const incoming = lc.order.map(l => lc.map.get(l)!);
		return foldInto(remoteParsed, remote, cleanBase, incoming);
	}
	return { kind: 'keepBoth' };
}

/** Wrap a final text as clean, or — if it carries valid markers — as a folded no-op/push. */
function asResult(content: string, push: boolean): ReconcileResult {
	if (!looksLikeConflict(content)) return { kind: 'clean', content };
	const parsed = parseConflictFile(content);
	if (!parsed) return { kind: 'keepBoth' };
	return { kind: 'folded', changed: push, content };
}
