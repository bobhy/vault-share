import { describe, it, expect, vi } from 'vitest';
import {
	checkDriveSchema,
	readDriveSchemaVersion,
	DRIVE_SCHEMA_VERSION,
	DRIVE_SCHEMA_PROP_KEY,
	type DriveSchemaApi,
} from './drive-schema';

function makeApi(stored: Record<string, string>) {
	const setAppProperties = vi.fn<DriveSchemaApi['setAppProperties']>(() => Promise.resolve());
	const getAppProperties = vi.fn<DriveSchemaApi['getAppProperties']>(() => Promise.resolve(stored));
	const api: DriveSchemaApi = { getAppProperties, setAppProperties };
	return { api, getAppProperties, setAppProperties };
}

describe('readDriveSchemaVersion', () => {
	it('parses the stamped version', async () => {
		const { api } = makeApi({ [DRIVE_SCHEMA_PROP_KEY]: '3' });
		expect(await readDriveSchemaVersion(api, 'folder1')).toBe(3);
	});

	it('returns 0 when the property is absent', async () => {
		const { api } = makeApi({});
		expect(await readDriveSchemaVersion(api, 'folder1')).toBe(0);
	});

	it('returns 0 when the property is unparseable', async () => {
		const { api } = makeApi({ [DRIVE_SCHEMA_PROP_KEY]: 'garbage' });
		expect(await readDriveSchemaVersion(api, 'folder1')).toBe(0);
	});
});

describe('checkDriveSchema', () => {
	it('returns ok and writes nothing when the folder is at our version', async () => {
		const { api, setAppProperties } = makeApi({ [DRIVE_SCHEMA_PROP_KEY]: String(DRIVE_SCHEMA_VERSION) });
		const result = await checkDriveSchema(api, 'folder1');
		expect(result).toEqual({ status: 'ok' });
		expect(setAppProperties).not.toHaveBeenCalled();
	});

	it('stamps an unversioned folder (no property) and reports stamped', async () => {
		const { api, setAppProperties } = makeApi({});
		const result = await checkDriveSchema(api, 'folder1');
		expect(result).toEqual({ status: 'stamped' });
		expect(setAppProperties).toHaveBeenCalledWith('folder1', {
			[DRIVE_SCHEMA_PROP_KEY]: String(DRIVE_SCHEMA_VERSION),
		});
	});

	it('treats an unparseable property as version 0 and stamps it', async () => {
		const { api, setAppProperties } = makeApi({ [DRIVE_SCHEMA_PROP_KEY]: 'garbage' });
		const result = await checkDriveSchema(api, 'folder1');
		expect(result).toEqual({ status: 'stamped' });
		expect(setAppProperties).toHaveBeenCalledOnce();
	});

	it('refuses (tooNew) and writes nothing when the folder is at a newer version', async () => {
		const { api, setAppProperties } = makeApi({ [DRIVE_SCHEMA_PROP_KEY]: String(DRIVE_SCHEMA_VERSION + 1) });
		const result = await checkDriveSchema(api, 'folder1');
		expect(result).toEqual({ status: 'tooNew', folderVersion: DRIVE_SCHEMA_VERSION + 1 });
		expect(setAppProperties).not.toHaveBeenCalled();
	});

	// Only meaningful once DRIVE_SCHEMA_VERSION advances past 1; guarded so the
	// suite stays green at v1 and exercises the migrated branch thereafter.
	it.skipIf(DRIVE_SCHEMA_VERSION < 2)('forward-migrates an older folder and re-stamps it', async () => {
		const older = DRIVE_SCHEMA_VERSION - 1;
		const { api, setAppProperties } = makeApi({ [DRIVE_SCHEMA_PROP_KEY]: String(older) });
		const result = await checkDriveSchema(api, 'folder1');
		expect(result).toEqual({ status: 'migrated', from: older });
		expect(setAppProperties).toHaveBeenCalledWith('folder1', {
			[DRIVE_SCHEMA_PROP_KEY]: String(DRIVE_SCHEMA_VERSION),
		});
	});
});
