# Timestamp-conflict improvements

Addresses two problems and one enhancement that surface when connecting a local vault to an
existing group vault whose files have identical content but different timestamps — a common
first-sync scenario.

---

## Problem 1 — No notice when bulk sync pauses sharing  *(Phase 0, complete)*

**Root cause.** When the threshold guard fires in `BulkSync.doRun`, it updates the status bar
and writes an INFO log entry, but shows no Obsidian `Notice`. The user has no visible
indication that sharing was just paused.

**Fix.** Added an `onThresholdPause: (count: number) => void` callback to `BulkSync`'s
constructor. Fired in `doRun` when `deferredByThreshold` is set. Wired in `main.ts` to show a
`Notice` with a "Tap to review" link (same pattern as `showDeferralNotice`).

---

## Problem 2 — Threshold re-fires after user explicitly approves all deferred candidates  *(Phase 1)*

### Symptom

1. Threshold guard fires: 200 timestamp-conflict files exceed the configured percentage.
   All are deferred; sharing is paused.
2. User opens Sharing Status panel, opens the conflict list, selects all, clicks Apply.
   All 200 candidates are released from deferral.
3. User resumes sharing.
4. Next bulk sync re-plans from scratch, finds the same 200 conflicts, threshold fires again,
   and defers them all — discarding the user's explicit approval.

### Root cause

The user's approval (Apply → `releaseByPath`) only removes `DeferredCandidate` records from
IndexedDB. It leaves no record of *why* those paths were released. The next planning pass has
no way to distinguish "released because the user approved it" from "released because the file
changed". So the threshold guard re-fires unconditionally.

Additionally, the approved `SyncAction` data is silently discarded when `ViewCandidate` is
built in `doPlanning` — the modal receives a lossy projection and cannot return the full
actions to the executor.

### Design

#### `ViewCandidate` carries the full `SyncAction`

`ViewCandidate` is redefined as an extension of `SyncAction` rather than a lossy projection:

```ts
export interface ViewCandidate extends SyncAction {
    isDeferred: boolean;
}
```

`doPlanning` builds it by spreading the `SyncAction`:

```ts
const viewCandidates: ViewCandidate[] = allActions
    .filter(a => a.type !== 'noOp')
    .map(a => ({ ...a, isDeferred: deferredPaths.has(a.path) }));
```

This eliminates two redundant fields:
- `ViewCandidate.actionType` → removed; use `SyncAction.type` (UI code updated throughout)
- `ViewCandidate.driveFileId` → removed; use `SyncAction.remote?.driveFileId` (UI code updated)

The modal is now literally a **filter on `SyncAction[]`**: it receives `ViewCandidate[]`
(which are `SyncAction`s), the user makes selections, and Apply returns the approved subset as
`SyncAction[]` — no reconstruction step needed.

#### `BulkSync` alternate execution entry point

`BulkSync` gains two new members:

```ts
/** Full SyncAction[] from the most recent doPlanning pass. */
private lastPlanActions: SyncAction[] | null = null;

/** Actions approved by the user via Apply; consumed by the next doRun call. */
private pendingApprovedActions: SyncAction[] | null = null;
```

A new public method lets the UI deposit approved actions:

```ts
/** Called by PendingListModal after Apply to schedule direct execution. */
approveForExecution(actions: SyncAction[]): void {
    this.pendingApprovedActions = actions;
}
```

`doRun` checks for pending approved actions before falling through to the normal planning path:

```
doRun()
  ├─ if pendingApprovedActions is set:
  │    └─ executeApproved(pendingApprovedActions)   // no re-plan, no threshold guard
  └─ else:
       └─ doPlanning() → threshold guard → normal execution loop
```

#### `executeApproved` — execution without re-planning

```ts
private async executeApproved(actions: SyncAction[]): Promise<SyncPassResult>
```

Steps:

1. **Local mtime validation** (cheap, no network): for each action, call `localFs.stat(path)`.
   If the local mtime differs from `action.local?.mtime`, the file changed since the plan —
   skip it and log at INFO level. Remote staleness (another vault modified Drive in the
   interim) is caught naturally inside `syncOneFile` and handled by its existing error path.

2. **Execute** the valid subset via the existing `syncOneFile` loop (same yield-between-files
   pattern as `doRun`).

3. Files **not** in the approved list (still deferred in IDB, or not yet seen) are untouched.
   The scheduler's next regular tick will pick them up.

#### Wiring

`PendingListModal` gains a reference to a `approveForExecution` callback (typed as
`((actions: SyncAction[]) => void) | null`). When Apply is tapped, after calling
`manager.releaseByPath(toRelease)` as today, it calls
`approveForExecution?.(approvedViewCandidates)`.

The callback is threaded in from `SharingStatusView`, which receives it in its constructor
from `main.ts` (where `BulkSync` is available). `approveForExecution` is optional — when
null, the Apply button still releases from deferral as before; it just won't use the fast
execution path (backwards-compatible).

#### `DeferredCandidate` in IDB — unchanged

