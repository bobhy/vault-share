# E2E test infrastructure — the living reference

> **Status: Living.** Authoritative orientation for the wdio end-to-end tests.
> Read this before adding or editing anything under [`tests/wdio/`](../tests/wdio/)
> or the two `wdio.*.conf.mts` files. It describes the moving parts, the shared
> helper toolbox, the lifecycle, and the non-obvious constraints that bite every
> newcomer. Unit tests (vitest) are not covered here — they need no orientation
> beyond the source.

## Prerequisites

- **Node 22.** The system default (Node 26) fails the wdio run with
  `UND_ERR_INVALID_ARG`. Prefix every e2e command with the Node 22 path:
  `PATH="/home/bobhy/.local/share/nvm/v22.19.0/bin:$PATH"`.
- **A saved Google Drive refresh token.** One-time: `npm run setup:e2e:wdio`
  writes `.e2e-refresh-token`. Alternatively set `VAULT_SHARE_REFRESH_TOKEN`.
  The tests hit *live* Drive — they are not mocked.

## Two modes

| | **Single-vault** | **Cross-vault (multiremote)** |
|---|---|---|
| Config | [`wdio.conf.mts`](../wdio.conf.mts) | [`wdio.multiremote.conf.mts`](../wdio.multiremote.conf.mts) |
| Specs glob | `tests/wdio/single/**` | `tests/wdio/cross/**` |
| Obsidian instances | one (`browser`) | two (`primaryVault`, `peerVault`) |
| Drive folder | `SINGLE_VAULT_DRIVE_FOLDER` (`/vault-share-e2e-single`) | `CROSS_VAULT_DRIVE_FOLDER` (`/vault-share-e2e-cross`), shared by both |
| Command | `npm run test:e2e:single` | `npm run test:e2e:cross` |
| Interactive (visible) | `…:single:interactive` (`WDIO_HEADLESS=false`) | `…:cross:interactive` |

Single-vault is the right fit for testing *one device's* behaviour against the
group vault — including "fresh device joins a populated group" and "device
pushes into an empty group." Cross-vault is for *interaction between devices*
(push-then-pull convergence, conflict merges, delete propagation).

Multiremote instances are reached with
`browser.getInstance("primaryVault")` / `getInstance("peerVault")`; the cross
spec wraps these in a `vaults()` helper.

## The shared helper toolbox

All exported from [`wdio.conf.mts`](../wdio.conf.mts) and imported by **both**
single and cross specs (it is the shared helper module, not just the single
config):

| Helper | What it does | When to use |
|--------|--------------|-------------|
| `injectAndConfigure(br, token, folderPath)` | Stops the scheduler, injects the refresh token into auth memory (no keyring), sets + resolves the Drive folder. | Once per instance before any sync. Single mode calls it for you (see lifecycle); cross specs call it themselves. |
| `cleanupTestDriveFolder(br)` | Deletes everything under the test Drive folder (cascades). Returns `{listed, deleted, failed}`. | Reset Drive to empty so leftover files from prior runs don't reconcile as phantom pulls. |
| `seedSyncedFiles(br, files)` | Writes each file to **both** vault and Drive, then records it as a `Synced` candidate in IDB. | **Construct sync history without driving the system under test.** This is how you set up "files that have been synced before" — essential for any delete/with-history scenario. Flat paths only; pre-create folders for nested paths. |
| `runBulkSync(br)` | Awaits one `bulkSync.run()` pass and returns the `SyncPassResult`; throws if the pass errored. | Drive the actual system under test. Coalesces concurrent callers, so it returns the real pass result. |

Constants `SINGLE_VAULT_DRIVE_FOLDER` / `CROSS_VAULT_DRIVE_FOLDER` are exported
from the same module.

### The cardinal rule: tests construct initial conditions *directly*

