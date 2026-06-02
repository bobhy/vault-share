/**
 * Versioning for the shared Drive folder — the one persistence surface read and
 * written by peers that may run different plugin versions.
 *
 * The version is stored in the folder's Drive `appProperties` under
 * {@link DRIVE_SCHEMA_PROP_KEY}. {@link checkDriveSchema} reads it once the
 * folder id is resolved and decides whether to proceed, claim/stamp the folder,
 * forward-migrate it, or refuse (the folder was written by a newer plugin).
 *
 * See `specs/upgrade-path.md`.
 *
 * @packageDocumentation
 */

/**
 * Schema version of the shared Drive folder layout written by this plugin.
 *
 * Bump only for changes to the *cloud* folder format. A bump forces every peer
 * still on the previous version into the `tooNew` refusal path until they
 * update, so Drive bumps are a heavier commitment than local schema bumps and
 * should be rare.
 */
export const DRIVE_SCHEMA_VERSION = 1;

/** `appProperties` key holding the folder's {@link DRIVE_SCHEMA_VERSION}. */
export const DRIVE_SCHEMA_PROP_KEY = 'vaultShareSchema';

/** Minimal Drive surface {@link checkDriveSchema} needs; satisfied by `GDriveApi`. */
export interface DriveSchemaApi {
	getAppProperties(fileId: string): Promise<Record<string, string>>;
	setAppProperties(fileId: string, props: Record<string, string>): Promise<void>;
}

/**
 * Outcome of a {@link checkDriveSchema} call.
 *
 * - `ok` — folder is already at our version; proceed.
 * - `stamped` — folder was unversioned (pre-1.0 / freshly created); we claimed
 *   it by writing the property. Proceed.
 * - `migrated` — folder was at an older version; we forward-migrated and
 *   re-stamped it. Proceed.
 * - `tooNew` — folder was written by a newer plugin. The caller must refuse to
 *   sync and tell the user to update.
 */
export type DriveSchemaCheck =
	| { status: 'ok' }
	| { status: 'stamped' }
	| { status: 'migrated'; from: number }
	| { status: 'tooNew'; folderVersion: number };

/**
 * Read the shared folder's schema version and reconcile it with this plugin's
 * {@link DRIVE_SCHEMA_VERSION}.
 *
 * For an unversioned (`stamped`) or older (`migrated`) folder this writes the
 * current version back so subsequent clients see a claimed folder. For a
 * `tooNew` folder it writes nothing — the caller refuses to touch it.
 *
 * An absent or unparseable property is treated as version `0` (a folder written
 * only by pre-1.0 clients, whose layout is identical to version 1).
 */
/**
 * Read and parse the schema version stamped on a folder's `appProperties`.
 * An absent or unparseable property yields `0` — a folder written only by
 * pre-1.0 clients (or never stamped), whose layout is identical to version 1.
 */
export async function readDriveSchemaVersion(
	api: DriveSchemaApi,
	folderId: string,
): Promise<number> {
	const props = await api.getAppProperties(folderId);
	const raw = props[DRIVE_SCHEMA_PROP_KEY];
	const parsed = raw === undefined ? 0 : parseInt(raw, 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

export async function checkDriveSchema(
	api: DriveSchemaApi,
	folderId: string,
): Promise<DriveSchemaCheck> {
	const folderVersion = await readDriveSchemaVersion(api, folderId);

	if (folderVersion === DRIVE_SCHEMA_VERSION) {
		return { status: 'ok' };
	}

	if (folderVersion > DRIVE_SCHEMA_VERSION) {
		return { status: 'tooNew', folderVersion };
	}

	// folderVersion < ours: claim (v0) or forward-migrate (1..ours-1), then stamp.
	// No forward-migration steps exist at v1; future versions add them here
	// before the re-stamp, e.g. `if (folderVersion < 2) await migrate1to2(...)`.
	await api.setAppProperties(folderId, { [DRIVE_SCHEMA_PROP_KEY]: String(DRIVE_SCHEMA_VERSION) });
	return folderVersion === 0
		? { status: 'stamped' }
		: { status: 'migrated', from: folderVersion };
}