`DeferredCandidate` records continue to serve their existing purposes:
- Survive plugin restarts (the approved `SyncAction[]` is in-memory only).
- Supply stored mtimes for `reconcile()`'s auto-revocation checks.

The `releaseByPath` call in `applyAccepted` still removes `DeferredCandidate` rows from IDB
as today. `approveForExecution` is an additional action, not a replacement.

### Files affected

| File | Change |
|---|---|
| `src/sync/types.ts` | `ViewCandidate extends SyncAction`; remove `actionType`, `driveFileId` fields |
| `src/sync/bulk-sync.ts` | `lastPlanActions`, `pendingApprovedActions`, `approveForExecution()`, `executeApproved()`, routing in `doRun` |
| `src/sync/deferral-manager.ts` | No change |
| `src/ui/sharing-status-view.ts` | Accept and thread `approveForExecution` callback; `candidate.type` not `.actionType` |
| `src/ui/pending-list-modal.ts` | Accept `approveForExecution` callback; call after `releaseByPath`; `candidate.type` |
| `src/ui/pending-file-panel.ts` | `candidate.type` not `.actionType` |
| `src/sync/bulk-sync.test.ts` | New tests for `executeApproved`: mtime validation, stale-skip, result counts |
| `src/sync/deferral-manager.test.ts` | No new tests needed for this phase |
| `specs/ARCHITECTURE.md` | **Update after implementation is complete** — see §Architecture doc task below |

### Tests

- `executeApproved` with all-valid actions: result counts match.
- `executeApproved` with one stale local file: stale action skipped, rest execute.
- `executeApproved` with empty list: no-op, no errors.
- `approveForExecution` called, then `doRun` via normal path (scheduler tick): approved actions
  consumed and executed without re-planning; subsequent `doRun` call goes through normal path.

---

## Enhancement 1 — Identical-content conflicts reconciled by hash comparison  *(Phase 2, planned)*

When both sides have the same bytes but different mtimes, the planner correctly emits
`conflict` (it only sees timestamps, not content). This enhancement detects the
identical-content case at execution time and reconciles the `SyncRecord` without any file
writes, so future planning passes see `noOp` for those paths.

### Hash source: Drive's `sha256Checksum`

Google Drive API v3 provides a `sha256Checksum` field on every File resource for binary
files stored in Drive (added August 2022). It is returned for free alongside existing
metadata in `files.list` responses — no extra API call — when added to the `fields=`
parameter. The field is documented as *"if available"*: it may be absent for files uploaded
before August 2022, or lazily populated in edge cases. Absent = missing/empty field, never
an error.

Vault files (`.md`, `.json`, images, etc.) always qualify. Google Workspace documents
(Docs, Sheets, Slides) do not, but vault-share never syncs those.

`sha256Checksum` pairs directly with `crypto.subtle.digest('SHA-256', ...)` — the standard
Web Crypto API available on all platforms including Obsidian mobile. No external library is
needed.

The "if available" gap is self-healing: every file vault-share pushes or updates will have
its `sha256Checksum` populated in the response going forward.

### Design

#### Layer 1 — Drive API: surface `sha256Checksum`

Add `sha256Checksum?: string` to the `DriveFile` interface in `src/gdrive/api.ts` and to
the `assertDriveFile` validator. Add `sha256Checksum` to the `fields=` string in every
method that requests file metadata:

| Method | Current `fields=` | Addition |
|---|---|---|
| `listChildren` | `files(id,name,mimeType,modifiedTime)` | `sha256Checksum` |
| `getFile` | `id,name,mimeType,modifiedTime` | `sha256Checksum` |
| `findChild` | `files(id,name,mimeType,modifiedTime)` | `sha256Checksum` |
| `createFileWithContent` | `id,name,mimeType,modifiedTime` | `sha256Checksum` |
| `updateFileContent` | `id,name,mimeType,modifiedTime` | `sha256Checksum` |

#### Layer 2 — Drive FS adapter: thread `sha256Checksum` into `DriveFileSide`

Add `sha256Checksum?: string` to `DriveFileSide` in `src/sync/drive-fs.ts`. Populate it
from `DriveFile.sha256Checksum` wherever `DriveFileSide` objects are constructed (in
`walkFolder` and `stat`). The write path (`driveFs.write`) already returns a `DriveFile`;
thread `sha256Checksum` through to the returned `DriveFileSide` so newly pushed files
immediately have their hash available for the next planning pass.

`DriveFileSide` flows into `SyncAction.remote` via `MixedEntry`, so the hash arrives at
the executor with no further plumbing.

#### Layer 3 — Hash utility

New file `src/sync/content-hash.ts`:

```ts
/**
 * Compute the SHA-256 hex digest of an ArrayBuffer using Web Crypto.
 * Available on all platforms including Obsidian mobile (no Node.js required).
 */
export async function sha256Hex(content: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
```

#### Layer 4 — Execution: short-circuit identical-content conflicts

In `src/sync/file-syncer.ts`, at the top of the `conflict` case, before calling
`resolveConflict`:

