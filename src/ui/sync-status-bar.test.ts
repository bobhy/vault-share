import { describe, it, expect } from 'vitest';
import { formatSyncStatus } from './sync-status-bar';

describe('formatSyncStatus', () => {
	it.each([
		{ name: 'running, no plan yet (count null)', paused: false, count: null, expected: 'Checking…' },
		{ name: 'paused, no plan yet (count null)', paused: true, count: null, expected: 'Checking…' },
		{ name: 'paused with files pending names both', paused: true, count: 12, expected: 'Sharing paused – 12 files pending' },
		{ name: 'paused with one file uses singular', paused: true, count: 1, expected: 'Sharing paused – 1 file pending' },
		{ name: 'paused with nothing pending omits the count', paused: true, count: 0, expected: 'Sharing paused' },
		{ name: 'running with files pending shows count only', paused: false, count: 5, expected: '5 files pending' },
		{ name: 'running with one file uses singular', paused: false, count: 1, expected: '1 file pending' },
		{ name: 'running with nothing pending hides the indicator', paused: false, count: 0, expected: '' },
	])('$name', ({ paused, count, expected }) => {
		expect(formatSyncStatus(paused, count)).toBe(expected);
	});
});
