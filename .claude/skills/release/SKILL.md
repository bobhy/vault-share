---
name: release
description: Cut and publish a vault-share plugin release — version bump, changelog stamp, CI and e2e gates, tag and GitHub release with assets. Run only when the user invokes /release.
argument-hint: "[patch | minor | major | <x.y.z>]  (default: patch)"
disable-model-invocation: true
---

# release

Publish the next version of the vault-share Obsidian plugin from `main`.

Invoking `/release` is the user's go-ahead for **this one release** to do the git and GitHub writes that are normally theirs alone (commit, push, tag, publish). Still **stop and ask before each write step** marked 🔒 below, showing exactly what will run. A release reaches every user of the plugin and the tag can't be quietly taken back, so each irreversible step gets its own yes.

Stop and report at the first failure. Don't work around a failing check, and never rewrite pushed history (no force-push, no amending a pushed commit, no deleting a published tag) — fix forward with a new commit and re-run `/release`.

`CHANGELOG` helper: `node .claude/skills/release/scripts/changelog.mjs check | stamp <ver> | notes <ver>` (run from the repo root).

## 1. Preflight

Run these and stop if any fails, saying what to fix:

- On branch `main`, working tree clean (`git status --porcelain` empty).
- Up to date with GitHub: `git fetch origin`, then `HEAD` equals `origin/main`.
- `gh auth status` succeeds.
- `node .claude/skills/release/scripts/changelog.mjs check` succeeds — a release with an empty `[unreleased]` section has nothing to tell users.
- The latest CI run for `HEAD` (`gh run list --commit $(git rev-parse HEAD) --workflow CI`) is not failing. If CI never ran for `HEAD`, that's fine; step 4 covers it.

## 2. Choose the version and confirm the plan

- Current version: `version` in `manifest.json`.
- Next version: from `$ARGUMENTS` — `patch` (default), `minor`, `major`, or an explicit `x.y.z`. SemVer, no `v` prefix: Obsidian matches the GitHub release tag against `manifest.json`'s version exactly.
- The tag must not already exist (`git tag -l <ver>`, `gh release view <ver>` fails).

Show the user: current → next version, and the `[unreleased]` notes from the check above. Point out anything odd in the notes (e.g. entries that sound user-facing under a "no user-facing changes" line). Get a yes before changing files.

## 3. Prepare the release commit

1. `npm run lint && npm run build && npm test` — check the exit status itself, not a piped `tail`.
2. `npm version <next> --no-git-tag-version`. This updates `package.json` and `package-lock.json` and runs the repo's `version` script, which writes `manifest.json` and `versions.json` (and `git add`s those two). `--no-git-tag-version` matters: npm's default would create a `v<ver>` tag, which is the wrong format here.
3. `node .claude/skills/release/scripts/changelog.mjs stamp <next>`.
4. Verify: `manifest.json` version is `<next>` with `minAppVersion` unchanged; `versions.json` has `"<next>": "<minAppVersion>"`; `package.json` and `package-lock.json` both say `<next>`; `CHANGES.md` now has `## [<next>]` and no `## [unreleased]`. Leave `minAppVersion` alone — raising it is a separate decision (see `CLAUDE.md`, "Designing against the API").
5. 🔒 Show `git diff --stat` and confirm, then commit those five files with the message `release v<next>` (matching earlier releases).

## 4. Push and wait for CI

1. 🔒 Confirm, then `git push origin main`.
2. Find the CI run for the release commit (`gh run list --commit <sha> --workflow CI`; it can take a few seconds to appear) and wait for it in the background with `gh run watch <id> --exit-status`. CI runs lint, build and unit tests on Node 22 and the current LTS.
3. If CI fails, stop: the release commit is on `main` but untagged, which is harmless. Report the failing job (`gh run view <id> --log-failed`).

## 5. Run the e2e tests

E2e is manual-only (`workflow_dispatch`), so nothing runs it on push — this step is the only e2e gate a release gets.

1. `gh workflow run e2e.yml --ref main`, then find its run id (`gh run list --workflow e2e.yml --limit 1`, check its `headSha` is the release commit).
2. Wait in the background with `gh run watch <id> --exit-status`. The matrix runs Node 22 then the current LTS one after the other (they share a live Google Drive test folder), so expect several minutes.
3. On failure, stop and report as in step 4. A flaky-looking Drive failure (rate limiting, `uploaded >= 2` received 0) is worth one re-run with `gh run rerun <id> --failed` — say that you're doing it.

## 6. Tag and publish

1. Build the release assets from the release commit: `npm run build` (produces `main.js`; `manifest.json` and `styles.css` are tracked). Confirm `git status --porcelain` is still empty — a dirty tree means the assets might not match the tag.
2. 🔒 Confirm, then create and push the tag: `git tag <next>` then `git push origin <next>` (lightweight tag, no `v`, like earlier releases).
3. 🔒 Confirm, then publish:
   ```
   node .claude/skills/release/scripts/changelog.mjs notes <next> > <scratch>/notes.md
   gh release create <next> main.js manifest.json styles.css --title <next> --notes-file <scratch>/notes.md --verify-tag
   ```
   Use the session's scratchpad for `notes.md`, not the repo.

## 7. Verify and report

- `gh release view <next> --json assets` lists `main.js`, `manifest.json`, `styles.css`.
- The **Attest release artifacts** workflow starts automatically on publish; wait for it (`gh run list --workflow attest-release.yml --limit 1`, then `gh run watch`). It adds build-provenance attestations for the three assets.
- Report: version, release URL, CI / e2e / attest results with run links, and anything skipped or re-run.
