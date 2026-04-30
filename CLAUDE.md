# Vault Share -- share Obsidian vaults through shared folder in Google Drive

An Obsidian community plugin for multi-master sync among multiple Obsidian vaults and a shared folder in cloud storage.

## Commands

```bash
npm install             # Install dependencies
npm run dev             # Development (watch)
npm run build           # Production build (tsc -noEmit && esbuild)
npm test                # vitest (unit tests)
npm run test:watch      # vitest watch
npm run lint            # eslint .
npm run setup:e2e:wdio  # One-time: save GDrive token for e2e tests
npm run test:e2e:single # wdio e2e tests, single vault
npm run test:e2e:cross  # wdio e2e tests, two vaults (multiremote)
```

## Architecture

Architecture docs describe general structure and functionality but 
design and implementation documentation resides in TypeDoc comments in source files.

For Architectural overview, see [specs/ARCHITECTURE.md](specs/ARCHITECTURE.md).

Enhancement and feature design specs live in [specs/](specs/).

## Project conventions

- Prefer latest LTS version of all dependencies and tools
- Provide unit tests via vitest.
- Provide end-to-end tests via wdio for selected scenarios.
- Update all affected tests when related implementation changes.  

### obsidianmd ESLint plugin
- `eslint-plugin-obsidianmd` is installed and included in `eslint.config.mts` (`obsidianmd.configs.recommended`)
- The community plugin submission bot runs the same plugin to validate PRs — always run `npm run lint` before pushing
- Never hardcode `.obsidian` — use `Vault#configDir`. In tests, assign to a variable and add `// eslint-disable-line obsidianmd/hardcoded-config-path`
- UI text (`.setName()` / `.setDesc()`) must use sentence case. Avoid all-caps abbreviations (e.g. `PDFs`, `MB`)
- `eslint-disable` directives must include a description explaining why (e.g. `// eslint-disable-next-line rule-name -- reason here`)
- Do not disable rules that the obsidianmd plugin disallows (`obsidianmd/no-tfile-tfolder-cast`, `obsidianmd/ui/sentence-case`, `@typescript-eslint/no-explicit-any`, etc.) — fix the code instead
- Do not write unnecessary type assertions. If `.buffer` is already `ArrayBuffer`, do not cast `as ArrayBuffer`

## Coding conventions

- TypeScript strict mode
- Clean modular structure - favor class-based design.
- Document modules via [TypeDoc](https://typedoc.org/) -- update doc when documented interface changes
- `main.ts` handles lifecycle only; delegate logic to separate modules
- Split files at ~200-300 lines
- Register listeners via `this.register*` (prevent leaks)
- Prefer `async/await`
- Mobile compatible (`isDesktopOnly: false`) — no Node/Electron APIs
- Minimize network calls; require explicit disclosure
- Command IDs are immutable once published
- No migration code — on IndexedDB schema changes, cold-start (drop all stores and recreate). Settings schema changes should use sensible defaults for missing fields via `Object.assign({}, DEFAULT_SETTINGS, stored)`

## Type safety & lint rules

Always pass `npm run lint && npm run build && npm test` after making changes.

### No `any`
- Never use `as any`. Use `as unknown as TargetType` when a cast is unavoidable
- Never use `any` in type definitions. Use `unknown` instead (e.g. `(...args: unknown[]) => void`)
- Never disable `@typescript-eslint/no-explicit-any` — the obsidianmd plugin forbids it
- Type external API responses (`response.json`, etc.) as `const x: unknown = ...` and narrow with a runtime validator (assert function)
- Annotate `JSON.parse()` return values explicitly (`as { key: Type }`)

### Type-safe mocks in tests
- Do not cast `vi.spyOn` targets with `as any`. Use typed helpers instead
    - `spyRequestUrl()` — type-safe spy on obsidian's `requestUrl` (lives in `src/fs/googledrive/test-helpers.ts` when that module is created)
    - `mockSettings()` — returns a complete `VaultShareSettings` default (lives in `src/__mocks__/sync-test-helpers.ts` when `VaultShareSettings` is defined)
- Access private fields via `as unknown as { field: Type }` pattern
- Pass `createMockStateStore()` directly (its intersection type satisfies `SyncStateStore`; lives in `src/__mocks__/sync-test-helpers.ts` when `SyncStateStore` is defined)

### No `async` without `await`
- Never write `async` functions or arrow functions that contain no `await` expression — fix the code, do not disable the lint rule
- Mock functions that only throw: use `() => { throw err; }` (synchronous, no `async`)
- Mock functions with mixed throw/return: ensure at least one `await` (e.g. `return await Promise.resolve(...)`)
- Mock functions that return a value synchronously but must return a Promise: use `() => Promise.resolve(value)` (no `async`)
- Assigning a mock function to a property: same rules apply (e.g. `obj.fn = () => Promise.resolve(value)`, not `async () => value`)

## Build artifacts

- `main.js`, `manifest.json`, `styles.css` → placed in vault's `.obsidian/plugins/<id>/`. Never commit `node_modules/` or `main.js`.

## Releases

- Update `version` in `manifest.json` (SemVer, no `v` prefix) and `versions.json`. GitHub release tag must match the version exactly.
- enforce semver backward compatibility, but not until project reaches 1.0 release.

## Obsidian community plugin conventions

See [Sample Plugin README.md](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/README.md) for additional details about Obsidian community plugins

## Documentation conventions
- All modules documented with TypeDoc comments
- Exported identifies appear in generated documentation, but exported identifiers for tests or exported test helpers are explicitly excluded from generated documentation.

