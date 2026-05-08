# diagnose

Add targeted diagnostic instrumentation to the code identified in $ARGUMENTS (or the current area of investigation if no argument given), run the relevant test or command, capture the output, then remove the instrumentation.

## Steps

1. **Identify the black box.** Based on $ARGUMENTS and the current investigation context, determine which function or code path is producing unexpected behavior without surfacing enough information. State the hypothesis being tested in one sentence.

2. **Add minimal instrumentation.** Insert `console.log` or `console.error` statements at the critical decision points — typically: inputs to the suspect function, branch conditions, early-return guards, and caught-but-swallowed errors. Keep each log line prefixed with `[diagnose]` so output is easy to grep. Do not restructure or refactor the code; only add logging.

3. **Run the relevant command.** Based on context, run whichever of these fits:
   - Unit tests: `npm test 2>&1 | tail -40`
   - E2E single-vault: `npm run test:e2e:single 2>&1 | tail -60`
   - E2E cross-vault: `npm run test:e2e:cross 2>&1 | tail -80`
   - Lint/build check: `npm run lint 2>&1 && npm run build 2>&1 | tail -20`
   - Or any other command that exercises the suspect path.

4. **Extract the signal.** Grep or filter the output for `[diagnose]` lines plus any ERROR/WARN lines. Report what the instrumentation revealed: which branch was taken, what values were present, where the path diverged from expectation.

5. **Remove the instrumentation.** Revert every `[diagnose]` log line added in step 2. Confirm the build still passes after removal.

6. **Report findings.** State in 2–3 sentences: what the diagnostic proved or disproved, what the likely root cause is, and what the next step should be.
