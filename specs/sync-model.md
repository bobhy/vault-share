# Sync model — the living reference

> **Status: Living.** This is the authoritative conceptual reference for the
> sync engine. Read this *before* the code in [`src/sync/`](../src/sync/).
> It describes the current model — the vocabulary, the unit of state, the state
> machine, the pipeline, and the invariants — and deliberately avoids
> code-level detail (signatures, field-by-field walkthroughs) so it does not rot
> against the implementation. For the "how", the per-identifier TypeDoc comments
> in the source are authoritative; this doc is the "what" and "why".

## Glossary

| Term | Meaning |
|------|---------|
| **Local vault** | The Obsidian vault on this device. One per install. |
| **Group vault** | The shared cloud folder (a Google Drive folder) that every device syncs against. Also called the *Drive folder* or *remote*. |
| **Side** | One of the two views of a path: *local* (in the vault) or *remote* (in the group vault). A file may exist on one side, both, or neither. |
| **Candidate** | The unit of sync state: one record per vault path, tracking both sides plus the last-sync history for that path. See below. |
| **Sync history** | The persisted record of what was last successfully synced for a path (mtimes, sizes, `driveFileId`, `syncedAt`). A candidate "has history" once `syncedAt > 0`. |
| **`hasSyncHistory()`** | A *vault-global* predicate: true if *any* candidate has been synced at least once. The master switch that selects the with-history vs. no-history planning path and gates the threshold guard. |
| **Rebaseline** | Recording two already-matching sides as `Synced` *without* moving any bytes — used when a candidate has no history but both sides are present and look identical. |
| **Bulk sync pass** | One full reconcile-plan-execute cycle over every path. The scheduler and UI both trigger this; concurrent triggers coalesce onto one in-flight pass. |

## The unit of state: `Candidate`

Sharing tracks exactly one `Candidate` per vault path. There are no separate
projection types — planning, the UI, deferral, and execution all read and write
the same record. Each candidate carries three things:

1. **Identity** — the `path` (the IDB key).
2. **State + planned action** — a `CandidateState` and the `actionType`
   reconcile last computed for it.
3. **Last-sync history** — the mtime/size of each side *as of the last
   successful sync*, plus `syncedAt` (0 = never synced). This is what lets the
   next pass tell "changed since we last looked" from "unchanged".

Plus *ephemeral* `local` / `remote` fields, populated only during a pass from
the live enumeration and discarded between passes.

**Immutability contract:** readers get stable snapshots. Every mutation
*replaces* the cache entry rather than editing it in place, so a held reference
goes stale (describes the candidate at fetch time) but never lies. Re-fetch from
the store, or subscribe to its change notifications, to see current state.

Authoritative shape: [`types.ts`](../src/sync/types.ts). Store:
[`candidate-store.ts`](../src/sync/candidate-store.ts).

## The state machine

A candidate moves between four states. `actionType` is `noOp` exactly when the
state is `Synced`; in every other state it names the pending operation.

```
                 reconcile: sides differ from record
        ┌──────────────────────────────────────────────┐
        │                                                ▼
   ┌─────────┐   reconcile: sides agree           ┌───────────┐
   │ Synced  │ ◀───────────────────────────────── │  Default  │
   └─────────┘                                     └───────────┘
        ▲          successful push/pull/conflict       │   ▲
        │          (markSynced)                        │   │ user clicks Apply
        │                                              │   │ (approve)
        │                                              ▼   │
        │                                         ┌───────────┐
        │   reconcile: a side's mtime changed     │ Approved  │
        │   since deferral (auto-revoke)          └───────────┘
        │            ┌───────────────────┐             │
        │            ▼                    │             │ executed next pass,
   ┌───────────┐  back to Default   ┌───────────┐      │ bypasses threshold
   │ Deferred  │ ─────────────────▶ │  Default  │      ▼
   └───────────┘                    └───────────┘   (Synced or removed)
        ▲
        │ threshold guard fires (deferAllAndPause)
        │ or user defers explicitly
   (from Default / Approved)
```

- **`Synced`** — in sync; the record holds history for future planning.
- **`Default`** — a pending operation, subject to the threshold guard on the
  next pass.
- **`Deferred`** — held back (by the user or the threshold guard). Skipped until
  one side's mtime changes, which auto-revokes back to `Default`.
- **`Approved`** — the user clicked Apply. Executed on the next pass *before* any
  planning and *bypassing* the threshold guard. State is persisted, so it
  survives restarts and scheduler races.

A candidate is **removed** entirely when both sides are gone, or after a
successful delete, or when a conflict resolution moves the original path aside.

## The pipeline

One bulk sync pass, in order ([`bulk-sync.ts`](../src/sync/bulk-sync.ts)):

1. **Guard rails.** Bail if not logged in, if paused. If any `Approved`
   candidates exist, execute *those only* and return (bypasses everything
   below).
2. **Enumerate** both sides: list the local vault and the whole Drive folder.
3. **Reconcile** ([`candidate-store.ts`](../src/sync/candidate-store.ts)): for
   the union of (local paths ∪ remote paths ∪ existing candidates), refresh the
   ephemeral sides, recompute `actionType` via `planAction`, and apply the state
   machine. This is pure bookkeeping — **no files move during reconcile.**
4. **sha256 rebaseline verification.** For each path reconcile just rebaselined
   as `Synced` by the size-equality heuristic (see below), verify with Drive's
   `sha256Checksum`; on mismatch, flip it back to a `Default` conflict.
