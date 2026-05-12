import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';

describe('default driveFolderPath', () => {
	it('is /vault-share/<vault-name> when no stored value exists', () => {
		const vaultName = 'My Notes';
		const settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			{ driveFolderPath: `/vault-share/${vaultName}` },
		);
		expect(settings.driveFolderPath).toBe('/vault-share/My Notes');
	});

	it('stored value takes precedence over the default', () => {
		const vaultName = 'My Notes';
		const stored = { driveFolderPath: '/custom/path' };
		const settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			{ driveFolderPath: `/vault-share/${vaultName}` },
			stored,
		);
		expect(settings.driveFolderPath).toBe('/custom/path');
	});
});
