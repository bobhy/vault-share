# Sync module review — follow-ups

> **TODO:** This file tracks open follow-up items for the sync module. Each
> unchecked entry below is an outstanding work item; a project-wide `grep
> TODO` will surface this file. Mostly sync-module items; item (15) covers
> e2e test infrastructure that the sync review uncovered.

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
- [x] **(4) Dead branch in `classifyStatus`.** The `!wasSynced → 'modified'`
    branch was indeed unreachable — `planAction` short-circuits on `!wasSynced`,
    so `classifyStatus` was only ever called with `wasSynced === true`.
    - Done: removed the dead branch, dropped the `wasSynced` parameter (always
        `true` at call site), removed the `'absent'` variant from `FileStatus`,
        and stripped the now-dead `'absent'` checks from `planAction`'s
        decision table. Added a focused unit test pinning `classifyStatus`'s
        three-outcome contract directly. Net −9 lines, +4 test cases.

## Medium priority

- [x] **(5) O(n) candidate lookup in `singleFileSync`.** Was
    `candidateStore.getAll().find(c => c.path === path)`.
    - Done: added `CandidateStore.get(path): Candidate | undefined` — direct
        `Map.get`, O(1). `singleFileSync` calls it; the returned reference is an
        immutable snapshot per the contract from (2).
- [x] **(6) Keep Both / delete-conflict leaves the original candidate stranded.**
    Was: the conflict resolver returned `newSyncedFiles` with no `syncedState`,
    and `applyFileResult` ignored the original path. The candidate sat in
    conflict state until the *next* reconcile reclassified it as `deleteLocal`
    and yet *another* pass swept it up — meanwhile the UI showed a phantom
    conflict row for a file that no longer existed at the original path.
    - Done: `applyFileResult` infers from the existing fields — when
        `changed && !syncedState && !isDelete(actionType)`, the original path's
        candidate is removed. No new field needed; the inference is the only
        coherent reading of "the action made changes but didn't tell me how to
        record them at this path." Documented as a decision table in the
        method's docstring; covered by a new
        `CandidateStore.applyFileResult` test suite (5 cases).