```
1. Size fast-path: if action.local.size !== action.remote.size → skip hash, fall through
   to resolveConflict (content is definitely different).

2. Hash fast-path: if action.remote.sha256Checksum is absent → fall through to
   resolveConflict (no hash to compare against; pre-2022 file or edge case).

3. Read local content: await ctx.localFs.read(action.path)

4. Compute local hash: await sha256Hex(localContent)

5. Compare: if localHash !== action.remote.sha256Checksum → fall through to resolveConflict,
   passing localContent as a pre-read to avoid a second local read inside resolveConflict.

6. Identical content: write SyncRecord with actual current timestamps from both sides.
   No file writes. Store local content in sync-content cache.
   Log at INFO: "Timestamp reconciled (identical content): <path>"
   Return { changed: true, identicalContent: true, merged: false, hadConflictMarkers: false }
```

Step 5 passes `localContent` into `resolveConflict` as an optional `preread` argument to
avoid a redundant local file read for genuine conflicts. `resolveConflict` and its internal
strategy functions accept `preread?: { localContent: ArrayBuffer }` and use it when present.

#### Layer 5 — Result accounting

Add to `FileSyncResult`:
```ts
identicalContent: boolean;   // true when hash matched; no file writes performed
```

Add to `SyncPassResult`:
```ts
identicalTimestamps: number; // count of files reconciled via hash match
```

`BulkSync.doRun` increments `result.identicalTimestamps` when `fileResult.identicalContent`
is true, and includes the count in the status bar summary when > 0:
`"Shared: 0 downloaded, 0 uploaded, 0 deleted, 200 timestamps reconciled"`

### Files affected

| File | Change |
|---|---|
| `src/gdrive/api.ts` | Add `sha256Checksum?: string` to `DriveFile`; add to all `fields=` strings; update `assertDriveFile` |
| `src/sync/drive-fs.ts` | Add `sha256Checksum?: string` to `DriveFileSide`; populate from `DriveFile` in `walkFolder`, `stat`, and write path |
| `src/sync/types.ts` | Add `identicalContent: boolean` to `FileSyncResult`; add `identicalTimestamps: number` to `SyncPassResult` |
| `src/sync/content-hash.ts` | New file: `sha256Hex()` utility |
| `src/sync/file-syncer.ts` | Size fast-path; hash fast-path; local read + hash; SyncRecord reconcile for identical; `preread` threading |
| `src/sync/conflict-resolver.ts` | Accept optional `preread?: { localContent: ArrayBuffer }`; use when present to skip re-read |
| `src/sync/bulk-sync.ts` | Count `identicalTimestamps`; include in status bar summary |
| `src/gdrive/api.test.ts` | Verify `sha256Checksum` is included in `fields=` and passed through `assertDriveFile` |
| `src/sync/drive-fs.test.ts` | Verify `sha256Checksum` flows from `DriveFile` into `DriveFileSide` |
| `src/sync/content-hash.ts` | Unit tests for `sha256Hex` (mock `crypto.subtle`) |
| `src/sync/file-syncer.test.ts` | Size fast-path; hash fast-path (absent hash); identical-content path (SyncRecord written, no resolveConflict); differing-content path (resolveConflict called with preread) |
| `specs/ARCHITECTURE.md` | **Update after implementation is complete** — see §Architecture doc task below |

### Graceful degradation summary

| Condition | Behaviour |
|---|---|
| `sha256Checksum` absent on remote | Fall through to normal conflict resolution |
| Sizes differ | Fall through immediately (skip hash computation) |
| Hashes differ | Fall through to `resolveConflict`, passing pre-read local content |
| Hash matches | Reconcile SyncRecord only; no file writes; count as `identicalTimestamps` |

---

## Architecture doc task

Update `specs/ARCHITECTURE.md` after each phase merges:

### After Phase 1

1. The **plan → review → execute** flow as a first-class mode distinct from the automated
   schedule-and-sync loop. The three phases are: `doPlanning` (enumerate + plan), user
   review in the Sharing Status panel / Candidate list modal (filter), and `executeApproved`
   (execute without re-planning or threshold guard).

2. The updated **`ViewCandidate`** type: that it extends `SyncAction` and is the single
   representation used from planning through to execution, avoiding lossy projection.

3. The **`DeferredCandidate`** / **`ViewCandidate`** distinction: `DeferredCandidate` is the
   persisted IDB snapshot (survives restarts, supplies mtimes for auto-revocation);
   `ViewCandidate` is the live in-memory representation used by the UI and executor.

### After Phase 2

1. The **`sha256Checksum`** field on `DriveFileSide`: that it comes free from the Drive
   `files.list` response, requires no extra API call, and is used at conflict-execution time
   to short-circuit identical-content conflicts without a remote file download.

2. The **identical-content fast path** in `file-syncer`: size check → hash check →
   SyncRecord reconcile. Explain the three-level graceful degradation (absent hash, size
   mismatch, hash mismatch) so future maintainers understand why `resolveConflict` is not
   always called for `conflict`-typed actions.

3. The **`identicalTimestamps`** counter in `SyncPassResult` and its appearance in the
   status bar summary.
