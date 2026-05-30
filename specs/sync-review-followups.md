# Sync module review — follow-ups

Tracks issues identified in the code review of `src/sync/`. Each item links to
the relevant code and notes the fix direction. Check items off as they are
addressed; add follow-up items as new ones are discovered.

## High priority

- [x] **(1) Duplicated `planAction` + `classifyStatus`.** `decision-engine.ts` and
    `candidate-store.ts` held identical copies of these ~50 lines.
    - Done: deleted the private copies in `candidate-store.ts`; it now imports
        `planAction` from `decision-engine.ts`. Existing `candidate-store.test.ts`
        and the full e2e suite pass.
- [ ] **(2) Shared candidate references are mutated in place.** `markSynced`,
    `reconcile`, `defer`, `deferAllAndPause` reassign fields on cached `Candidate`
    objects. The bug we just fixed (
    [bulk-sync.ts:215](../src/sync/bulk-sync.ts#L215),
    [bulk-sync.ts:294](../src/sync/bulk-sync.ts#L294))
    was a direct consequence. UI code that reads `candidate.local` /
    `candidate.actionType` after an `await` on a store mutation sees the
    post-mutation value.
    - Fix direction (pick one):
        - `CandidateStore` replaces the cache entry with a fresh object on every
            mutation (cheap, no API change for callers).
        - `getAll` / `getByType` / `getPending` / `getApproved` return defensive
            copies.
    - Either way: document `Candidate` as immutable to readers in `types.ts`.
- [ ] **(3) `BulkSync.run()` early-return is silent.** When `this.running` is true,
    the second caller gets `{0,0,0,…,deferredByThreshold:false}` synchronously
    and `lastPassResult`/`lastPassCompletedAt` are not touched. Callers cannot
    distinguish "no-op because already running" from "ran, no work to do."
    See [bulk-sync.ts:95-99](../src/sync/bulk-sync.ts#L95-L99).
    - Fix direction:
        - Return `null` (or a typed sentinel) so the caller can decide whether to
            wait, **or**
        - Have the second caller `await` the in-flight pass and return *its* result.
    - The e2e `runBulkSync` helper in `wdio.conf.mts` should drop its polling
        once this is fixed.
- [ ] **(4) Dead branch in `classifyStatus`.** [decision-engine.ts:27-29](../src/sync/decision-engine.ts#L27-L29)
    returns `'modified'` for `(side present, !wasSynced)`, but `planAction`
    short-circuits to the no-history path whenever `!wasSynced`
    ([decision-engine.ts:57](../src/sync/decision-engine.ts#L57)). Either the
    branch is dead and should go, or the gate in `planAction` is wrong.
    - Decide which and adjust. Add a unit-test asserting the chosen behaviour.

## Medium priority

- [ ] **(5) O(n) candidate lookup in `singleFileSync`.**
    [single-file-sync.ts:39](../src/sync/single-file-sync.ts#L39) does
    `candidateStore.getAll().find(c => c.path === path)`. The backing store is
    already a `Map`.
    - Fix: expose `CandidateStore.get(path): Candidate | undefined` and call it.
- [ ] **(6) Keep Both / delete-conflict leaves the original candidate stranded.**
    [file-syncer.ts:92-128](../src/sync/file-syncer.ts#L92-L128) returns
    `newSyncedFiles` but no `syncedState`; callers in
    [bulk-sync.ts:236-239](../src/sync/bulk-sync.ts#L236-L239) /
    [single-file-sync.ts:90-95](../src/sync/single-file-sync.ts#L90-L95) insert
    the conflict-copy candidates but never `remove(candidate.path)` for the
    original. It only gets reaped on the *next* reconcile + another pass.
    - Fix: remove the original candidate in the Keep Both / delete-conflict
        branch. Decide in `file-syncer.ts` whether to surface this via the result
        (e.g. an extra `removedOriginal: boolean`) or have the caller infer it
        from "changed && !syncedState && newSyncedFiles".
- [ ] **(7) Threshold guard counts non-local changes.**
    [bulk-sync.ts:169](../src/sync/bulk-sync.ts#L169) tallies every non-`deleteLocal`
    candidate, so pulls and conflicts count toward
    `fileModificationConfirmationThreshold`. The setting name suggests "local
    modifications," but after a long disconnection a vault could have hundreds
    of pulls and trip the threshold unexpectedly.
    - Fix: either rename the setting, or scope `modifyCount` to push / conflict
        / deleteRemote (i.e. exclude pulls).
- [ ] **(8) Pull records pre-pull `remoteMtime`.**
    [file-syncer.ts:60-75](../src/sync/file-syncer.ts#L60-L75) uses
    `candidate.remote` (from reconcile, possibly stale) for `remoteMtime` /
    `remoteSize` in `syncedState`. Compare to the `conflict` branch which
    re-stats Drive ([file-syncer.ts:103](../src/sync/file-syncer.ts#L103)).
    - Fix: re-stat Drive after a pull so the persisted record matches Drive's
        current mtime.

## Low priority

- [ ] **(9) `walkFolder` ignores exclude rules on the Drive side.**
    [drive-fs.ts:173-187](../src/sync/drive-fs.ts#L173-L187) enumerates every
    Drive file; the matcher is only applied to local enumeration.
    - Fix: apply `ExcludeMatcher` symmetrically — probably at the reconcile call
        site, not the walker, so one policy covers both sides.
- [ ] **(10) `CandidateStore.isPaused()` async fallback is dead after `init()`.**
    [candidate-store.ts:523-531](../src/sync/candidate-store.ts#L523-L531) reads
    IDB only when `cachedPaused === null`. `BulkSync.doRun` `await`s it on every
    pass for no reason.
    - Fix: assert `cachedPaused !== null` after init, drop the async signature.
- [ ] **(11) No test for the `lastPassResult` / `lastPassCompletedAt` ordering
    invariant.** The e2e infrastructure depends on `lastPassResult` being
    assigned before `lastPassCompletedAt`. Add a unit test that asserts
    `lastPassCompletedAt > 0 → lastPassResult !== null` after a pass.
- [ ] **(12) `scheduler.fileStates` retention contract is implicit.**
    [scheduler.ts:236-241](../src/sync/scheduler.ts#L236-L241) — add a comment on
    the `fileStates` field describing the contract: entries are added on
    `file-open`, retained while a hold-down is pending, otherwise pruned by
    `recomputeVisibleFiles` on `layout-change`.

## Architectural follow-ups

- [ ] **(A1) The `Candidate` object conflates IDB row + cache entry + planning
    input/output + UI row + deferral sentinel.** Split into a persistent record +
    a transient planning view. Removes the mutation hazards in (2) by
    construction.
- [x] **(A2) `doRun` and `executeApproved` duplicated post-result handling.**
    Done: extracted a private `tallyFileResult(actionType, fileResult, result)`
    in `bulk-sync.ts` paired with `CandidateStore.applyFileResult(path,
    actionType, fileResult)`. Both loops now call the same two functions.
- [x] **(A3) `resolution-executor` and `bulk-sync`'s execute loop both
    applied file-sync results to the store.** Done: `executeAction`,
    `executeMerge`, `executeKeepLocal`, `executeKeepGroupVault`, and
    `singleFileSync` all call `candidateStore.applyFileResult(path, actionType,
    fileResult)`. The actionType-mutation bug class is impossible from this
    helper since each caller snapshots `actionType` before delegating.

## Status

Started: 2026-05-29. Issues identified during review of [src/sync/](../src/sync/)
following the e2e test rescue session.

DRY pass complete (items 1, A2, A3): all 392 unit tests + 18 e2e tests pass;
lint clean. Working tree delta is net −39 production lines across
`bulk-sync.ts`, `candidate-store.ts`, `resolution-executor.ts`,
`single-file-sync.ts` (+ matching mock updates in two test files).
