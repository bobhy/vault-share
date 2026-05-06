import { diff3Merge } from 'node-diff3';

export interface MergeResult {
	content: string;
	hasConflicts: boolean;
}

/** Text file extensions eligible for diff3 merge. */
const MERGE_ELIGIBLE_EXTS = new Set(['.md', '.txt']);

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
 * Markers use an 'x' prefix so they render acceptably in markdown:
 *
 *   x<<<<< <localClientId>
 *   ...local lines...
 *   x||||| base
 *   ...base lines...
 *   x=====
 *   ...remote lines...
 *   x>>>>> <remoteClientId>
 */
export function threeWayMerge(
	base: string,
	local: string,
	remote: string,
	localClientId: string,
	remoteClientId: string,
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
			outputLines.push(`x<<<<< ${localClientId}`);
			outputLines.push(...(region.conflict.a ?? []));
			outputLines.push(`x||||| base`);
			outputLines.push(...(region.conflict.o ?? []));
			outputLines.push('x=====');
			outputLines.push(...(region.conflict.b ?? []));
			outputLines.push(`x>>>>> ${remoteClientId}`);
		}
	}

	return { content: outputLines.join('\n'), hasConflicts };
}

function splitLines(text: string): string[] {
	// Preserve empty trailing line if text ends with newline.
	if (text.endsWith('\n')) {
		return text.slice(0, -1).split('\n');
	}
	return text.split('\n');
}
