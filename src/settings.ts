/**
 * Plugin settings schema and defaults.
 *
 * Persistence: settings are loaded by `main.ts` via `loadData()` and merged
 * over {@link DEFAULT_SETTINGS} so missing fields fall back gracefully across
 * versions (per project convention — no migration code for added fields).
 *
 * @packageDocumentation
 */

/** Conflict-resolution strategy for non-text (binary / unknown) file types. */
export type FileConflictStrategy = 'Use Newer' | 'Keep Both';
/** Conflict-resolution strategy for text files (.md, .txt) — `Merge` runs diff3. */
export type TextFileConflictStrategy = 'Use Newer' | 'Keep Both' | 'Merge';
/** Minimum severity for accepted log entries; less-severe entries are dropped. */
export type LogSeverity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/**
 * Schema version for the persisted {@link VaultShareSettings} shape.
 *
 * Bump this and append an `if (fromVersion < N)` block to {@link migrateSettings}
 * whenever a field is renamed, removed, or changes meaning. Added fields do not
 * require a bump — they fall back to {@link DEFAULT_SETTINGS} automatically.
 *
 * See `specs/upgrade-path.md`.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Persisted per-vault configuration; loaded by `main.ts` on plugin start. */
export interface VaultShareSettings {
	/**
	 * Schema version of this stored object. Absent (treated as `0`) for any
	 * pre-1.0 install; stamped to {@link SETTINGS_SCHEMA_VERSION} by
	 * {@link migrateSettings}.
	 */
	schemaVersion: number;

	/** Slash-separated path to the shared Google Drive folder. Must begin with a separator. */
	driveFolderPath: string;

	/** Ordered exclude rules (last-match-wins, ! prefix re-includes). */
	excludeRules: string[];

	/** Conflict resolution strategy for mutually modified non-text files. */
	fileConflict: FileConflictStrategy;

	/** Conflict resolution strategy for mutually modified text files (.md, .txt). */
	textFileConflict: TextFileConflictStrategy;

	/**
	 * Defer all pending bulk-sync work for review when a single pass would
	 * change more than this % of all known files.  "Global changes" — the
	 * numerator — is every pending action: pushes, pulls, conflicts,
	 * remote-side deletions (`deleteRemote`), and local-side deletions
	 * (`deleteLocal`).  The denominator is the size of the union of files
	 * in local and Drive (each path counted once).
	 *
	 * The check is skipped entirely when either side is empty (fresh
	 * install joining a populated group vault; or recovering from an
	 * accidental Drive-folder wipe) — there's no established sync state
	 * to protect in those cases.  It is also skipped when the union is
	 * smaller than {@link globalChangeMin}.
	 */
	globalChangeThreshold: number;

	/**
	 * Skip the threshold check entirely when the union of local and Drive
	 * files has fewer than this many entries.  Small vaults have noisy
	 * ratios — a single change in a 5-entry union is 20 %, which would
	 * otherwise trip the default 10 % threshold every time.
	 */
	globalChangeMin: number;

	/** How often bulk sync runs, in seconds. */
	bulkSyncPoll: number;

	/** How often single-file sync polls an open visible file, in seconds. */
	openFilePoll: number;

	/** Seconds after the last local edit before single-file sync is triggered. */
	openFileChangeHoldDown: number;

	/** Minimum severity level written to log output. */
	logSeverity: LogSeverity;

	/** When true, recent log entries are shown in a right-sidebar leaf. */
	logToSidebar: boolean;

	/** Maximum number of log entries retained for the sidebar view. */
	logHorizon: number;
}

/** Default values applied for any field absent from stored data. */
export const DEFAULT_SETTINGS: VaultShareSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	driveFolderPath: '',  // overridden at runtime with /vault-share/<vault-name>; never used as-is
	// Defaults:
	// - `.obsidian` — exclude the entire config directory. Per-vault state
	//   (plugin builds, OAuth tokens, the plugin's own `data.json`) must not
	//   sync across devices; each install manages its own copy.
	// - `.trash` — exclude Obsidian's in-vault trash folder. Files deleted
	//   under the "Move to .trash folder" setting end up here, and without
	//   this rule they would be re-pushed to Drive (and pulled back into
	//   peer vaults' `.trash/`) as if they were new files.
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- static constant; Vault#configDir is unavailable here; runtime code should use vault.configDir if overriding
	excludeRules: ['.obsidian', '.trash'],
	fileConflict: 'Keep Both',
	textFileConflict: 'Merge',
	globalChangeThreshold: 10,
	globalChangeMin: 10,
	bulkSyncPoll: 3600,
	openFilePoll: 10,
	openFileChangeHoldDown: 5,
	logSeverity: 'WARNING',
	logToSidebar: false,
	logHorizon: 1000,
};

/** Legacy field names migrated away by the {@link migrateSettings} ladder. */
interface LegacySettingsShape {
	/** Renamed to `globalChangeThreshold` in schema v1. */
	fileModificationConfirmationThreshold?: number;
	/** Renamed to `globalChangeMin` in schema v1. */
	fileModificationConfirmationMin?: number;
}

/**
 * Upgrade a raw `loadData()` result to the current settings schema.
 *
 * Reads `schemaVersion` from the stored object (absent ⇒ `0`, i.e. any pre-1.0
 * install), runs each version-bump migration in order, then merges the result
 * over {@link DEFAULT_SETTINGS} so any newly-added field falls back to its
 * default. The returned settings are always stamped with
 * {@link SETTINGS_SCHEMA_VERSION}.
 *
 * `runtimeDefaults` supplies values computed at load time (notably
 * `driveFolderPath`, derived from the vault name); they sit between the static
 * defaults and the stored values in precedence.
 *
 * `migrated` is `true` when stored data existed at an older schema version, so
 * the caller can persist the upgraded shape exactly once. The operation is
 * idempotent — a failed persist just retries the same migration next load.
 *
 * See `specs/upgrade-path.md`.
 */
export function migrateSettings(
	raw: unknown,
	runtimeDefaults: Partial<VaultShareSettings> = {},
): { settings: VaultShareSettings; migrated: boolean } {
	const hadStored = typeof raw === 'object' && raw !== null;
	const stored = (hadStored ? raw : {}) as Partial<VaultShareSettings> & LegacySettingsShape;
	const fromVersion = typeof stored.schemaVersion === 'number' ? stored.schemaVersion : 0;

	// v0 → v1: rename fileModificationConfirmation* → globalChange*. The new
	// names reflect that the threshold counts changes on either side of the
	// sync, not just local modifications. The user's chosen values continue to
	// express the same intent (their tolerance for sync noise), so carry them
	// across verbatim.
	if (fromVersion < 1) {
		if (typeof stored.fileModificationConfirmationThreshold === 'number'
			&& typeof stored.globalChangeThreshold !== 'number') {
			stored.globalChangeThreshold = stored.fileModificationConfirmationThreshold;
		}
		if (typeof stored.fileModificationConfirmationMin === 'number'
			&& typeof stored.globalChangeMin !== 'number') {
			stored.globalChangeMin = stored.fileModificationConfirmationMin;
		}
		delete stored.fileModificationConfirmationThreshold;
		delete stored.fileModificationConfirmationMin;
	}

	const settings: VaultShareSettings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		runtimeDefaults,
		stored,
	);
	settings.schemaVersion = SETTINGS_SCHEMA_VERSION;

	return { settings, migrated: hadStored && fromVersion < SETTINGS_SCHEMA_VERSION };
}
