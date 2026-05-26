# Global Persistent Candidates

## Problem

The sharing system has five separate representations of candidate file-pair state, each with a
different lifecycle and owner:

| Representation | Lives in | Updated by | Read by |
|---|---|---|---|
| `MixedEntry` | ephemeral | planning pass | decision engine |
| `SyncAction` / `pendingApprovedActions` | BulkSync memory | `approveForExecution()` | `doRun` |
| `DeferredCandidate` | IDB `deferred-candidates` | `DeferralStore` | `reconcile()` |
| `ViewCandidate.isDeferred` | SharingStatusView memory | `onCandidatesChanged` | modal UI |
| `SyncRecord` | IDB `sync-records` | `syncOneFile` | decision engine |

This fragmentation creates race conditions (the `pendingApprovedActions` / `triggerBulkSync`
race), stale UI state, and unreliable post-restart behaviour.  User-approved actions are stored
in a transient in-memory pointer that is consumed before execution begins; if the run exits early,
the intent is lost.

## Solution

A single `CandidateStore` is the sole source of truth for all per-file sharing state.  It owns
one IDB object store (`candidates`) that replaces both `deferred-candidates` and `sync-records`.
Every file that sharing knows about — whether currently in sync or pending an operation — is a
`Candidate` record.

The `Candidate` interface replaces `SyncAction`, `DeferredCandidate`, `ViewCandidate`, and
`SyncRecord`.  `MixedEntry` is eliminated; its join logic moves inside
`CandidateStore.reconcile()`.

Because `isApproved` is persisted to IDB, user approvals survive plugin restarts.  Because each
file is updated individually on successful execution (`markSynced` / `remove`), a partial run
leaves unprocessed files still `Approved` in the store — they are picked up on the next run.

---

## IDB Schema Versioning

`DB_VERSION` in `store.ts` is the canonical schema version.  The upgrade handler in `SyncStore`
is structured as a chain of `if (oldVersion < N)` blocks even though all pre-1.0 steps perform
a cold-start.  This makes incremental post-1.0 migrations straightforward to add.

```typescript
// store.ts

/**
 * Increment DB_VERSION on any schema change.
 *
 * SCHEMA_CHANGELOG
 *   1 — initial schema: sync-records, sync-content, sync-stats, device
 *   2 — added deferred-candidates, sync-state
 *   3 — candidates store replaces deferred-candidates + sync-records;
 *         sync-state store retained unchanged
 */
const DB_VERSION = 3;

onUpgrade: (db, oldVersion) => {
    if (oldVersion < 3) {
        // Pre-1.0 policy: cold-start on any schema change.
        // Post-1.0: replace this block with per-step migration logic, e.g.:
        //   if (oldVersion < 3) { migrate_2_to_3(db); }
        for (const name of Array.from(db.objectStoreNames)) {
            db.deleteObjectStore(name);
        }
        createStores(db);   // extracted helper; creates all stores for the current version
    }
},
```

`createStores(db)` creates: `candidates` (keyPath `path`), `sync-content`, `sync-stats`,
`device`, `sync-state`.  It no longer creates `sync-records` or `deferred-candidates`.

---

## `CandidateState` — Four-Value State Machine

```typescript
/**
 * The sharing state of a single Candidate.
 *
 *   Synced   — file is in sync; record holds last-sync history for future planning.
 *   Default  — pending operation; will be processed on the next bulk sync pass,
 *              subject to the threshold guard.
 *   Deferred — explicitly held back by the user or the threshold guard; bulk sync
 *              skips this file until the state changes.
 *   Approved — user clicked Apply; bulk sync executes this on the next run,
 *              bypassing the threshold guard.
 */
type CandidateState = 'Synced' | 'Default' | 'Deferred' | 'Approved';
```

### Valid State Transitions

