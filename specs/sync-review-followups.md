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
- [x] **(2) Shared candidate references are mutated in place.** `markSynced`,
    `reconcile`, `defer`, `deferAllAndPause`, `approve` reassigned fields on
    cached `Candidate` objects. The bug we already fixed in `bulk-sync.ts` was a
    direct consequence.
    - Done: every mutation point in `CandidateStore` now builds a fresh
        `Candidate` (spread + override) and replaces the cache entry via
        `cache.set(path, next)`. Held references become stable snapshots; they
        go *stale* after a mutation but never lie about their fields.
    - The single-slot `onChanged` callback was widened to a multi-listener
        `onChange(fn): unsubscribe`, so non-`main.ts` subscribers can register
        without stomping on each other. `main.ts` is the first subscriber
        (status bar + sharing-status views); `PendingListModal` is the second
        (refreshes its rows so user input always targets the live store, not
        a phantom row from reconcile-ago).
    - Immutability contract documented in
        [types.ts:46-65](../src/sync/types.ts#L46-L65).
- [x] **(3) `BulkSync.run()` early-return is silent.** Was: a concurrent caller
    got `{0,0,0,…}` synchronously with no signal that nothing actually ran.
    - Done: `BulkSync` now holds a single `inFlight: Promise<SyncPassResult> | null`.
        Concurrent callers receive that Promise and observe the same pass's
        result. `lastPassResult` / `lastPassCompletedAt` / `onPassCompleted` /
        `isRunning` (all added solely to work around the silent-zero bug) were
        removed — `run()` returning a real Promise is the only signal callers
        need.
    - The e2e `runBulkSync` helper collapsed from ~50 lines of fire-and-poll
        to a single `await bulkSync.run()` inside `executeObsidian`. The
        `before:` hook bumps WebDriver's async-script timeout to 120 s
        (matching mocha's per-test timeout) so a slow Drive pass doesn't trip
        the default 30 s cutoff.
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

- [ ] **(A1) Type-hygiene: `Candidate` has sentinel-valued optional sub-shapes.**
    Downgraded from "Architectural" to "type-hygiene cleanup, low priority"
    after (2) landed — the original justification ("removes mutation hazards
    by construction") is moot now that replace-on-write + the documented
    immutability contract enforce the same invariant by policy. The remaining
    motivations are smaller:
    - Deferral sentinels (`deferredAt`, `deferredLocalMtime`,
        `deferredRemoteMtime`) are always present but only meaningful when
        `state === 'Deferred'`. They are `0` on every other state, and the
        auto-revoke check has to know which fields are valid.
    - The four `synced*` fields plus `driveFileId` are similarly sentinel-valued
        on never-synced candidates. The "`syncedAt > 0` means the rest is
        trustworthy" convention is encoded across `decision-engine.ts`,
        `candidate-store.ts`, and `file-syncer.ts` as scattered `wasSynced`
        checks.
    - Ephemeral `local` / `remote` are optional in the type but mandatory in
        most code paths (execute loop, planning, conflict resolution all assume
        reconcile populated them).
    - Fix direction: discriminated union on `state`, so each variant carries
        only the fields valid in that state. Big consumer-side ripple — defer
        until the next time something else has us touching these types
        broadly.
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
