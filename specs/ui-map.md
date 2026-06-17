# UI map — the living reference

> **Status: Living.** This is the authoritative conceptual map of the plugin's
> UI layer ([`src/ui/`](../src/ui/)). Read it *before* the code. It describes
> what each surface is, how the surfaces stay live, and the patterns that recur
> across them — and deliberately avoids signature-level detail so it does not rot
> against the implementation. For the "how", the per-identifier TypeDoc comments
> in the source are authoritative; this doc is the "what" and "why". For the sync
> engine the UI reflects, see [`sync-model.md`](./sync-model.md).

## Guiding principle

The UI layer holds **no business logic**. Every surface reads state from the
sync layer ([`CandidateStore`](../src/sync/candidate-store.ts),
[`SyncActivity`](../src/sync/sync-activity.ts), [`Logger`](../src/logger.ts),
[`StatsTracker`](../src/sync/stats-tracker.ts)) and routes user actions back to
it (`approve`/`defer`, the `resolution-executor` `execute*` functions, plugin
lifecycle methods). `main.ts` owns construction and wiring; UI modules own
rendering and event wiring only. This is what makes them unit-testable with
injected fakes.

## Surfaces

The plugin presents UI in five places:

| Surface | Module(s) | Host |
|---|---|---|
| **Status bar** (bottom) | `sync-status-bar.ts` | Obsidian status-bar items |
| **Right-sidebar panel** | `sharing-panel.ts` | one `ItemView` leaf |
| **Modals** | `pending-list-modal.ts`, `confirmation-modal.ts` | `Modal` |
| **In-editor panel** | `conflict-marker-navigator.ts` | CodeMirror 6 panel + decorations |
| **Settings tab** | `settings-tab.ts` | `PluginSettingTab` |

`pending-file-panel.ts` is a shared helper (not a surface): a pure async
function that renders a file-content preview inside a `PendingListModal` row.

## The reactive refresh model

Views do **not** hold their own snapshot of sync state. They re-read on demand
and re-render when notified. Four notification channels, all wired in `main.ts`,
all driving the one consolidated panel's `refresh()`:

- **`CandidateStore.onChange`** → fires after any persistent candidate mutation
  (reconcile, approve, defer, resolution). `main.ts` calls
  `refreshSharingStatusViews()`; `PendingListModal` subscribes directly (and
  auto-closes if its view empties). This is what keeps a modal from letting the
  user Apply against a phantom row that a background pass already resolved.
- **`SyncActivity.onChange`** → fires when the "currently sharing" signal or
  bulk-running flag changes. Drives the status bar and the panel's Running/Idle line.
- **`SyncScheduler.onNextRunChange`** → fires when the next scheduled bulk-sync
  time moves (trigger, resume, or a completed pass arming the next one). Keeps the
  panel's "Idle till HH:MM:SS" line responsive without per-second ticking.
- **`Logger.setAppendCallback`** → fires on each new log entry; the panel
  re-renders its log list.

A view's `refresh()` is therefore idempotent and cheap: read the store, rebuild
the DOM under the content element. Never accumulate state in the view.

## File-by-file map

### `sync-status-bar.ts` (~36 loc)
The smallest surface: renders the two status-bar items (sharing state +
deferral/monitoring counts). Clicking opens the Sharing status panel. Pure
render-from-counts. *Tested.*