```
[new file, no history]  ──────────────────────────────────→  Default
[new file, has history] ──────────────────────────────────→  Default

Synced   → reconcile detects local or remote change ──────→  Default
Default  → reconcile: actionType becomes noOp ────────────→  Synced
Default  → threshold guard fires ─────────────────────────→  Deferred
Deferred → reconcile: mtime changed (auto-revocation) ────→  Default
Deferred → user approves in Sharing Status ───────────────→  Approved
Default  → user approves (non-deferred pending) ──────────→  Approved
Approved → syncOneFile succeeds (push / pull / conflict) ─→  Synced
Approved → syncOneFile succeeds (delete action) ──────────→  [removed]
Any      → both sides deleted / never-synced file gone ───→  [removed]
```

There is no `Deferred && Approved` ambiguity: the state is always exactly one of the four values.

---

## `Candidate` Interface

Replaces `SyncAction`, `DeferredCandidate`, `ViewCandidate`, and `SyncRecord`.

```typescript
/**
 * Unified record for a single vault path that sharing tracks.
 *
 * Persistent fields are stored in the `candidates` IDB object store and survive
 * plugin restarts.  Ephemeral fields are populated by CandidateStore.reconcile()
 * and are undefined between planning passes.
 *
 * All four sharing layers — planning, UI, deferral, execution — work directly
 * with Candidate.  There are no intermediate projection types.
 */
interface Candidate {
    // ── Identity (IDB key) ────────────────────────────────────────────────────
    path: string;

    // ── State (persistent) ────────────────────────────────────────────────────
    state: CandidateState;

    /**
     * What sharing plans to do with this file.
     * 'noOp' when state = 'Synced'.
     * Set / updated by reconcile() on every planning pass.
     */
    actionType: SyncActionType;

    // ── Last-sync history (persistent) ───────────────────────────────────────
    // Populated after each successful sync.  Used by the planning pass to
    // determine whether local / remote have changed since last sync.
    // All fields are 0 / '' for a file that has never been synced.
    driveFileId: string;
    syncedLocalMtime: number;
    syncedRemoteMtime: number;
    syncedLocalSize: number;
    syncedRemoteSize: number;
    syncedAt: number;            // epoch ms of the last successful sync; 0 = never synced

    // ── Deferral sentinels (persistent; meaningful only when state = 'Deferred') ──
    // Set when the candidate enters Deferred state.
    // Auto-revocation: if either mtime differs from the current value on the next
    // planning pass, the candidate transitions back to Default.
    deferredAt: number;          // epoch ms; 0 if not / never deferred
    deferredLocalMtime: number;  // local mtime at deferral time; 0 = file was absent
    deferredRemoteMtime: number; // remote mtime at deferral time; 0 = file was absent

    // ── Ephemeral (populated by reconcile(); undefined between passes) ─────────
    local?: FileSide;                              // current local file metadata
    remote?: FileSide & { driveFileId: string };  // current remote file metadata
}
```

`deferredLocalMtime` and `syncedLocalMtime` answer different questions:
- `syncedLocalMtime` — "has the local file changed *since we last synced it*?" (planning)
- `deferredLocalMtime` — "has the local file changed *since the user deferred it*?" (auto-revocation)

Both are needed and are set at different times.

---

## Types Eliminated

| Type | Replaced by |
|---|---|
| `DeferredCandidate` | `Candidate` with `state = 'Deferred'` |
| `ViewCandidate` | `Candidate` (`isDeferred` → `state === 'Deferred'`) |
| `MixedEntry` | eliminated; join logic moves into `CandidateStore.reconcile()` |
| `SyncAction` | eliminated; `Candidate` is passed directly to `syncOneFile` and the decision logic |
| `SyncRecord` | eliminated; fields inlined into `Candidate`; `sync-records` IDB store removed |

## Types Modified

**`FileSide`** — `path` field removed; path lives on `Candidate`.

```typescript
interface FileSide {
    mtime: number;
    size: number;
}
```

