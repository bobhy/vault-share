import { describe, it, expect } from 'vitest';
import { formatSyncStatus } from './sync-status-bar';

describe('formatSyncStatus', () => {
	it('returns Checking… before any plan has run (count is null), regardless of paused state', () => {
		expect(formatSyncStatus(false, null)).toBe('Checking…');
		expect(formatSyncStatus(true,  null)).toBe('Checking…');
	});

	it('paused + files pending: names both the pause and the count', () => {
		expect(formatSyncStatus(true, 12)).toBe('Sharing paused – 12 files pending');
	});

	it('paused + files pending: uses singular "file" for exactly one', () => {
		expect(formatSyncStatus(true, 1)).toBe('Sharing paused – 1 file pending');
	});

	it('paused + no pending files: shows pause without a count', () => {
		expect(formatSyncStatus(true, 0)).toBe('Sharing paused');
	});

	it('running + files pending: shows count only, no "paused" label', () => {
		expect(formatSyncStatus(false, 5)).toBe('5 files pending');
	});

	it('running + files pending: uses singular "file" for exactly one', () => {
		expect(formatSyncStatus(false, 1)).toBe('1 file pending');
	});

	it('running + nothing pending: returns empty string to hide the indicator', () => {
		expect(formatSyncStatus(false, 0)).toBe('');
	});
});