### `sharing-panel.ts` (~340 loc) — `ItemView`
The single consolidated panel (issue #12): log and sharing status in one leaf,
so the plugin adds just one sidebar icon. It is **not** opened on startup (that
stole focus from the user's default note); a ribbon icon and the
`open-sharing-status` / `open-log-panel` commands open it on demand. Two stacked
sections, each with its own header toolbar so controls sit next to the content
they act on (no single undifferentiated ribbon); a strong divider separates them:

1. **Sharing section** (top ~half) — header carries the share controls
   (pause/resume, refresh plan), then one status line
   (Paused / Running / Idle till HH:MM:SS + pending/deferred counts) and the
   per-operation count table. Table rows are clickable **only while paused** (the
   modal acts on a frozen plan, so it must not be reachable while the engine
   mutates candidates); a click opens `PendingListModal`.
2. **Log section** (bottom ~half) — header carries the log controls (severity
   dropdown, clear, copy; Obsidian `DropdownComponent` / `ExtraButtonComponent`),
   then a scrollable, selectable log list re-rendered on each `Logger` append.

A **draggable splitter** separates the two sections (drag, or Up/Down when
focused); travel is clamped to a 20–80% range so neither section can collapse to
0 or fill the panel. The split is published as the `--vault-share-split` CSS
variable that the sections' `flex-grow` read. On mobile each section's toolbar
drops to the bottom of its section (CSS `order`, keyed off an `is-mobile` class),
staying clear of the notification area.

`refresh()` is synchronous (reads `CandidateStore.isPausedSync`) so frequent log
appends re-render cheaply without awaiting IndexedDB. `onOpen` plans only if
already paused; `onClose` detaches the log callback and prompts (via
`ConfirmationModal`) to resume if paused. Reads `CandidateStore`, `SyncActivity`,
`Logger`, and the scheduler's next-run getter; never snapshots. *Tested.*

### `pending-list-modal.ts` (~400 loc) — `Modal`
Review/act on every candidate of one `SyncActionType`. One row per candidate:
checkbox (checked ⇔ "will be shared on resume" — Default/Approved checked,
Deferred unchecked) + an accordion that lazily renders a preview
(`loadFilePanels`) and per-type resolution buttons:
- non-conflict → **Proceed** / **Back out**
- text conflict → **Merge** (reads the editable textarea, blocks on remaining
  conflict markers) / **Back out**
- binary conflict → **Keep local** / **Keep group vault** / **Delete both**
- always **Skip** (collapse without executing).

**Apply** translates checkbox state into `approve`/`defer` calls (incl.
retracting an Approved file by un-checking it). Subscribes to
`CandidateStore.onChange` and auto-closes when its view empties. *Tested (~92%).*

### `pending-file-panel.ts` (~151 loc) — helper
`loadFilePanels(container, candidate, ctx, textareaRef)`: async, injectable
(all I/O via `ctx.localFs`/`ctx.driveFs`). Renders read-only local/remote panes,
or an editable textarea seeded with the 3-way merge for text conflicts (setting
`textareaRef.el` so the modal's Merge button can read user edits), or an error
message. *Tested (100%).*

### `settings-tab.ts` (~274 loc) — `PluginSettingTab`
Options UI. No logic of its own: every control's `onChange` writes through
`plugin.saveData` and, where a subsystem is affected, calls the matching plugin
handler (`onDriveFolderPathChange`, `rebuildExcludeMatcher`, login/logout,
`pluginReset`, `statsTracker.reset`). The Statistics section is read-only and
conditional on `statsTracker.getCurrent()`. Reset-plugin gates on
`ConfirmationModal`. *Tested (100% lines).*

### `confirmation-modal.ts` (~108 loc) — `Modal`
A reusable yes/no prompt exposing the **static** `ConfirmationModal.prompt(...)
=> Promise<boolean>`. Used by the status view (resume-on-close) and settings
(reset-plugin). *Tested.*

### `conflict-marker-navigator.ts` (~440 loc) — CodeMirror 6
The odd one out: not a view/modal but an **editor extension**. Backs the *Find
next/previous conflict* commands. Parses N-way conflict regions
(`MARKER_OPEN`…`MARKER_CLOSE`), outlines the active region with CM6 line
decorations, and floats a CM6-managed panel with one resolution button per
labelled segment plus nav arrows. `buildConflictBanner(...)` is the extracted,
pure, unit-testable panel builder. *Tested (navigator + builder).* See the
mobile notes below — this surface has the only real mobile-specific code.

## Cross-cutting patterns

- **`ItemView` content area is `containerEl.children[1]`** — `children[0]` is the
  nav header. Views render into `children[1]`; `refresh()` empties and rebuilds it.
- **`Modal` lifecycle** — `open()`→`onOpen()`, `close()`→`onClose()`. Build DOM in
  `onOpen`, tear down subscriptions in `onClose`. Prefer the static
  `ConfirmationModal.prompt` helper over hand-rolling a yes/no modal.
- **Obsidian components vs raw DOM** — use `Setting` / `ButtonComponent` /
  `DropdownComponent` / `ExtraButtonComponent` for controls in views, modals, and
  settings (they are mobile-first and idiomatic). Raw `createEl` + listeners are
  acceptable in the editor panel, where Obsidian components don't fit.
- **Async-after-await** — many handlers do `await saveData(...)` (or an executor)
  and then act (e.g. `rebuildExcludeMatcher`, `handleSuccess`). The post-await
  work runs on a later microtask.

### Mobile considerations

Two surfaces carry mobile-specific placement; both move a control strip to the
**bottom** on mobile so it clears the device status bar / notification area:

- **Conflict-resolution panel** (editor-embedded) — top panel on desktop, bottom
  on mobile (`top: !Platform.isMobile`). Being **inside** the CodeMirror editor,
  it also needs **tap activation**: buttons bind both `click` *and* `touchend`
  (`bindActivate`), because the editor's touch-gesture handling swallows the
  synthetic `click`. This workaround is **specific to editor-embedded controls**;
  controls in normal views/modals receive plain taps and must use Obsidian
  components instead (never apply `touchend`/`preventDefault` to a native
  `<select>` — it suppresses the OS picker).
- **Sharing panel** (`sharing-panel.ts`) — each of the two sections has its own
  header toolbar; on mobile those toolbars drop to the bottom of their section. This
  is **pure CSS**: `onOpen` toggles an `is-mobile` class on the container from
  `Platform.isMobile`, and the stylesheet reorders the section headers (`order`);
  no touch-event workaround is needed because the controls use Obsidian components
  in a normal container.

Everything else (modals, settings) is plain DOM in a normal container and needs
no mobile-specific code.

## Testing the UI layer

UI modules are unit-tested under vitest + jsdom via `obsidian-mock`
(`#thirdRound` provides the global `createDiv`/`createEl`, full `DomElementInfo`,
`setAttr`/`setAttrs`). Conventions that the lint config enforces and that keep
tests robust:

- **Inject fakes, assert on standalone spy consts.** `expect(obj.method)` on a
  real-typed or **static** method trips `@typescript-eslint/unbound-method`;
  return the spies standalone from helpers (e.g. `makeCtx` returns
  `{ ctx, read, readBinary }`), and use `vi.hoisted` for static mocks like
  `ConfirmationModal.prompt`.
- **Mock a constructable class** with a regular function, not an arrow
  (`vi.fn(function () { return { open: vi.fn() }; })`) — arrows aren't `new`-able.
- **Capture callbacks** passed to mocked constructors via `.mock.calls[i][n]` to
  cover "child notified parent" paths (e.g. the modal's `onResolved`).
- **Await a microtask** (`await Promise.resolve()`) before asserting effects that
  run after an `await` inside a handler.
- Use `createDiv()` / `querySelector<T>()` rather than
  `document.createElement` / `as T` (obsidianmd lint + no-unnecessary-assertion).
- Drive Obsidian components by their rendered DOM: `Text`/`TextArea` fire
  `onChange` on an `input` event, `Dropdown` on `change`, `Button` on click; the
  mock `Setting` renders `.setting-item` / `.setting-item-name` /
  `.setting-item-heading` with components in `controlEl`.

### Coverage

Run: `npm test` (all), or scope to a file. Three coverage views:

- **Unit** — `npm run test:coverage` → `coverage/` (vitest, **istanbul** provider).
- **E2e** — `npm run test:coverage:e2e` → `coverage-e2e/`. Builds an
  Istanbul-instrumented `main.js` (`npm run build:coverage`, a `coverage` mode in
  `esbuild.config.mjs` that instruments TS source directly so positions stay in
  TS coordinates), runs the credential-free UI wdio config, harvests
  `window.__coverage__` in each config's `after` hook (`collectCoverage` in
  `wdio.conf.mts`) into `.nyc_output/`, and reports via `nyc`. This is what
  finally gives `main.ts`, the editor panel, and the `src/sync`/`src/gdrive`
  plugin-load paths real numbers. (`test:coverage:e2e:single` also runs the
  token-gated single-vault config for fuller reach.)
- **Combined** — `npm run test:coverage:combined` (or `test:coverage:all` to run
  everything first) → a **line-level union** of unit ∪ e2e
  (`scripts/coverage-combine.mjs` → `coverage-all/`). It unions covered *source
  lines*, not statement maps: unit and e2e instrument different transpiled JS, so
  a statement-level `nyc merge` would be incoherent (it averages). Both sides use
  istanbul against TS coordinates, so the line sets align and combined ≥ each
  input. All wdio coverage hooks are no-ops on a normal (uninstrumented) build.

## Where this maps in code

- Surfaces: the files above, all under [`src/ui/`](../src/ui/).
- Wiring: [`src/main.ts`](../src/main.ts) — `registerView` (one sharing panel) +
  `addRibbonIcon` (opens it on demand; not auto-opened), `addStatusBarItem` (×3),
  `addSettingTab`, `registerEditorExtension` + `addCommand` (find next/prev
  conflict), and the `CandidateStore` / `SyncActivity` / `SyncScheduler` `onChange`
  subscriptions that drive `refreshSharingStatusViews()`.
- State the UI reads/writes: [`src/sync/`](../src/sync/) — see
  [`sync-model.md`](./sync-model.md).
- Tests: `src/ui/*.test.ts` (one per module).
