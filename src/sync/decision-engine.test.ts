import { describe, it, expect } from 'vitest';
import type { MixedEntry, SyncRecord } from './types';
import type { DriveFileSide } from './drive-fs';
import { planActions } from './decision-engine';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_RECORD: SyncRecord = {
	path: 'test.md',
	driveFileId: 'drive-1',
	localMtime: 1000,
	remoteMtime: 1000,
	localSize: 10,
	remoteSize: 10,
	syncedAt: 0,
};

// Local sides
const localUnmodified = { path: 'test.md', mtime: 1000, size: 10 };
const localModified   = { path: 'test.md', mtime: 2000, size: 15 };

// Remote sides
const remoteUnmodified: DriveFileSide = { path: 'test.md', mtime: 1000, size: 10, driveFileId: 'drive-1' };
const remoteModified: DriveFileSide   = { path: 'test.md', mtime: 2000, size: 15, driveFileId: 'drive-1' };

/** Plan a single entry and return the action type. */
function planOne(entry: MixedEntry, hasHistory: boolean): string {
	const [action] = planActions([entry], hasHistory);
	return action?.type ?? '(none)';
}

// ---------------------------------------------------------------------------
// With-history decision table
// ---------------------------------------------------------------------------

describe('planActions with history', () => {
	it('unmodified | unmodified → noOp', () => {
		expect(planOne({ path: 'test.md', local: localUnmodified, remote: remoteUnmodified, record: BASE_RECORD }, true))
			.toBe('noOp');
	});

	it('modified | unmodified → push', () => {
		expect(planOne({ path: 'test.md', local: localModified, remote: remoteUnmodified, record: BASE_RECORD }, true))
			.toBe('push');
	});

	it('unmodified | modified → pull', () => {
		expect(planOne({ path: 'test.md', local: localUnmodified, remote: remoteModified, record: BASE_RECORD }, true))
			.toBe('pull');
	});

	it('modified | modified → conflict', () => {
		expect(planOne({ path: 'test.md', local: localModified, remote: remoteModified, record: BASE_RECORD }, true))
			.toBe('conflict');
	});

	// --- delete scenarios ---

	it('deleted | unmodified → deleteRemote (local deleted, remote unchanged)', () => {
		expect(planOne({ path: 'test.md', local: undefined, remote: remoteUnmodified, record: BASE_RECORD }, true))
			.toBe('deleteRemote');
	});

	it('unmodified | deleted → deleteLocal (remote deleted, local unchanged)', () => {
		expect(planOne({ path: 'test.md', local: localUnmodified, remote: undefined, record: BASE_RECORD }, true))
			.toBe('deleteLocal');
	});

	it('deleted | deleted → deleteLocal (both gone simultaneously — cleans up orphaned record)', () => {
		// Race condition: two clients deleted the same file before either sync ran.
		// The record would otherwise be orphaned and interfere with future files at the same path.
		expect(planOne({ path: 'test.md', local: undefined, remote: undefined, record: BASE_RECORD }, true))
			.toBe('deleteLocal');
	});

	it('deleted | modified → conflict (local deleted, remote changed)', () => {
		expect(planOne({ path: 'test.md', local: undefined, remote: remoteModified, record: BASE_RECORD }, true))
			.toBe('conflict');
	});

	it('modified | deleted → conflict (local changed, remote deleted)', () => {
		expect(planOne({ path: 'test.md', local: localModified, remote: undefined, record: BASE_RECORD }, true))
			.toBe('conflict');
	});
});

// ---------------------------------------------------------------------------
// Without-history decision table
// ---------------------------------------------------------------------------

describe('planActions without history', () => {
	it('local only → push', () => {
		expect(planOne({ path: 'test.md', local: localUnmodified }, false)).toBe('push');
	});

	it('remote only → pull', () => {
		expect(planOne({ path: 'test.md', remote: remoteUnmodified }, false)).toBe('pull');
	});

	it('both present → conflict', () => {
		expect(planOne({ path: 'test.md', local: localUnmodified, remote: remoteUnmodified }, false)).toBe('conflict');
	});

	it('neither present → noOp', () => {
		expect(planOne({ path: 'test.md' }, false)).toBe('noOp');
	});
});
