# remember-debug

Record the current debugging investigation state to a scratch file so findings are not re-derived on each turn. If $ARGUMENTS is provided, use it as a note to append. If no argument, summarize the current state from conversation context.

## Steps

1. **Locate or create the scratch file** at `.claude/debug-notes.md` in the project root. If it does not exist, create it with today's date as a heading.

2. **Summarize the current investigation.** Write or append a section with:
   - **Symptom**: the observable failure (error message, wrong value, test name)
   - **Hypotheses tested**: what was ruled out and why (one line each)
   - **Current hypothesis**: the most likely cause based on evidence so far
   - **Evidence**: specific file:line references, log output, or values that support the hypothesis
   - **Next step**: the concrete action to take next (a specific code change, a `/diagnose` call, a question to answer)
   - **Blocked on**: anything waiting for external input (test run, user clarification)

3. **Note the argument.** If $ARGUMENTS was provided, append it as a freeform note under the current investigation section.

4. **Keep entries terse.** Each field should be 1–2 lines maximum. The goal is a fast reload, not a narrative.

5. **Confirm.** Report back: "Debug state saved to .claude/debug-notes.md — [one-line summary of what was recorded]."

## Format example

```markdown
## 2026-05-08 — cross-vault sync failures

**Symptom**: `runBulkSync(peer)` returns `{ downloaded: 0 }` after primary uploads a file.

**Ruled out**:
- `driveFolderId` is set correctly (injectAndConfigure succeeds)
- `planWithoutHistory` returns `pull` for remote-only files
- `executeObsidian` polyfill works (injectAndConfigure runs without error)

**Current hypothesis**: `bulkSync.run()` catches auth errors silently; access token may expire or not transfer between executeObsidian calls.

**Evidence**: `bulk-sync.ts:43` — catch block sets `result.error` but does not throw; test never checks `result.error`.

**Next step**: Run `/diagnose` on `BulkSync.run()` to surface the caught error.

**Blocked on**: next test run.
```
