import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, migrateSettings } from './settings';

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

describe('migrateSettings', () => {
	const runtimeDefaults = { driveFolderPath: '/vault-share/My Notes' };

	it('stamps a fresh install (null) at the current schema, no migration flagged', () => {
		const { settings, migrated } = migrateSettings(null, runtimeDefaults);
		expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
		expect(settings.driveFolderPath).toBe('/vault-share/My Notes');
		expect(settings).toMatchObject({ ...DEFAULT_SETTINGS, ...runtimeDefaults });
		expect(migrated).toBe(false);
	});

	it('treats stored data without schemaVersion as version 0 and migrates it', () => {
		const { settings, migrated } = migrateSettings({ logHorizon: 500 }, runtimeDefaults);
		expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
		expect(settings.logHorizon).toBe(500);
		expect(migrated).toBe(true);
	});

	it('v0 → v1 renames fileModificationConfirmation* to globalChange* and drops the old keys', () => {
		const stored = {
			fileModificationConfirmationThreshold: 25,
			fileModificationConfirmationMin: 7,
		};
		const { settings, migrated } = migrateSettings(stored, runtimeDefaults);
		expect(settings.globalChangeThreshold).toBe(25);
		expect(settings.globalChangeMin).toBe(7);
		expect(migrated).toBe(true);
		const asRecord = settings as unknown as Record<string, unknown>;
		expect(asRecord.fileModificationConfirmationThreshold).toBeUndefined();
		expect(asRecord.fileModificationConfirmationMin).toBeUndefined();
	});

	it('does not overwrite an already-present new field name during the v0→v1 rename', () => {
		const stored = {
			fileModificationConfirmationThreshold: 25,
			globalChangeThreshold: 40,
		};
		const { settings } = migrateSettings(stored, runtimeDefaults);
		expect(settings.globalChangeThreshold).toBe(40);
	});

	it('fills absent fields from defaults without needing a version bump', () => {
		const stored = { schemaVersion: SETTINGS_SCHEMA_VERSION, logHorizon: 250 };
		const { settings, migrated } = migrateSettings(stored, runtimeDefaults);
		expect(settings.logHorizon).toBe(250);
		expect(settings.bulkSyncPoll).toBe(DEFAULT_SETTINGS.bulkSyncPoll);
		expect(migrated).toBe(false);
	});

	it('does not flag migration when stored data is already at the current version', () => {
		const stored = { schemaVersion: SETTINGS_SCHEMA_VERSION, driveFolderPath: '/x' };
		const { migrated } = migrateSettings(stored, runtimeDefaults);
		expect(migrated).toBe(false);
	});
});