`localFs.list()` and `driveFs.listAll()` return path-keyed maps instead of `FileSide[]` so paths
are preserved without the redundant field.  The return types of those methods change accordingly;
see §Changes to Existing Components.

**`SyncFileResult`** — extended to carry the updated sync metadata so the caller can update
`CandidateStore` without `syncOneFile` needing a reference to the store:

```typescript
interface SyncFileResult {
    changed: boolean;
    merged: boolean;
    hadConflictMarkers: boolean;
    /** Set when changed = true; used by BulkSync to call candidateStore.markSynced(). */
    syncedState?: {
        driveFileId: string;
        localMtime: number;
        remoteMtime: number;
        localSize: number;
        remoteSize: number;
        syncedAt: number;
    };
}
```

**`SyncActionType`** — unchanged.  `'noOp'` is now a valid `Candidate.actionType` (for `Synced`
state) rather than being filtered out at the `SyncAction` layer.

---

## `CandidateStore` API

Replaces `DeferralStore` + `DeferralManager`.  Owns the `candidates` and `sync-state` IDB object
stores, sharing the same `IDBHelper` / database connection as `SyncStore`.

### In-memory cache

`CandidateStore` maintains a `Map<string, Candidate>` populated by `init()` and kept current by
every mutating method.  All read methods return from the cache — no IDB round-trip.  Only write
operations go to IDB.  This is the same pattern as the current `DeferralManager`.

```typescript
class CandidateStore {

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Warm in-memory caches from IDB.
     * Must be called once at startup before the scheduler's first tick.
     * Reads all candidates and the paused flag.
     */
    async init(): Promise<void>;

    // ── Planning ──────────────────────────────────────────────────────────────

    /**
     * Merge a fresh file enumeration into the store.  This is the sole place
     * where state transitions happen during a planning pass.
     *
     * For each path in the union of localFiles, remoteFiles, and existing candidates:
     *
     *   - Update ephemeral fields (local, remote) from the current enumeration.
     *   - Recompute actionType by comparing current local/remote mtimes with
     *     syncedLocalMtime / syncedRemoteMtime (the last-sync history).
     *   - State transitions:
     *       Synced   + actionType changed from noOp → Default
     *       Default  + actionType = noOp             → Synced (update syncedAt et al.)
     *       Deferred + either mtime changed           → Default (auto-revocation)
     *       Deferred + actionType = noOp              → [remove] (file came back into sync)
     *       Approved + actionType = noOp              → [remove] (sync happened externally)
     *       [no candidate] + file exists somewhere    → Default (new file discovered)
     *       [candidate exists] + file absent everywhere → [remove]
     *
     * Persists any changed records to IDB.  Fires onChanged if any persistent
     * state changed.
     */
    async reconcile(
        localFiles: Map<string, FileSide>,
        remoteFiles: Map<string, FileSide & { driveFileId: string }>,
    ): Promise<void>;

    // ── Read (all from in-memory cache; no IDB I/O) ───────────────────────────

    /** All candidates regardless of state; for SharingStatusView count table. */
    getAll(): Candidate[];

    /** Candidates filtered by actionType; for PendingListModal rows. */
    getByType(type: SyncActionType): Candidate[];

    /** state = 'Approved'; processed by doRun before any full planning pass. */
    getApproved(): Candidate[];

    /** state = 'Default'; subject to threshold guard and normal execution. */
    getPending(): Candidate[];

    /** True if any candidate has syncedAt > 0; replaces `allRecords.length > 0`. */
    hasSyncHistory(): boolean;

    /** Total of non-Synced candidates; for status bar display. */
    getPendingCount(): number;

    // ── User actions (from PendingListModal; persist to IDB) ──────────────────

    /**
     * Transition Deferred (or Default) → Approved for the given paths.
     * Resets deferral sentinel fields to 0.
     * Fires onChanged.
     */
    async approve(paths: string[]): Promise<void>;

    /**
     * Transition Default (or Approved) → Deferred for the given paths.
     * Sets deferredAt, deferredLocalMtime, deferredRemoteMtime from the
     * candidate's current ephemeral local / remote values.
     * Fires onChanged.
     */
    async defer(paths: string[], now?: number): Promise<void>;

    // ── Threshold guard ───────────────────────────────────────────────────────

    /**
     * Transition all Default candidates → Deferred, and set paused = true.
     * Called by BulkSync when the action count exceeds the threshold.
     * Fires onChanged once after all writes complete.
     */
    async deferAllAndPause(pending: Candidate[]): Promise<void>;

    // ── Execution lifecycle (called by BulkSync after syncOneFile) ────────────

    /**
     * Transition Approved → Synced after a successful push / pull / conflict sync.
     * Updates all synced* fields from `state`.
     * Persists to IDB.  Fires onChanged.
     */
    async markSynced(path: string, state: SyncFileResult['syncedState']): Promise<void>;

    /**
     * Remove a candidate entirely.
     * Used after a successful delete action, or when a file disappears from both vaults.
     * Fires onChanged.
     */
    async remove(path: string): Promise<void>;

    // ── Paused flag (was in DeferralStore / DeferralManager) ──────────────────

    async isPaused(): Promise<boolean>;
    isPausedSync(): boolean;        // sync; safe in scheduler tick hot path
    async setPaused(paused: boolean): Promise<void>;

    // ── Reactive ──────────────────────────────────────────────────────────────

    /**
     * Fired whenever any persistent state changes.
     * Wired in main.ts to updateStatusBar() + refreshSharingStatusViews().
     */
    onChanged: (() => void) | null;
}
```