To set up state, write to the vault, to Drive, and to the candidate store
**directly** (`app.vault.create`, `plugin.api.writeFile`, `seedSyncedFiles`,
`candidateStore.clear()`). Do **not** use `runBulkSync` to build a fixture —
that conflates the setup with the system under test and makes a failure
ambiguous. `runBulkSync` appears only in the *act* phase of a test, never the
*arrange* phase. (`seedSyncedFiles`' docstring states this contract explicitly.)

## Lifecycle (what the `before` hooks do — and don't)

The two configs deliberately differ, and the difference is a common trip-hazard:

- **Single (`wdio.conf.mts` `before`)** does the full setup *for you*: starts
  Xvfb + a window manager (headless Linux), waits for the obsidian-service
  bridge, bumps the WebDriver script timeout to 120 s, injects the token,
  **calls `injectAndConfigure`**, and **runs `cleanupTestDriveFolder` once**.
  A single-vault spec can assume it is configured and Drive is clean at suite
  start.

- **Cross (`wdio.multiremote.conf.mts` `before`)** does *less*: it polyfills
  `executeObsidian` onto each sub-instance (the obsidian-service skips
  multiremote caps), waits for the bridge, bumps the timeout, and loads the
  token into the env. It does **not** call `injectAndConfigure` and does **not**
  clean Drive. **The cross spec's own `before` must do both** (see
  `sync.e2e.ts` — it configures both vaults and calls `cleanupTestDriveFolder`
  from one instance, since both point at the same folder).

The scheduler is stopped by `injectAndConfigure` so **the test is the sole
driver of bulk sync** — no autonomous tick can race the fixture or the
assertions.

## The `executeObsidian` model and its constraints

Everything that touches the plugin runs inside
`br.executeObsidian(async ({ app }, ...args) => { … }, ...args)`, which ships the
callback into the Obsidian renderer process. This carries three hard
constraints — violating them produces confusing failures, not clean errors:

1. **The callback is serialised via `func.toString()`.** It captures *no*
   closure: no module-level helpers, no imports, no outer variables. Everything
   the callback needs must be passed as an `arg` or inlined. Plugin access is
   always the same inlined incantation:
   `(app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins["vault-share"]`.

2. **Types don't cross the boundary.** Declare the `Plugin` / Drive shapes you
   need *inside* the callback (`type Plugin = { … }`). Follow the project's
   no-`any` rule here too: cast through `unknown`, never `any`.

3. **WebDriver JSON-serialises the return value, which strips `Error`.** A
   thrown `Error` arrives back as the opaque `[object Object]`. Flatten errors to
   strings *before* returning (this is exactly what `runBulkSync` does with both
   the thrown path and the `result.error` field). Return only plain JSON-safe
   data.

## Writing a new test — the recipe

1. Pick a mode (single unless the behaviour is genuinely device-to-device).
2. **Arrange** initial conditions *directly*: `app.vault.create` for local
   files; `plugin.api.writeFile` for Drive-only files; `seedSyncedFiles` to
   establish sync history; `candidateStore.clear()` to wipe history while
   leaving files in place (the "no history" setups in `sync-model.md`'s
   invariants 2–4).
3. **Act**: call `runBulkSync(br)` (often twice — invariant 5 says the second
   pass must be a no-op).
4. **Assert** on the `SyncPassResult` counters *and* on the resulting state —
   vault contents, Drive contents, and the candidate store. Read the candidate
   store via `plugin.candidateStore.get(path)` / `getAll()` to verify each
   candidate's `state` and `actionType`, not just file presence.
5. Isolate from other runs: timestamp your paths (`foo-${Date.now()}.md`) or use
   a unique root prefix, as the existing specs do.

## Where this maps

| Concept | File |
|---------|------|
| Single-vault config + shared helpers | [`wdio.conf.mts`](../wdio.conf.mts) |
| Cross-vault (multiremote) config | [`wdio.multiremote.conf.mts`](../wdio.multiremote.conf.mts) |
| Token setup script | [`tests/wdio/setup-wdio-token.ts`](../tests/wdio/setup-wdio-token.ts) |
| Single-vault specs | [`tests/wdio/single/`](../tests/wdio/single/) |
| Cross-vault specs | [`tests/wdio/cross/`](../tests/wdio/cross/) |
| What "correct" sync behaviour is (the invariants under test) | [`sync-model.md`](sync-model.md) |