- [x] **(7) Threshold semantics were correct in intent but mis-labelled and
    mis-scoped at the edges.** Resolved by realigning the name, the
    surrounding text, the denominator, and the empty-vault guard with the
    actual intent ("any global change to either vault"), and adding a
    one-shot migration so existing users don't lose their tuned values:
    - **Rename:** `fileModificationConfirmation{Threshold,Min}` →
        `globalChange{Threshold,Min}` in [settings.ts](../src/settings.ts).
        The old name leaned local-modification; the new name describes what
        it actually counts.
    - **One-shot settings migration** added to
        [main.ts onload](../src/main.ts#L49) — when loading `data.json`, if
        the old keys are present, their values are copied across to the new
        keys, the old keys are deleted, and the cleaned-up shape is saved
        back so the migration only runs once per install. This is a
        deliberate exception to the project "no migration code" convention
        for settings; without it every existing user would silently revert
        to defaults.
    - **Denominator** in [bulk-sync.ts](../src/sync/bulk-sync.ts) changed
        from `localFiles.length` to the union of local + remote paths
        (each path counted once). This is closer to "% of all known files"
        than "% of files on this side."
    - **Empty-vault guard** added: the threshold check is skipped when
        *either* side is empty — covers fresh install joining a populated
        group vault (empty local; user shouldn't be ambushed with a "100
        global changes deferred" notice on first sync) and recovery from
        an accidental Drive-folder wipe (empty remote; nothing to
        protect).
    - **User-visible wording** unified to "global change(s)" — both the
        notice popup in [main.ts](../src/main.ts) and the status-bar
        message in [bulk-sync.ts](../src/sync/bulk-sync.ts). The notice
        previously said "conflicts" which was actively misleading (the
        threshold defers pushes/pulls/conflicts/remote-deletes
        indiscriminately).
    - **Updated JSDoc** on both settings fields describes the new
        numerator/denominator and the empty-vault guard so a user
        hand-editing `data.json` sees the actual semantics.
    - **Tests:** rewrote the two existing threshold tests to use the new
        names + the new union semantics, added two new tests for the
        empty-local and empty-remote guards (fresh-install and
        Drive-wipe scenarios), extended the test harness to optionally
        populate remote-file paths. All assertions on the e2e side use
        `setThreshold(min, threshold)` so just the helper internal got
        renamed.
    - **Follow-up resolved (deleteLocal):** the `deleteLocal` exclusion
        in the numerator was asymmetric — remote-side deletions counted
        but local-side ones didn't. Under the global-changes framing both
        are equally significant (a remote peer mass-deleting most of the
        vault should trip the guard). The filter was removed so all
        pending action types contribute to `globalChangeCount`. JSDoc on
        `globalChangeThreshold` and the inline comment in bulk-sync.ts
        updated accordingly; a new unit test confirms a
        `deleteLocal`-heavy pending list triggers `deferAllAndPause`.
    - **Follow-up resolved (Drive-wipe vs fresh-install):** the
        empty-remote guard previously skipped the check unconditionally.
        Refined to distinguish the two cases via `hasSyncHistory()`: no
        history → fresh install, skip as before; history present → remote
        being empty signals an accidental Drive-folder wipe, so the guard
        runs (ratio ≈ 100 % → fires, user asked to confirm before
        re-uploading). Two new unit tests cover both branches.
- [ ] **(8) Pull records pre-pull `remoteMtime`.**
    [file-syncer.ts:60-75](../src/sync/file-syncer.ts#L60-L75) uses
    `candidate.remote` (from reconcile, possibly stale) for `remoteMtime` /
    `remoteSize` in `syncedState`. Compare to the `conflict` branch which
    re-stats Drive ([file-syncer.ts:103](../src/sync/file-syncer.ts#L103)).
    - Fix: re-stat Drive after a pull so the persisted record matches Drive's
        current mtime.
- [x] **(18) Default `excludeRules` pushed plugin internals to Drive and
    didn't protect against `.trash` mode.** Two related problems in the
    same setting:
    - The `!.obsidian/plugins/vault-share` re-include meant the plugin's own
        `main.js` / `manifest.json` / `styles.css` *and* `data.json` were
        pushed to Drive on every sync. `data.json` is per-device state
        (driveFolderPath, OAuth-derived fields), and propagating it across
        peers is a correctness/security footgun. Build artifacts likewise
        should not cross between installs.
    - No `.trash` exclusion meant a user who picked Obsidian's "Move to
        .trash folder" deletion mode would silently re-push every deleted
        file to Drive (and pull it back into peer vaults' `.trash/`) as if
        it were new content.
    - Done: defaults are now `['.obsidian', '.trash']` — no re-include for
        the plugin folder, and `.trash` excluded for the in-vault trash mode.
        Documented inline at
        [settings.ts:43-54](../src/settings.ts#L43-L54). All 18/18 single +
        12/12 cross e2e tests still pass; no fixture depended on the plugin
        re-include.
    - **Migration note:** per project convention, no migration code was
        written. Existing users keep their stored `excludeRules` (which
        contain the old defaults) until they manually edit or reset. A
        release note for upgraders should suggest replacing
        `!.obsidian/plugins/vault-share` with `.trash` in their settings.
- [x] **(14) `resolveDeleteConflict` boomerang — fixed under "modifier-wins"
    semantics.** Was: the resolver only created a placeholder; the surviving
    side was left untouched, so the next reconcile saw it as a brand-new
    no-history push or pull and effectively reverted the user's delete.
    - Done: both branches of `resolveDeleteConflict` now also propagate the
        surviving side to the missing side at the original path (pull
        remote→local when local was deleted; push local→Drive when remote
        was deleted), and signal `restoredOriginal: true` so file-syncer's
        conflict case builds a `syncedState` for the now-coherent original
        AND inserts the placeholder via `newSyncedFiles`. Both vaults
        converge on the same end state in this same sync, no boomerang.
    - Semantic chosen: **modifier wins**. The principle "vault-share never
        silently loses user-modified data" outweighed honoring the explicit
        delete action; the deleter sees a placeholder making the deletion
        intent visible, and can re-delete from there if desired.
    - Tests: the two cross-suite tests
        [tests/wdio/cross/sync.e2e.ts](../tests/wdio/cross/sync.e2e.ts) that
        previously pinned the partial behaviour now assert the new outcome
        on both vaults *plus* a stability check (a second sync round on
        either side is a no-op — same content, no new placeholders).
- [x] **(17) `pluginReset` (and fresh-install joining an established vault)
    reclassified every dual-existence file as `conflict`.** Was: after
    `pluginReset` cleared the candidate cache, the next reconcile's
    no-history path classified every file present on both sides as
    `'conflict'` (since the path uses presence alone). Under default
    settings this meant text files got a no-op diff3 round-trip with empty
    base, and binary attachments got duplicated via Keep Both — a small
    vault (< `fileModificationConfirmationMin` files) with binary
    attachments could silently double its image count just from clicking
    "Reset plugin."
    - Done: `planAction`'s no-history branch now treats `local && remote
        && local.size === remote.size` as `'noOp'`, and `reconcile`'s
        new-candidate branch creates a Synced candidate at the current
        mtime/size for that case (instead of skipping). Future reconciles
        compare against those values and classify subsequent edits
        correctly, so a one-sided change after the rebaseline produces a
        push/pull rather than a fresh-history conflict.
    - **Signal trade-off:** size-only, not mtime-or-content. Drive's
        `modifiedTime` is the upload time (not the file's original mtime),
        so mtime equality almost never fires for genuinely-identical files
        and would defeat the rebaseline. Content equality would be
        definitive but requires reading every file. Size is a
        low-false-positive proxy because edits virtually always change byte
        count; the known false-positive window is "two unrelated files at
        the same path that coincidentally have the same byte size,"
        unusual in practice.
    - **Phase 2 (sha256 upgrade) is now complete** — see the Phase 2 entry in
        the "Completed items" section below. The plan at
        [specs/timestamp-conflict-improvements.md](timestamp-conflict-improvements.md)
        is fully implemented. The size-only rebaseline remains as the initial
        heuristic; sha256 verification runs as a post-reconcile correction pass
        and also short-circuits with-history identical-content conflicts at Site 3.
    - Tests: two new tests in `decision-engine.test.ts` cover the size-match
        rebaseline and the size-mismatch conflict cases (plus the
        no-shared-history variants). Three new tests in
        `candidate-store.test.ts` cover the reconcile-creates-Synced
        rebaseline, the reconcile-creates-Default-conflict size-mismatch
        case, and the regression "subsequent edit after rebaseline
        correctly classifies as push." One single-vault e2e fixture
        (`manual-sharing-control.e2e.ts`'s conflict setup) needed its
        templates updated to use visibly-different sizes — the previous
        `'local version — '` / `'drive version — '` templates were
        coincidentally byte-identical (18 bytes UTF-8 each), which would
        now rebaseline-as-Synced and skip the threshold scenario; comment
        added inline explaining the load-bearing nature of the size
        difference.
- [x] **(16) Approved candidate referring to a now-missing file blocked the
    whole queue.** Was: `executeApproved`'s loop was wrapped in a single
    try/catch, so the first throw stranded every subsequent approved
    candidate, *and* the dead candidate stayed in `Approved` state forever
    — next pass re-threw on the same file and blocked the queue again. The
    same shape applied to `doRun`'s pending loop.
    - Done: extracted a shared per-candidate helper
        `BulkSync.syncAndApply()` with a *per-candidate* try/catch — one
        failing file no longer aborts the rest of the queue. Both
        `doRun` and `executeApproved` route through it.
        - **Cancel policy:** `Local file not found:` errors (the
            `LocalFs.getFileOrThrow` signal that the user deleted the file
            between planning and execution) trigger
            `candidateStore.remove(path)`. The user's explicit delete is
            honoured; the candidate cannot re-stick on future passes.
        - **Retry policy:** all other errors (Drive transient failures, IDB
            issues, etc.) are logged at `error` level and the candidate is
            left in place for the next pass to retry. `SyncPassResult` gained
            a `failed: number` counter so callers can see partial-failure
            outcomes without inspecting logs; `error` stays unset for
            per-candidate failures (it remains the *pass-wide* signal —
            listAll failure, IDB transaction crash, etc.).
    - Three new unit tests in `bulk-sync.test.ts` pin: (a) the cancel-on-
        missing-local case (approved queue with `gone` candidate in the
        middle of two healthy ones — both healthy execute, gone is removed,
        `failed === 1`), (b) the retry-on-other-error case (Drive 503 →
        candidate kept for retry, `remove` not called), (c) the same
        isolation applies to non-approved pending candidates.
    - **Drive-side symmetry left as a follow-up:** a pull failing because
        the Drive file is now gone (`GDriveError` with 404) is the
        symmetric case. The distinguishing logic would need to live in
        `GDriveApi` (typed error code) or the helper would have to string-
        match Drive errors. Not in scope for this fix; will revisit if it
        ever shows up in a real-world report.

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
- [ ] **(13) Stop duplicating `CandidateStore` behaviour in test mocks.**
    [bulk-sync.test.ts](../src/sync/bulk-sync.test.ts) and
    [resolution-executor.test.ts](../src/sync/resolution-executor.test.ts) each
    carry a private hand-written `applyFileResult` that mirrors the production
    body, plus spy slots for `markSynced` / `remove` / `insertSynced` etc.
    Items (2), (6), and any future change to `CandidateStore` semantics force
    parallel edits in both mocks — exactly the bug class DRY work is meant to
    prevent. Both mocks have already been silently desynced once during this
    work.
    - Fix: convert both test files to instantiate a real `CandidateStore`
        against `fake-indexeddb` (the pattern
        [candidate-store.test.ts](../src/sync/candidate-store.test.ts) already
        uses via `makeStore()`). Spies, where needed, can wrap real methods via
        `vi.spyOn` so call-shape assertions still work.
    - Why it matters now: a fourth touch of `applyFileResult` semantics is
        likely (items (1) and (A1) both circle back through these tests), and
        each round the mock stays correct is a coin flip.
- [ ] **(15) (e2e infrastructure) Errors silently degrade to `[object Object]`
    when crossing the executeObsidian boundary.** `Error` objects have
    non-enumerable `message` / `stack`, so when something inside an
    `executeObsidian` callback returns or throws an Error, WebDriver's JSON
    serialization on the way back to Node strips it to `{}`. The receiving
    Node code then sees `result.error = {}`, evaluates it as truthy, and
    typically `String()`s it to `[object Object]` — masking the real cause.
    Fixed for `runBulkSync` in
    [wdio.conf.mts](../wdio.conf.mts) by stringifying inside the callback,
    but the same trap will catch any future helper that returns or rethrows
    an Error from inside an executeObsidian callback.
    - Fix direction: factor a small helper (perhaps
        `safeExecuteObsidian(fn)`) that wraps the callback, catches inside,
        converts errors to plain `{ message, stack }`, and rethrows on the
        Node side with the real message. Use it in place of bare
        `executeObsidian` in any code path that can fail meaningfully.
    - Lower priority because it's a known footgun now, but worth a cheap
        helper before the third "what does `[object Object]` mean here" debug
        session.

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

## Documentation follow-ups

- [ ] **(D1) Audit and tag every spec as Living / Historical / Future, and add a
    doc map.** [specs/sync-model.md](sync-model.md) and
    [specs/testing-e2e.md](testing-e2e.md) were added (June 2026) as the first
    *Living* references, each carrying a `> Status: Living` banner. The remaining
    specs in [specs/](.) are organised as feature-history narratives and are
    *unmarked*, so a cold reader cannot tell which describe the current design
    versus a since-superseded proposal. Do this later:
    1. Add a one-line `> Status: Living | Historical (as of <date>) | Future`
       banner to the top of every spec. (`future-directions.md` already
       self-identifies as a scratchpad — make it `Future` and keep the
       "agents ignore" note.)
    2. Add a short **reading-order doc map** — likely a "Where to start reading"
       block in [CLAUDE.md](../CLAUDE.md) and/or an index table in
       [ARCHITECTURE.md](ARCHITECTURE.md) — that points new readers at the Living
       docs first (sync-model.md for the engine) and labels the rest.
    3. Keep `ARCHITECTURE.md` vision-level; route conceptual sync detail to
       `sync-model.md` rather than growing ARCHITECTURE.

## Status

Started: 2026-05-29. Issues identified during review of [src/sync/](../src/sync/)
following the e2e test rescue session.

Completed so far:

- **DRY pass** (items 1, A2, A3): planAction/classifyStatus deduplicated;
    apply-sync-result-to-store helper unified across bulk-sync, resolution-
    executor, and single-file-sync.
- **Mutation hazards** (item 2): CandidateStore is replace-on-write; the
    `Candidate` immutability contract is documented in `types.ts`; the
    single-slot `onChanged` was widened to multi-listener `onChange(fn):
    unsubscribe`; PendingListModal subscribes and re-renders so user actions
    no longer race against reconcile.
- **`BulkSync.run()` coalescing** (item 3): `run()` returns the in-flight
    Promise on concurrent calls instead of a misleading zero. The four
    workaround fields (`lastPassResult`, `lastPassCompletedAt`, `isRunning`,
    `onPassCompleted`) are gone, and the e2e `runBulkSync` helper collapsed
    from fire-and-poll to a single `await`.
- **Hygiene cluster** (items 4, 5, 6): dead `classifyStatus` branch and
    `'absent'` variant removed; `CandidateStore.get(path)` exposed for O(1)
    lookups; `applyFileResult` infers "original is gone" from `changed &&
    !syncedState && !isDelete` so Keep Both / delete-conflict no longer
    strand the original candidate.
- **Default `excludeRules` fix** (item 18): removed the
    `!.obsidian/plugins/vault-share` re-include (plugin internals + per-device
    `data.json` no longer cross the boundary) and added `.trash` to the
    default exclude list (in-vault trash mode no longer pushes deleted files
    to peers). Existing users keep their stored excludes; new users get the
    safer defaults.
- **Modify-delete conflict — modifier wins** (item 14): `resolveDeleteConflict`
    now restores the surviving side on the missing side (pull remote→local
    when local was deleted; push local→Drive when remote was deleted) and
    signals `restoredOriginal: true` so file-syncer builds a `syncedState`
    for the original path *and* inserts the placeholder. End state is stable
    in one sync round on each vault — the previous "next reconcile re-pushes
    the file" boomerang is gone. Two cross tests now assert the new outcome
    *and* a no-op stability round on both sides.
- **Threshold semantics + name** (item 7): renamed
    `fileModificationConfirmation{Threshold,Min}` to `globalChange{Threshold,Min}`
    with a one-shot data.json migration; denominator now counts the union of
    local + Drive paths; check skipped when either side is empty (fresh
    install or Drive-wipe); notice popup and status-bar wording unified to
    "global change(s)" (the popup previously said "conflicts" which was
    misleading — pulls and pushes were counted too).
- **`pluginReset` rebaseline + sha256 identity comparison** (item 17 / Phase 2):
    - Phase 1 (rebaseline): `planAction`'s no-history path treats `(both sides
      present) && (sizes match)` as `noOp`, and `reconcile` creates a Synced
      candidate for that case instead of skipping.
    - Phase 2 (sha256 upgrade, now complete): Full sha256-based identity
      comparison as designed in
      [specs/timestamp-conflict-improvements.md](timestamp-conflict-improvements.md),
      implemented at two sites:
        - **Site 1** (no-history rebaseline verification): `BulkSync.doRun`
          loops over the set of paths newly rebaselined by size-equality,
          computes `sha256Hex` for each, and calls `CandidateStore.rebaselineAsConflict`
          on any path where the local hash doesn't match `DriveFileSide.sha256Checksum`.
          `reconcile` now returns `Promise<string[]>` (the rebaselined paths).
        - **Site 3** (with-history identical-content conflict short-circuit):
          `syncOneFile` computes local sha256 before calling `resolveConflict`
          when sizes match and `sha256Checksum` is present on the remote side.
          A match updates the sync record without any file writes and returns
          `identicalContent: true`. `SyncPassResult` gained `identicalTimestamps`
          counted separately from `conflicts`.
      Graceful degradation: sha256 absent (pre-2022 Drive files) → falls back
      to size-only behaviour with no error. New `src/sync/content-hash.ts` uses
      `crypto.subtle` (mobile-safe, no Node dependency).
    - New unit tests: `content-hash.test.ts` (5 tests), Site 1 in
      `bulk-sync.test.ts` (3 tests), Site 3 in `file-syncer.test.ts` (4 tests),
      sha256Checksum threading in `drive-fs.test.ts` (2 tests).
    - New e2e tests in `tests/wdio/cross/sync.e2e.ts`: Drive returns 64-char
      sha256 on pushed files; identical independent edits resolve as
      `identicalTimestamps` with no conflict markers.
- **Per-candidate failure isolation** (item 16): `BulkSync` no longer aborts
    its whole queue when one file's sync throws. A shared
    `syncAndApply()` helper wraps each candidate in its own try/catch;
    `Local file not found:` errors (user deleted the file between planning
    and execution) cancel the candidate via `candidateStore.remove(path)`,
    other errors are logged and the candidate is left to retry next pass.
    `SyncPassResult` gained a `failed: number` counter for partial-failure
    visibility. Three unit tests pin the cancel-on-missing-local, the
    retry-on-other-error, and the same isolation for non-approved pending
    candidates.
- **Cross-vault e2e** (item 7-equivalent, not a numbered item): cross suite
    expanded from 3 tests (17 s) to 12 tests (67 s) covering delete
    propagation both directions, modify-delete conflict both directions (with
    item 14's partial behaviour pinned), non-overlapping diff3 merge,
    concurrent independent creates, subfolder hierarchy, pause-and-resume,
    and user-approved-cross-propagation. Writing the suite uncovered two real
    production bugs that are *also* fixed in this pass:
    - `file-syncer.ts` conflict-case `resolvedInPlace` was using
        `localConflictPath`/`remoteConflictPath` (Keep-Both-only) instead of
        `newSyncedFiles?.length` (the unambiguous signal). Delete-conflict
        was therefore mis-classified as "in place," causing
        `localFs.read(candidate.path)` to throw on the just-deleted original.
    - The `executeMerge` unit test had been passing only because of that
        same `resolvedInPlace` bug; its candidate had no `local` ephemeral,
        so it was actually exercising delete-conflict rather than merge.
        Updated `makeCandidate` to take a `{ local: true }` opt; the test
        now constructs a real merge-shaped candidate.

Test counts: 428/428 unit tests pass; 18/18 single-vault e2e in ~37 s;
14/14 cross-vault e2e in ~75 s; lint clean.

Open: item 8 (pull pre-pull mtime), 9 (drive walker ignores excludes),
10 (`isPaused` dead async), 11 (lastPass invariant test), 12
(scheduler.fileStates retention comment), 13 (test mocks), A1 (Candidate
type hygiene).
