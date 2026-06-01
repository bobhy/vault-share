/**
 * Three-way text merge with vault-share-specific conflict markers.
 *
 * Wraps node-diff3 so the rest of the codebase deals in `(base, local, remote)
 * → MergeResult` instead of raw diff3 region arrays. Defines the marker
 * vocabulary used by both the merger and the conflict navigation UI so any
 * marker-format change happens in one place.
 *
 * @packageDocumentation
 */
import { diff3Merge } from 'node-diff3';

/** Outcome of a three-way merge: the merged text plus a "had conflicts" flag. */
export interface MergeResult {
	content: string;
	hasConflicts: boolean;
}

/** Text file extensions eligible for diff3 merge. */
const MERGE_ELIGIBLE_EXTS = new Set(['.md', '.txt']);

/**
 * The four marker lines that delimit a vault-share conflict block.
 * All conflict-detection and navigation code must reference these constants
 * rather than repeating the literal strings, so that changing the marker
 * format requires edits only here.
 *
 *   MARKER_LOCAL  — opens the block; introduces the local (A) side
 *   MARKER_BASE   — separates local from the common base (O)
 *   MARKER_SEP    — separates base from the remote/group (B) side
 *   MARKER_GROUP  — closes the block
 *
 * Markers use backtick fencing so they render as inline code in markdown,
 * making them visually distinct from note content.
 */
export const MARKER_LOCAL = '`<<<<< local`';
export const MARKER_BASE  = '`||||| base`';
export const MARKER_SEP   = '`=====`';
export const MARKER_GROUP = '`>>>>> group`';

/**
 * Returns true when the file at path is eligible for text merge.
 * Only .md and .txt are eligible in V1. JSON, YAML, binary are not.
 */
export function isMergeEligible(path: string): boolean {
	const dot = path.lastIndexOf('.');
	if (dot === -1) return false;
	return MERGE_ELIGIBLE_EXTS.has(path.slice(dot).toLowerCase());
}

/**
 * Perform a diff3 three-way merge with vault-share conflict marker format.
 * Markers use backtick fencing so they render as inline code in markdown:
 *
 *   `<<<<< local`
 *   ...local lines...
 *   `||||| base`
 *   ...base lines...
 *   `=====`
 *   ...remote lines...
 *   `>>>>> group`
 */
export function threeWayMerge(
	base: string,
	local: string,
	remote: string,
): MergeResult {
	const baseLines = splitLines(base);
	const localLines = splitLines(local);
	const remoteLines = splitLines(remote);

	// diff3Merge(a, o, b) — o is the base/original, a is local, b is remote.
	const regions = diff3Merge(localLines, baseLines, remoteLines);

	const outputLines: string[] = [];
	let hasConflicts = false;

	for (const region of regions) {
		if (region.ok) {
			outputLines.push(...region.ok);
		} else if (region.conflict) {
			hasConflicts = true;
			outputLines.push(MARKER_LOCAL);
			outputLines.push(...(region.conflict.a ?? []));
			outputLines.push(MARKER_BASE);
			outputLines.push(...(region.conflict.o ?? []));
			outputLines.push(MARKER_SEP);
			outputLines.push(...(region.conflict.b ?? []));
			outputLines.push(MARKER_GROUP);
		}
	}

	return { content: outputLines.join('\n'), hasConflicts };
}

/**
 * Returns true if the text contains at least one unresolved conflict marker block
 * in vault-share format ({@link MARKER_LOCAL} … {@link MARKER_GROUP}).
 */
export function hasConflictMarkers(text: string): boolean {
	return text.includes(MARKER_LOCAL);
}

function splitLines(text: string): string[] {
	// Preserve empty trailing line if text ends with newline.
	if (text.endsWith('\n')) {
		return text.slice(0, -1).split('\n');
	}
	return text.split('\n');
}
