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
| **Right-sidebar views** | `sharing-status-view.ts`, `sync-log-view.ts` | `ItemView` leaves |
| **Modals** | `pending-list-modal.ts`, `confirmation-modal.ts` | `Modal` |
| **In-editor panel** | `conflict-marker-navigator.ts` | CodeMirror 6 panel + decorations |
| **Settings tab** | `settings-tab.ts` | `PluginSettingTab` |

`pending-file-panel.ts` is a shared helper (not a surface): a pure async
function that renders a file-content preview inside a `PendingListModal` row.

## The reactive refresh model

Views do **not** hold their own snapshot of sync state. They re-read on demand
and re-render when notified. Three notification channels, all wired in `main.ts`:

- **`CandidateStore.onChange`** → fires after any persistent candidate mutation
  (reconcile, approve, defer, resolution). `main.ts` calls
  `refreshSharingStatusViews()`; `PendingListModal` subscribes directly (and
  auto-closes if its view empties). This is what keeps a modal from letting the
  user Apply against a phantom row that a background pass already resolved.
- **`SyncActivity.onChange`** → fires when the "currently sharing" signal or
  bulk-running flag changes. Drives the status bar and the status view's live
  "Current file" line.
- **`Logger.setAppendCallback`** → fires on each new log entry; `SyncLogView`
  re-renders its list.

A view's `refresh()` is therefore idempotent and cheap: read the store, rebuild
the DOM under the content element. Never accumulate state in the view.

## File-by-file map

### `sync-status-bar.ts` (~36 loc)
The smallest surface: renders the two status-bar items (sharing state +
deferral/monitoring counts). Clicking opens the Sharing Status view. Pure
render-from-counts. *Tested.*

### `sharing-status-view.ts` (~244 loc) — `ItemView`
The control panel. Always-on layout: a live status line (Paused/Running/Idle +
pending/deferred counts + current file), Pause/Resume + Refresh buttons, and a
per-operation count table. Table rows are clickable **only while paused** (the
modal acts on a frozen plan, so it must not be reachable while the engine
mutates candidates); a click opens `PendingListModal`. `onOpen` plans only if
already paused; `onClose` prompts (via `ConfirmationModal`) to resume if paused.
Reads `CandidateStore` + `SyncActivity`; never snapshots. *Tested (~99%).*

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

### `sync-log-view.ts` (~171 loc) — `ItemView`
Sidebar log panel: an always-visible toolbar (copy, clear, severity dropdown
built from Obsidian components) + a scrollable, selectable log list re-rendered
on each `Logger` append. *Tested (~70%).*

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

### Mobile considerations (editor panel only)

The conflict-resolution panel lives **inside** the CodeMirror editor, which makes
it the one surface with genuine mobile-specific handling:
- **Placement** — top panel on desktop, **bottom** panel on mobile
  (`top: !Platform.isMobile`). A top panel on mobile sits under the device status
  bar and out of the tappable region.
- **Tap activation** — buttons bind both `click` *and* `touchend`
  (`bindActivate`), because the editor's touch-gesture handling swallows the
  synthetic `click`. This workaround is **specific to editor-embedded controls**;
  controls in normal views/modals receive plain taps and must use Obsidian
  components instead (never apply `touchend`/`preventDefault` to a native
  `<select>` — it suppresses the OS picker).

Everything else (views, modals, settings) is plain DOM in a normal container and
needs no mobile-specific code.

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

Run: `npm test` (all), or scope to a file. Coverage: `npm run test:coverage`.
Note `main.ts` and `single-file-sync.ts` UI paths are still only covered by wdio
(not piped into v8 coverage), so they read as low in the vitest report.

## Where this maps in code

- Surfaces: the files above, all under [`src/ui/`](../src/ui/).
- Wiring: [`src/main.ts`](../src/main.ts) — `registerView` (sharing-status, log),
  `addStatusBarItem` (×3), `addSettingTab`, `registerEditorExtension` +
  `addCommand` (find next/prev conflict), and the `onChange` subscriptions that
  drive `refreshSharingStatusViews()`.
- State the UI reads/writes: [`src/sync/`](../src/sync/) — see
  [`sync-model.md`](./sync-model.md).
- Tests: `src/ui/*.test.ts` (one per module).
