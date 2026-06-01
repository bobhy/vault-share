/**
 * Pure display-logic helper for the persistent sync status bar item.
 *
 * Separated from `VaultSharePlugin` so the mapping from state to text
 * can be unit-tested without instantiating the plugin or touching the DOM.
 *
 * @param paused - Whether sharing is currently paused on this device.
 * @param count  - Total pending + deferred candidate count from the most recent
 *   planning pass, or `null` if no plan has run yet.
 * @returns The string to display in the status bar, or `''` to hide it.
 *
 * @packageDocumentation
 */
export function formatSyncStatus(paused: boolean, count: number | null): string {
	if (count === null) {
		return 'Checking…';
	}
	if (paused && count > 0) {
		return `Sharing paused – ${count} file${count === 1 ? '' : 's'} pending`;
	}
	if (paused) {
		return 'Sharing paused';
	}
	if (count > 0) {
		return `${count} file${count === 1 ? '' : 's'} pending`;
	}
	return '';
}
