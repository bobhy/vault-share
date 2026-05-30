import { describe, it, expect } from 'vitest';
import type { Candidate, FileSide } from './types';
import type { DriveFileSide } from './drive-fs';
import { classifyStatus, planAction } from './decision-engine';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Build a Candidate with the given sync-history fields for use in planAction tests. */
function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
	return {
		path: 'test.md',
		state: 'Synced',
		actionType: 'noOp',
		driveFileId: 'drive-1',
		syncedLocalMtime: 1000,
		syncedRemoteMtime: 1000,
		syncedLocalSize: 10,
		syncedRemoteSize: 10,
		syncedAt: 500,       // > 0 → wasSynced = true
		deferredAt: 0,
		deferredLocalMtime: 0,
		deferredRemoteMtime: 0,
		...overrides,
	};
}

// Local sides
const localUnmodified: FileSide = { path: 'test.md', mtime: 1000, size: 10 };
const localModified: FileSide   = { path: 'test.md', mtime: 2000, size: 15 };

// Remote sides
const remoteUnmodified: DriveFileSide = { path: 'test.md', mtime: 1000, size: 10, driveFileId: 'drive-1' };
const remoteModified: DriveFileSide   = { path: 'test.md', mtime: 2000, size: 15, driveFileId: 'drive-1' };

/** Shorthand: plan a single candidate with the given sides. */
function plan(
	candidate: Candidate | null,
	local: FileSide | undefined,
	remote: (FileSide & { driveFileId: string }) | undefined,
	vaultHasHistory: boolean,
): string {
	return planAction(candidate, local, remote, vaultHasHistory);
}

// ---------------------------------------------------------------------------
// With-history decision table
// ---------------------------------------------------------------------------

describe('planAction with history', () => {
	const c = makeCandidate();  // syncedAt > 0 → wasSynced = true

	it('unmodified | unmodified → noOp', () => {
		expect(plan(c, localUnmodified, remoteUnmodified, true)).toBe('noOp');
	});

	it('modified | unmodified → push', () => {
		expect(plan(c, localModified, remoteUnmodified, true)).toBe('push');
	});

	it('unmodified | modified → pull', () => {
		expect(plan(c, localUnmodified, remoteModified, true)).toBe('pull');
	});

	it('modified | modified → conflict', () => {
		expect(plan(c, localModified, remoteModified, true)).toBe('conflict');
	});

	// --- delete scenarios ---

	it('deleted | unmodified → deleteRemote (local deleted, remote unchanged)', () => {
		expect(plan(c, undefined, remoteUnmodified, true)).toBe('deleteRemote');
	});

	it('unmodified | deleted → deleteLocal (remote deleted, local unchanged)', () => {
		expect(plan(c, localUnmodified, undefined, true)).toBe('deleteLocal');
	});

	it('deleted | deleted → deleteLocal (both gone simultaneously — cleans up orphaned record)', () => {
		// Race condition: two clients deleted the same file before either sync ran.
		expect(plan(c, undefined, undefined, true)).toBe('deleteLocal');
	});

	it('deleted | modified → conflict (local deleted, remote changed)', () => {
		expect(plan(c, undefined, remoteModified, true)).toBe('conflict');
	});

	it('modified | deleted → conflict (local changed, remote deleted)', () => {
		expect(plan(c, localModified, undefined, true)).toBe('conflict');
	});
});

// ---------------------------------------------------------------------------
// Without-history decision table (vaultHasHistory = false)
// ---------------------------------------------------------------------------

describe('planAction without history', () => {
	it('local only → push', () => {
		expect(plan(null, localUnmodified, undefined, false)).toBe('push');
	});

	it('remote only → pull', () => {
		expect(plan(null, undefined, remoteUnmodified, false)).toBe('pull');
	});

	it('both present → conflict', () => {
		expect(plan(null, localUnmodified, remoteUnmodified, false)).toBe('conflict');
	});

	it('neither present → noOp', () => {
		expect(plan(null, undefined, undefined, false)).toBe('noOp');
	});
});

// ---------------------------------------------------------------------------
// Candidate with no sync history (syncedAt = 0) but vault has history
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// classifyStatus direct contract
// ---------------------------------------------------------------------------

describe('classifyStatus', () => {
	// Precondition: only called for candidates with syncedAt > 0. The three
	// possible outcomes are 'deleted', 'unmodified', 'modified'.

	it('returns "deleted" when the side is absent', () => {
		expect(classifyStatus(undefined, 1000, 10)).toBe('deleted');
	});

	it('returns "unmodified" when both mtime and size match the record', () => {
		expect(classifyStatus({ path: 'a.md', mtime: 1000, size: 10 }, 1000, 10)).toBe('unmodified');
	});

	it('returns "modified" when mtime differs', () => {
		expect(classifyStatus({ path: 'a.md', mtime: 2000, size: 10 }, 1000, 10)).toBe('modified');
	});

	it('returns "modified" when size differs', () => {
		expect(classifyStatus({ path: 'a.md', mtime: 1000, size: 20 }, 1000, 10)).toBe('modified');
	});
});

describe('planAction: candidate never synced (syncedAt=0), vault has history', () => {
	// A brand-new file that the vault hasn't synced yet, but other files have been synced.
	const neverSynced = makeCandidate({ syncedAt: 0 });

	it('local only → push', () => {
		expect(plan(neverSynced, localUnmodified, undefined, true)).toBe('push');
	});

	it('remote only → pull', () => {
		expect(plan(neverSynced, undefined, remoteUnmodified, true)).toBe('pull');
	});

	it('both present → conflict (no shared history)', () => {
		expect(plan(neverSynced, localUnmodified, remoteUnmodified, true)).toBe('conflict');
	});
});
