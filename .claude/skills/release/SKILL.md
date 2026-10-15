---
name: release
description: Cut and publish a vault-share plugin release — version bump, changelog stamp, CI and e2e gates, tag and GitHub release with assets. Run only when the user invokes /release.
argument-hint: "[patch | minor | major | <x.y.z>]  (default: patch)"
disable-model-invocation: true
---

# release

Publish the next version of the vault-share Obsidian plugin from `main`.

## Who runs what

Claude does the checks, the file edits and the waiting. The **user** runs the four write steps marked 🔒 — commit, push, tag, publish — because their permission settings block Claude from them, and because each one reaches GitHub (and, for publish, every user of the plugin) and can't be quietly undone.

At each 🔒 step, give the user **exactly one short command** to run with `!`, and explain in a sentence what it does. The `!` prompt runs zsh, not the user's fish, so the command must be shell-neutral: no `&&`, `; and`, pipes, redirects or quoting tricks, and short enough not to wrap when pasted (two earlier wrapped pastes broke the 1.0.7 release). The commands below meet that bar; don't improvise longer ones. `step.mjs` re-checks its own preconditions, so a mistaken order fails safely.

Stop and report at the first failure. Don't work around a failing check, and never rewrite pushed history (no force-push, no amending a pushed commit, no deleting a published tag) — fix forward with a new commit and re-run `/release`.

Scripts (run from the repo root):
- `node .claude/skills/release/scripts/changelog.mjs check | stamp <ver> | notes <ver>` — Claude uses this.
- `.claude/skills/release/scripts/step.mjs commit | tag | publish <ver>` — the user runs this.

## 1. Preflight

Run these and stop if any fails, saying what to fix:

- On branch `main`, working tree clean (`git status --porcelain` empty).
- Up to date with GitHub: `git fetch origin`, then `HEAD` equals `origin/main`.
- `gh auth status` succeeds.
- `node .claude/skills/release/scripts/changelog.mjs check` succeeds — a release with an empty `[unreleased]` section has nothing to tell users.
- The latest CI run for `HEAD` (`gh run list --commit <sha> --workflow CI`) is not failing. Still running, or never run, is fine; step 4 covers the release commit.

## 2. Choose the version and confirm the plan

- Current version: `version` in `manifest.json`.
- Next version, from the skill's argument: patch (the default when none is given), minor, major, or an explicit x.y.z. SemVer with no `v` prefix: Obsidian matches the GitHub release tag against `manifest.json`'s version exactly.
- The tag must not already exist (`git tag -l <ver>` empty, `gh release view <ver>` fails).

Show the user: current → next version, and the `[unreleased]` notes. Point out anything odd in the notes (e.g. wording that overstates a change, or user-facing items under a "no user-facing changes" line). Get a yes before changing files.

## 3. Prepare the release commit

1. `npm run lint`, `npm run build`, `npm test` — check each exit status itself, not a piped `tail`.
2. `npm version <next> --no-git-tag-version`. This updates `package.json` and `package-lock.json` and runs the repo's `version` script, which writes `manifest.json` and `versions.json` (and `git add`s those two). `--no-git-tag-version` matters: npm's configured default would create a `v<ver>` tag, the wrong format here.
3. `node .claude/skills/release/scripts/changelog.mjs stamp <next>`.
4. Verify: `manifest.json` version is `<next>` with `minAppVersion` unchanged; `versions.json` has `"<next>": "<minAppVersion>"`; `package.json` and `package-lock.json` both say `<next>`; `CHANGES.md` has `## [<next>]` and no `## [unreleased]`. Leave `minAppVersion` alone — raising it is a separate decision (see `CLAUDE.md`, "Designing against the API").
5. 🔒 Show `git diff HEAD --stat` (exactly those five files), then have the user run:
   ```
   ! .claude/skills/release/scripts/step.mjs commit <next>
   ```
   It refuses if anything outside the five release files is changed, then commits them as `release v<next>`.

## 4. Push, then run CI and e2e together

1. 🔒 Have the user run:
   ```
   ! git push origin main
   ```
2. CI starts on the push. Find its run for the release commit (`gh run list --commit <sha> --workflow CI`; it can take a few seconds to appear) and wait in the background with `gh run watch <id> --exit-status`. It runs lint, build and unit tests on Node 22 and the current LTS.
3. **At the same time**, run the e2e suites locally on the release commit, in the background: `npm run test:e2e:single`, `npm run test:e2e:cross`, `npm run test:e2e:ui` (each builds first; capture each exit status and the `Spec Files:` line into a log in the scratchpad). Use the newest Node available (`/usr/bin/node` is Node 26 on this machine; prefix `PATH=/usr/bin:$PATH`), since that's the version most likely to surface new breakage — CI covers Node 22 for the unit tests.

   Why local: the GitHub **E2E tests** workflow has never passed — `tests/vaults/primary` and `tests/vaults/peer` are empty directories, which git doesn't track, so the CI checkout has no test vaults. Until that's fixed, local e2e is the only real gate. Don't trigger the GitHub e2e workflow as part of a release unless the user says it has been fixed.
4. If either fails, stop. The release commit is on `main` but untagged, which is harmless. Report the failing job (`gh run view <id> --log-failed`) or the failing spec. A flaky-looking live-Drive failure (rate limiting, `uploaded >= 2` received 0) is worth one re-run of that suite — say that you're doing it.

## 5. Tag and publish

1. The e2e runs in step 4 rebuilt `main.js` from the release commit. Confirm `git status --porcelain` is empty and `HEAD` is still the release commit; if anything else ran in between, `npm run build` again.
2. 🔒 Have the user run:
   ```
   ! .claude/skills/release/scripts/step.mjs tag <next>
   ```
   It checks HEAD is the pushed `release v<next>` commit, then creates the lightweight tag `<next>` (no `v`) and pushes it.
3. 🔒 Have the user run:
   ```
   ! .claude/skills/release/scripts/step.mjs publish <next>
   ```
   It checks the tag is on GitHub and all three assets exist, then creates the release with `main.js`, `manifest.json` and `styles.css` attached and the `[<next>]` changelog section as notes, in one call — so the release is never public without its assets.

## 6. Verify and report

- `gh release view <next> --json assets,body`: assets are exactly `main.js`, `manifest.json`, `styles.css`, and the body is the changelog section (not empty).
- Asset digests match the local files: compare the `digest` fields with `sha256sum main.js manifest.json styles.css`.
- **Attest release artifacts** starts automatically on publish. Wait for it (`gh run list --workflow attest-release.yml --limit 1`, then `gh run watch <id> --exit-status`), then run `gh attestation verify <file> --repo bobhy/vault-share` for each of the three assets. If any fails to verify — e.g. an asset was added after publishing, so the workflow only saw some of them — re-run it with `gh run rerun <id>` and verify again.
- Report: version, release URL, CI and local e2e results (with run links and log paths), attestation status, and anything skipped or re-run.