5. **Threshold guard.** If the pending-action ratio is too high, defer all
   pending candidates and pause instead of executing (see below).
6. **Execute** each pending candidate one at a time via the file syncer, writing
   the result back to the store (`markSynced` / `remove`). Yields between files.

`planAction` ([`decision-engine.ts`](../src/sync/decision-engine.ts)) is the
pure heart of step 3. It has two branches selected per candidate:

- **No-history path** (`!hasSyncHistory()` *or* this candidate `syncedAt === 0`):
  decide on *presence alone*. Local-only → `push`; remote-only → `pull`;
  both-present → rebaseline if sizes match, else `conflict`; neither → `noOp`.
  **This branch never emits a delete.**
- **With-history path**: classify each side against the record as
  `unmodified` / `modified` / `deleted`, then cross-tabulate. This is the
  *only* branch that produces `deleteLocal` / `deleteRemote` — a side is treated
  as deleted only when the record says it once existed and it is now absent.

## The no-history rebaseline (the load-bearing heuristic)

When a candidate has no history but both sides are present, fabricating a
`conflict` would be wrong — the files are very likely already in sync (fresh
install joining an established group vault; post-`pluginReset`; identical files
created independently). So `planAction` returns `noOp` when **byte sizes match**,
and reconcile records a `Synced` candidate at the current mtimes/sizes so future
passes classify subsequent edits correctly.

- **Size only, not mtime** — Drive's `modifiedTime` is the *upload* time, not the
  original file mtime, so identical content almost never has matching mtimes.
- **Size only, not content** — reading every file would be expensive; size is a
  low-false-positive proxy (edits virtually always change byte count).
- **The false-positive window** (two unrelated files at the same path with
  coincidentally equal byte counts) is closed by the step-4 sha256 verification
  when Drive supplies a checksum.

History: [item (17) in sync-review-followups.md](sync-review-followups.md) and
[timestamp-conflict-improvements.md](timestamp-conflict-improvements.md).

## The threshold guard

A safety brake against mass, unintended change. If the fraction of paths with a
pending action exceeds the configured threshold (and the union population is
above a floor), the pass defers everything and pauses, asking the user to
confirm rather than silently moving a large number of files.

Its enablement is asymmetric, and this asymmetry is exactly the
new-vault-alignment surface where bugs hide:

| Situation | Guard |
|-----------|-------|
| Local populated, remote populated | **On.** |
| Local populated, remote **empty**, **no** history | **Off** — fresh install pushing into an empty group vault; the user wants it all to go without a dialog. |
| Local populated, remote **empty**, history **exists** | **On** — an established record with a now-empty remote signals an accidental Drive wipe or the wrong folder. Confirm before re-uploading. |
| Local **empty** | **Off** — nothing on this device to protect yet. |

## Invariants

These are the contracts the engine must uphold. Each is directly testable; the
e2e suite should assert them. The ones marked **(bug watch)** are the
new-vault-alignment cases under active investigation (June 2026) where bulk sync
was observed deleting then re-pushing files.

1. **No-history never deletes.** With no sync history, a planning pass emits only
   `push` / `pull` / `noOp` / `conflict` — never `deleteLocal` / `deleteRemote`.
   Deletes require a record that says the now-absent side once existed.
2. **Initial sync, populated local + empty group ⇒ push only.** Every local file
   is pushed; zero deletes; the group vault ends up a copy of local.
   **(bug watch)**
3. **Initial sync, empty local + populated group ⇒ pull only.** Every remote
   file is pulled; zero deletes; local ends up a copy of the group vault.
   **(bug watch)**
4. **Initial sync, identical files on both sides, no history ⇒ rebaseline only.**
   Every dual-present matching path becomes `Synced` with no bytes moved; zero
   pushes, zero pulls, zero deletes, zero conflicts. **(bug watch)**
5. **Second pass is a no-op.** Immediately re-running a pass after a converged
   one moves nothing and leaves every candidate `Synced` (the candidate store is
   stable — no boomerang). This is the stability corollary of 2–4.
6. **A rebaselined candidate classifies later edits correctly.** After a
   rebaseline, a one-sided edit produces `push` / `pull` (not a fresh-history
   `conflict`).
7. **Approved bypasses the guard exactly once.** `Approved` candidates execute on
   the next pass without re-planning and without re-tripping the threshold.
8. **Switching/clearing the group vault must not silently mass-delete.** When the
   remote is empty but history exists, the threshold guard fires rather than
   issuing `deleteRemote`/`deleteLocal` for the whole vault. **(bug watch — the
   stale-history-vs-new-remote alignment is the prime suspect.)**

## Where this maps in code

| Concept | File |
|---------|------|
| Data shapes (`Candidate`, `SyncActionType`, `CandidateState`) | [`types.ts`](../src/sync/types.ts) |
| Pure decision logic (`planAction`, `classifyStatus`) | [`decision-engine.ts`](../src/sync/decision-engine.ts) |
| State store, reconcile, state machine, rebaseline | [`candidate-store.ts`](../src/sync/candidate-store.ts) |
| Pass orchestration, threshold guard, sha256 verification | [`bulk-sync.ts`](../src/sync/bulk-sync.ts) |
| Per-file execution (push/pull/conflict/delete) | [`file-syncer.ts`](../src/sync/file-syncer.ts) |
| Scheduling, coalescing, pause | [`scheduler.ts`](../src/sync/scheduler.ts) |
