# Upgrade path — versioning persistent data for post-1.0 compatibility

## Motivation

At the 1.0 release the plugin enters its backward-compatibility commitment
(see `CLAUDE.md` → *Releases*). From that point on, a new release may find
persisted data written by an older release — on the same device or, in the case
of the shared Drive folder, written by a *peer* device that has not yet been
updated. Every persistence surface therefore needs a version tag and a defined
behaviour when the tag does not match the running plugin.

This document inventories the four persistence surfaces, assigns each a version
tag, and specifies the migration / refusal behaviour.

## Persistence surfaces

| Surface | Storage | Version tag | Migration mechanism |
| --- | --- | --- | --- |
| Settings | `data.json` via `loadData()`/`saveData()` | `schemaVersion` field | sequential ladder in `migrateSettings()` |
| IndexedDB | `vault-share-<vault>` database | native IDB `DB_VERSION` | `onupgradeneeded` ladder |
| OAuth tokens | OS keychain via `app.secretStorage` | *(rides settings `schemaVersion`)* | re-mint / rename keys in a settings migration step |
| Drive shared folder | `appProperties` on the folder | `vaultShareSchema` property | `checkDriveSchema()` — stamp / forward-migrate / refuse |

### 1. Settings (`data.json`)

`VaultShareSettings.schemaVersion` is an integer, current value
`SETTINGS_SCHEMA_VERSION = 1`. It is part of `DEFAULT_SETTINGS`, so a fresh
install is stamped automatically.

On load, `migrateSettings(raw, runtimeDefaults)`:

1. Reads the stored version (absent ⇒ `0`, i.e. any pre-1.0 install).
2. Runs each `if (fromVersion < N)` block in order. Each block mutates the raw
   object in place to the shape expected by version `N`.
3. Merges the result over `DEFAULT_SETTINGS` (so *added* fields still fall back
   to their defaults for free — the version ladder is only needed for renames,
   removals, or semantic changes).
4. Stamps `schemaVersion = SETTINGS_SCHEMA_VERSION`.
5. Reports `migrated: true` when stored data existed at an older version, so the
   caller persists the upgraded shape once (idempotent if it fails and retries).

**Ladder so far**

- **v0 → v1** — rename `fileModificationConfirmation{Threshold,Min}` to
  `globalChange{Threshold,Min}`. (Originally an ad-hoc field-sniff in
  `main.ts`; now the first rung of the ladder.)

To add a future migration: bump `SETTINGS_SCHEMA_VERSION`, append an
`if (fromVersion < N)` block, and document it under *Ladder so far*.

### 2. IndexedDB

Already versioned natively. `DB_VERSION = 3` is frozen as the 1.0 baseline.

The pre-1.0 policy was "cold-start (drop everything) on any bump". At 1.0 that
policy ends: installs at version 1 or 2 are cold-started *one final time* to
reach the version-3 baseline, and every bump from 4 onward must preserve data
with an incremental `if (oldVersion < N)` block.

```ts
onUpgrade: (db, oldVersion) => {
  if (oldVersion < 3) coldStart(db);          // pre-1.0 installs, final reset
  // if (oldVersion < 4) migrate_3_to_4(db);  // post-1.0: preserve user data
}
```

Note that the `candidates` and `sync-content` stores hold a *rebuildable* cache
— they re-derive from a fresh planning pass against local + Drive. A future
cold-start of those stores is therefore safe (only slow). `sync-stats` and the
`device` client id are the only stores whose loss is user-visible (reset
counters, new client id); preserve them across migrations where practical.

### 3. OAuth tokens (SecretStorage)

Three flat string keys per vault (`refresh-token`, `access-token`,
`token-expiry`), named by `secretKeys()`. This shape is stable enough that a
dedicated version tag is overkill. If the key-naming scheme or token shape ever
changes, handle it as a step in the settings migration ladder (gated on
`schemaVersion`): re-mint or rename the keys when the version crosses that
boundary. No standalone token-schema version is introduced.

### 4. Drive shared folder

This is the only **cross-version, multi-master** surface: a folder may be read
and written concurrently by peers running different plugin versions. It is the
one surface where an old client can silently corrupt data a newer peer wrote, so
it gets the strongest interlock.

The version lives in the folder's Drive **`appProperties`** — custom key/value
metadata attached to the folder resource itself. It is invisible to users, never
syncs into a vault, and is set atomically via the Drive files API. Key:
`vaultShareSchema`; current value `DRIVE_SCHEMA_VERSION = 1`.

`checkDriveSchema(api, folderId)` runs after the folder id is resolved (plugin
startup, re-auth, reset) and returns one of:

| Folder version | Result | Action |
| --- | --- | --- |
| absent (`0`) | `stamped` | First versioned client. Claim the folder: write the property. Proceed. |
| `== ours` | `ok` | Proceed. |
| `< ours` | `migrated` | Run the forward-migration ladder (none yet at v1), re-stamp, proceed. |
| `> ours` | `tooNew` | **Refuse.** Do not sync. Surface a recoverable message telling the user to update Vault Share. |

The `tooNew → refuse` rung is the payoff: it prevents an outdated client from
mangling a folder that a newer peer has already upgraded. It is treated as a
**non-recoverable condition** (per ARCHITECTURE.md's error model): on `tooNew`,
`verifyDriveSchema()` logs an error, shows a single-button acknowledgement modal
(`ConfirmationModal.alert`), and throws. The throw leaves `driveFolderId` empty
so no bulk or single-file pass runs in the interim; when the user dismisses the
modal, the plugin disables itself (`disableSelf()` → `app.plugins.disablePlugin`).
The user re-enables it after updating to a version that understands the folder.

An unversioned folder (one written only by pre-1.0 clients) is format-identical
to version 1, so stamping it `1` is the correct and lossless claim.

The current folder version is surfaced read-only in the settings
**Statistics** section as *Group vault schema* (via
`readDriveSchemaVersion()` / `getGroupVaultSchemaVersion()`); it shows
"Not connected" when logged out or the folder is unresolved.

To add a future Drive migration: bump `DRIVE_SCHEMA_VERSION`, add the
forward-migration step inside `checkDriveSchema`'s `< ours` branch, and remember
that peers on the previous version will hit `tooNew` and pause until updated —
so Drive schema bumps are a heavier commitment than local ones and should be
rare.

## Testing

- `migrateSettings` — version detection, the v0→v1 rename, default fallback for
  added fields, and the `migrated` flag.
- `checkDriveSchema` — each of the four result branches, including that
  `stamped`/`migrated` write the property and `tooNew` does not.
- `GDriveApi.getAppProperties` / `setAppProperties` — request shape and parsing.