---

## Changes to Existing Components

### `BulkSync`

`doRun()` is simplified.  The `pendingApprovedActions` field, `approveForExecution()` method, and
`hasPendingApprovedActions` getter are all removed.  `BulkSync` holds a reference to
`CandidateStore` instead of `DeferralManager`.

```typescript
private async doRun(): Promise<SyncPassResult> {
    if (await this.candidates.isPaused()) return result;

    // Approved candidates bypass planning and the threshold guard entirely.
    // Their intent has been persisted to IDB and survives plugin restarts.
    const approved = this.candidates.getApproved();
    if (approved.length > 0) {
        return this.executeApproved(approved);
    }

    // Normal planning pass.
    const [localFiles, { files: remoteFiles, duplicatePathsFound }] = await Promise.all([
        this.ctx.localFs.listAsMap(this.excludeMatcher),   // returns Map<string, FileSide>
        this.ctx.driveFs.listAllAsMap(rootFolderId),       // returns Map<string, FileSide & {driveFileId}>
    ]);
    await this.candidates.reconcile(localFiles, remoteFiles);

    // ... duplicate warning ...

    const pending = this.candidates.getPending();
    const localFileCount = localFiles.size;

    // Threshold guard.
    if (exceedsThreshold(pending, localFileCount, settings)) {
        await this.candidates.deferAllAndPause(pending);
        this.onThresholdPause(pending.length);
        return { ...result, deferredByThreshold: true };
    }

    // Execute pending candidates one at a time, yielding between each.
    const hasHistory = this.candidates.hasSyncHistory();
    for (const candidate of pending) {
        const fileResult = await syncOneFile(candidate, this.ctx, hasHistory);
        if (fileResult.syncedState) {
            if (candidate.actionType === 'deleteLocal' || candidate.actionType === 'deleteRemote') {
                await this.candidates.remove(candidate.path);
            } else {
                await this.candidates.markSynced(candidate.path, fileResult.syncedState);
            }
        }
        // count result by actionType ...
        await Promise.resolve(); // yield
    }
}
```

