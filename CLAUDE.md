# Vault Share -- share Obsidian vaults through shared folder in Google Drive

An Obsidian community plugin for multi-master sync among multiple Obsidian vaults and a shared folder in cloud storage.

## Commands

```bash
npm install             # Install dependencies
npm run dev             # Development (watch)
npm run build           # Production build (type-check src + wdio tests, then esbuild)
npm test                # vitest (unit tests)
npm run test:watch      # vitest watch
npm run lint            # eslint .
npm run setup:e2e:wdio  # One-time: save GDrive token for e2e tests
npm run test:e2e:single # wdio e2e tests, single vault (excludes *.scale.e2e.ts)
npm run test:e2e:cross  # wdio e2e tests, two vaults (multiremote; excludes *.scale.e2e.ts)
npm run test:e2e:scale  # opt-in large-scale (100s of files) single + cross e2e; slow, live Drive
```

## Architecture

Architecture docs describe general structure and functionality but 
design and implementation documentation resides in TypeDoc comments in source files.

For Architectural overview, see [specs/ARCHITECTURE.md](specs/ARCHITECTURE.md).

Enhancement and feature design specs live in [specs/](specs/).

## Project conventions

General TypeScript, testing and docs conventions come from the user-level `~/.claude/CLAUDE.md` and `~/.claude/rules/typescript.md`. This file holds only what is specific to this project.

- Provide unit tests via vitest; end-to-end tests via wdio (`tests/wdio`) for selected scenarios. Update both when related implementation changes.
- Node 22 or newer (`engines` in `package.json`; e2e verified on 22, 24 and 26; CI runs 22 and the current LTS). Keep `webdriver`/`webdriverio` at ≥ 9.30: older versions send headers Node 26 rejects (`UND_ERR_INVALID_ARG`).
- Try to keep the Obsidan [plugin automated review score](https://community.obsidian.md/plugins/vault-share) in the high 90's.  Make reasonable code changes to accomodate style review comments posted there.

### obsidianmd ESLint plugin
- `eslint-plugin-obsidianmd` is installed and included in `eslint.config.mts` (`obsidianmd.configs.recommended`)
- The community plugin submission bot runs the same plugin to validate PRs — always run `npm run lint` before pushing
- Never hardcode `.obsidian` — use `Vault#configDir`. In tests, assign to a variable and add `// eslint-disable-line obsidianmd/hardcoded-config-path`
- UI text (`.setName()` / `.setDesc()`) must use sentence case. Avoid all-caps abbreviations (e.g. `PDFs`, `MB`)
- Do not disable rules that the obsidianmd plugin disallows (`obsidianmd/no-tfile-tfolder-cast`, `obsidianmd/ui/sentence-case`, `@typescript-eslint/no-explicit-any`, etc.) — fix the code instead

## Coding conventions

- `main.ts` handles lifecycle only; delegate logic to separate modules
- Register listeners via `this.register*` (prevent leaks)
- Mobile compatible (`isDesktopOnly: false`) — no Node/Electron APIs
- Minimize network calls; require explicit disclosure
- Command IDs are immutable once published
- No migration code — on IndexedDB schema changes, cold-start (drop all stores and recreate). Settings schema changes should use sensible defaults for missing fields via `Object.assign({}, DEFAULT_SETTINGS, stored)`

## Checks

Always pass `npm run lint && npm run build && npm test` after making changes.

### Type-safe mocks in tests
- Typed test helpers to use instead of ad-hoc casts:
    - `spyRequestUrl()` — type-safe spy on obsidian's `requestUrl` (lives in `src/fs/googledrive/test-helpers.ts` when that module is created)
    - `mockSettings()` — returns a complete `VaultShareSettings` default (lives in `src/__mocks__/sync-test-helpers.ts` when `VaultShareSettings` is defined)
- Pass `createMockStateStore()` directly (its intersection type satisfies `SyncStateStore`; lives in `src/__mocks__/sync-test-helpers.ts` when `SyncStateStore` is defined)

## Build artifacts

- `main.js`, `manifest.json`, `styles.css` → placed in vault's `.obsidian/plugins/<id>/`. Never commit `node_modules/` or `main.js`.

## Releases

- Update `version` in `manifest.json` (SemVer, no `v` prefix) and `versions.json`. GitHub release tag must match the version exactly.
- enforce semver backward compatibility, but not until project reaches 1.0 release.
- Before changing `minAppVersion`, see [Designing against the API](#designing-against-the-api) — bump only when a feature genuinely needs a newer Obsidian API, not to clear deprecation warnings.

## Obsidian community plugin conventions

See [Sample Plugin README.md](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/README.md) for additional details about Obsidian community plugins

### Designing against the API

- The global "design against the latest API" rule applies with `minAppVersion` as the floor. Check the newest Obsidian release (`npm view obsidian version`, the API typings, release notes) before settling on an approach. Raising `minAppVersion` forces every user onto that Obsidian release, so it is always the user's call.
