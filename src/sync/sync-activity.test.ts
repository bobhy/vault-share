import { describe, it, expect, vi } from 'vitest';
import { SyncActivity } from './sync-activity';

describe('SyncActivity', () => {
	it('starts idle with everything cleared', () => {
		expect(new SyncActivity().getSnapshot()).toEqual({
			bulkRunning: false,
			currentPath: null,
		});
	});

	it('fires onChange when a value actually changes', () => {
		const activity = new SyncActivity();
		const listener = vi.fn();
		activity.onChange(listener);

		activity.setBulkRunning(true);
		activity.setCurrentPath('a.md');

		expect(listener).toHaveBeenCalledTimes(2);
		expect(activity.getSnapshot()).toEqual({
			bulkRunning: true,
			currentPath: 'a.md',
		});
	});

	it('does not fire onChange on an idempotent set', () => {
		const activity = new SyncActivity();
		activity.setBulkRunning(true);
		const listener = vi.fn();
		activity.onChange(listener);

		activity.setBulkRunning(true);
		activity.setCurrentPath(null);   // already null

		expect(listener).not.toHaveBeenCalled();
	});

	it('getSnapshot returns an independent copy', () => {
		const activity = new SyncActivity();
		const snap = activity.getSnapshot();
		snap.bulkRunning = true;
		expect(activity.getSnapshot().bulkRunning).toBe(false);
	});

	it('unsubscribe stops further delivery', () => {
		const activity = new SyncActivity();
		const listener = vi.fn();
		const unsubscribe = activity.onChange(listener);

		activity.setBulkRunning(true);
		unsubscribe();
		activity.setBulkRunning(false);

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('a throwing listener does not block the others', () => {
		const activity = new SyncActivity();
		const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
		const good = vi.fn();
		activity.onChange(() => { throw new Error('boom'); });
		activity.onChange(good);

		activity.setBulkRunning(true);

		expect(good).toHaveBeenCalledTimes(1);
		consoleErr.mockRestore();
	});
});