`executeApproved()` follows the same per-file pattern: call `syncOneFile(candidate)`, then
`markSynced` or `remove` depending on `candidate.actionType`.  The staleness check (former
`action.local.mtime` comparison) is removed: if the local file changed since approval, `syncOneFile`
handles the resulting state naturally (it will see a conflict or a noOp and return accordingly).

`planOnly()` calls `candidateStore.reconcile()` and returns `candidateStore.getAll()`.

`BulkSync` no longer needs the `App` parameter it received solely for passing to `PendingListModal`
(now handled directly by the modal's own caller).

### `SharingStatusView`

Eliminated fields / methods:
- `viewCandidates: ViewCandidate[]` → replaced by `candidateStore.getAll()` / `getByType()`
- `isRefreshing: boolean` → replaced by observing `candidateStore.onChanged`
- `runPlan(): Promise<void>` → replaced by calling `bulkSync.planOnly()` which calls
  `candidateStore.reconcile()` internally
- `onCandidatesChanged` callback and all wiring
- `planFn` constructor parameter

`SharingStatusView` subscribes to `candidateStore.onChanged` (wired in `main.ts`) and reads from
the store's in-memory cache on each render.  Every `refresh()` call is O(1) in IDB I/O.

The "Refresh" button triggers `bulkSync.planOnly()` (which runs `reconcile()` behind the scenes)
and then calls `refresh()`.

### `PendingListModal`

Eliminated constructor parameters:
- `approveForExecution: ((actions: SyncAction[]) => void) | null`
- `onCandidatesChanged: (released: string[], deferred: string[]) => void`

`applyAccepted()` now calls directly:
```typescript
await candidateStore.approve(toApprovePaths);    // Deferred / Default → Approved
await candidateStore.defer(toDeferPaths);        // Default → Deferred
// candidateStore.onChanged fires automatically; no manual callback needed
this.close();
```

`PendingListModal` receives a `CandidateStore` reference in its constructor.  `getByType()` replaces
the `candidates: ViewCandidate[]` constructor parameter — the modal always reads fresh data from
the store rather than a snapshot passed at open time.

### `main.ts`

Eliminated:
- `DeferralStore` and `DeferralManager` construction
- `approveForExecution` callback threading through `SharingStatusView` and `PendingListModal`
- `hasPendingApprovedActions` check in the `start-sync` command

The `start-sync` command reverts to its original simple form:
```typescript
void candidateStore.setPaused(false).then(() => {
    scheduler.triggerBulkSync();
});
```

Because `doRun()` checks `candidateStore.getApproved()` before any planning pass, the
`triggerBulkSync` race cannot re-trigger the threshold: approved candidates are in IDB, survive
any number of scheduler ticks, and are always processed before a full planning pass begins.

`CandidateStore` is constructed in `main.ts` and passed to `BulkSync`, `SharingStatusView`,
`PendingListModal` (via `SharingStatusView`), and added to `SyncContext` so `syncOneFile` can
access it if needed (see §`syncOneFile`).

The `onChanged` callback registered on `CandidateStore` handles everything the `DeferralManager`
callback previously handled: status bar updates and view refresh.

### Decision Engine (`decision-engine.ts`)

`planActions(entries: MixedEntry[], vaultHasHistory: boolean): SyncAction[]` is replaced by:

```typescript
/**
 * Determine the sharing action for a single candidate given the current
 * local and remote file state and the candidate's last-sync history.
 * Returns the actionType; the caller (CandidateStore.reconcile) applies it.
 */
function planAction(
    candidate: Candidate,
    local: FileSide | undefined,
    remote: (FileSide & { driveFileId: string }) | undefined,
    vaultHasHistory: boolean,
): SyncActionType;
```

`CandidateStore.reconcile()` calls `planAction()` for each path.  The decision logic itself is
unchanged; only the call site and types change.

### `syncOneFile`

Signature changes from `syncOneFile(action: SyncAction, ...)` to `syncOneFile(candidate: Candidate, ...)`.

All field accesses change:
- `action.type` → `candidate.actionType`
- `action.path` → `candidate.path`
- `action.local` → `candidate.local`
- `action.remote` → `candidate.remote`
- `action.record` → constructed inline from `candidate.syncedLocalMtime`, `candidate.syncedRemoteMtime`,
  `candidate.driveFileId`, etc.  (The concept of `SyncRecord` is gone; `syncOneFile` reads the
  sync-history fields directly from `Candidate`.)

After a successful sync, instead of calling `ctx.store.putRecord(record)`, `syncOneFile` returns
the updated sync state in `SyncFileResult.syncedState`.  `BulkSync` calls
`candidateStore.markSynced(path, syncedState)` after each successful file.  `syncOneFile` no longer
writes to IDB at all.

### `SyncStore`

`sync-records` object store and all associated methods are removed:
- `getRecord(path)` → removed
- `getAllRecords()` → removed
- `putRecord(record)` → removed
- `clearAll()` → no longer clears `sync-records`; still clears other stores

`SyncRecord` type is removed from `types.ts`.

Remaining stores: `sync-content`, `sync-stats`, `device`, `sync-state`.  `CandidateStore` owns
`candidates` and `sync-state` on the same shared `IDBHelper`.

`SyncContext.store` is retained for `sync-content` access (merge base for conflict resolution)
and stats.

---

## IDB Schema (version 3)

### `candidates` store (keyPath: `path`)

| Field | Type | Notes |
|---|---|---|
| `path` | string | vault path; IDB key |
| `state` | string | `'Synced'` \| `'Default'` \| `'Deferred'` \| `'Approved'` |
| `actionType` | string | `SyncActionType`; `'noOp'` when `state = 'Synced'` |
| `driveFileId` | string | Drive file ID from last sync; `''` if never synced |
| `syncedLocalMtime` | number | local mtime at last sync; 0 if never synced |
| `syncedRemoteMtime` | number | remote mtime at last sync; 0 if never synced |
| `syncedLocalSize` | number | 0 if never synced |
| `syncedRemoteSize` | number | 0 if never synced |
| `syncedAt` | number | epoch ms of last sync; 0 if never synced |
| `deferredAt` | number | epoch ms when deferred; 0 otherwise |
| `deferredLocalMtime` | number | 0 if not deferred or file was absent |
| `deferredRemoteMtime` | number | 0 if not deferred or file was absent |

Ephemeral fields (`local`, `remote`) are NOT persisted.

### `sync-state` store (keyPath: `key`) — unchanged

Holds the `syncPaused` flag.  Moved from `DeferralStore`; schema unchanged.

### Removed stores

`sync-records` and `deferred-candidates` are removed in schema version 3.

---

## Files Affected

| File | Change |
|---|---|
| `src/sync/types.ts` | Add `Candidate`, `CandidateState`; remove `DeferredCandidate`, `ViewCandidate`, `MixedEntry`, `SyncAction`, `SyncRecord`; modify `FileSide`, `SyncFileResult` |
| `src/sync/candidate-store.ts` | New file; replaces `deferral-store.ts` + `deferral-manager.ts` |
| `src/sync/deferral-store.ts` | Delete |
| `src/sync/deferral-manager.ts` | Delete |
| `src/sync/store.ts` | Remove `sync-records` store and all `SyncRecord` methods; bump `DB_VERSION` to 3; extract `createStores()` |
| `src/sync/bulk-sync.ts` | Remove `pendingApprovedActions`, `approveForExecution`, `hasPendingApprovedActions`; rewrite `doRun` and `executeApproved` to use `CandidateStore` |
| `src/sync/bulk-sync.test.ts` | Rewrite deferral / executeApproved tests |
| `src/sync/change-detector.ts` | Delete (`buildMixedEntries` absorbed into `CandidateStore.reconcile`) |
| `src/sync/decision-engine.ts` | Replace `planActions` with `planAction` (single-candidate form); remove `MixedEntry` / `SyncAction` references |
| `src/sync/file-syncer.ts` | Change `syncOneFile` signature from `SyncAction` → `Candidate`; return `syncedState` in result; remove `ctx.store.putRecord` calls |
| `src/sync/resolution-executor.ts` | Update all `SyncAction` references to `Candidate` |
| `src/sync/local-fs.ts` | Add `listAsMap(): Promise<Map<string, FileSide>>` alongside or replacing `list()` |
| `src/sync/drive-fs.ts` | Add `listAllAsMap()` returning `Map<string, FileSide & {driveFileId}>` |
| `src/sync/scheduler.ts` | `isSharingPaused` / `isDeferredPath` backed by `CandidateStore` instead of `DeferralManager` |
| `src/sync/types.ts` | Add `CandidateStore` to `SyncContext` |
| `src/ui/sharing-status-view.ts` | Remove `viewCandidates`, `runPlan`, `isRefreshing`, `onCandidatesChanged`; read from `CandidateStore` |
| `src/ui/pending-list-modal.ts` | Remove `approveForExecution` + `onCandidatesChanged` params; call `candidateStore.approve/defer` directly |
| `src/main.ts` | Remove `DeferralStore`, `DeferralManager`; construct `CandidateStore`; simplify `start-sync` command; remove callback threading |

Existing tests in `deferral-manager.test.ts`, `deferral-store.test.ts`, `scheduler.test.ts`, and
`bulk-sync.test.ts` will need substantial revision.  The net test code should shrink because
callback wiring under test disappears.

---

## Implementation Order

1. **`types.ts`** — add `Candidate`, `CandidateState`, modify `FileSide` and `SyncFileResult`;
   keep old types temporarily (`// @deprecated`) so the build still compiles during transition.
2. **`store.ts`** — bump `DB_VERSION` to 3, add `createStores()`, remove `sync-records` methods.
3. **`candidate-store.ts`** — implement `CandidateStore`; write unit tests.
4. **`decision-engine.ts`** — refactor `planActions` → `planAction` (single-candidate).
5. **`file-syncer.ts`** — update `syncOneFile` signature and return type.
6. **`resolution-executor.ts`** — update `SyncAction` → `Candidate` references.
7. **`bulk-sync.ts`** — rewrite `doRun` and `executeApproved`; update tests.
8. **`sharing-status-view.ts`** and **`pending-list-modal.ts`** — remove callback wiring; read
   from `CandidateStore`.
9. **`main.ts`** — wire `CandidateStore`; simplify `start-sync` command.
10. **Delete** `deferral-store.ts`, `deferral-manager.ts`, `change-detector.ts`.
11. Full test pass; lint + build clean.

---

## Open Questions

1. **`planAction` placement**: should the single-candidate planning logic live inside
   `CandidateStore.reconcile()` directly, or remain in `decision-engine.ts` as a pure function
   called by `reconcile()`?  Keeping it in `decision-engine.ts` is more testable in isolation.

2. **`listAsMap` / `listAllAsMap`**: add new methods to `LocalFs` / `DriveFsAdapter`, or
   convert the callers to build the maps themselves from the existing `list()` / `listAll()`
   results?  The latter requires no API change to those classes but adds a small mapping step.

3. **`syncOneFile` and `SyncContext`**: should `syncOneFile` receive `CandidateStore` via
   `SyncContext` (for future use), or is returning `syncedState` in `SyncFileResult` sufficient
   to keep it decoupled?  Recommend the latter: keep `syncOneFile` decoupled; caller updates the
   store.

4. **`isDeferredPath` in the scheduler**: currently `DeferralManager.isDeferredPathSync()` tells
   the scheduler whether a single-file sync should be skipped for a given path.
   `CandidateStore.getAll()` provides this; a thin `isDeferred(path): boolean` sync method on
   `CandidateStore` replaces the old one.
