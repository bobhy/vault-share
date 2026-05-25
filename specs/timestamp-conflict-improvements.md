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

*(Full design TBD — to be specced before Phase 2 implementation begins.)*

---

## Architecture doc task

After Phase 1 implementation is merged, update `specs/ARCHITECTURE.md` to document:

1. The **plan → review → execute** flow as a first-class mode distinct from the automated
   schedule-and-sync loop. The three phases are: `doPlanning` (enumerate + plan),
   user review in the Sharing Status panel / Candidate list modal (filter), and
   `executeApproved` (execute without re-planning or threshold guard).

2. The updated **`ViewCandidate`** type: that it extends `SyncAction` and is the single
   representation used from planning through to execution, avoiding lossy projection.

3. The **`DeferredCandidate`** / **`ViewCandidate`** distinction: `DeferredCandidate` is the
   persisted IDB snapshot (survives restarts, supplies mtimes for auto-revocation);
   `ViewCandidate` is the live in-memory representation used by the UI and executor.
