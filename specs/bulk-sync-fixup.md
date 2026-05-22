# Bulk Sync fixup
This is the user experience for correcting a potentially run-away bulk share cycle.
Scenario: bulk share detected it was going to make "too many" changes, paused itself, notified
the user via the status bar and a startup notice, and offered manual fixups.

## Deferred state for a share operation
When sharing checks a candidate file pair it compares *current* metadata about the files in local
and group vaults. This spec introduces the possibility for a share operation to be *deferred* —
meaning the plugin must persist enough state to identify and skip that candidate in future sync
passes. The term "share operation candidate" (or "candidate") is used throughout for this concept.

When bulk sync plans a share cycle it generates a list of candidates. If that list is "too" long,
the plugin pauses sync, marks all candidates as deferred, and allows manual recovery.

We also want the deferred status to be dropped automatically if the user makes a further change to either of the candidate files through normal Obsidian operations: edit a note, copy, move or delete files in vault index, etc.

### Auto-revocation by mtime comparison

Auto-revocation is designed to be implicit — requiring no explicit "undefer" calls anywhere in the
codebase. When a candidate is deferred, the plugin stores the local and remote file mtimes *at the
time of deferral* alongside the candidate record.

At the start of each bulk sync pass, after enumerating current local and remote file states, each
deferred candidate is compared against the current file states for its path:

- If either side's current mtime differs from the stored mtime at deferral time, the candidate is
  silently dropped from the deferred list and the path is processed normally by the decision engine.
- If both mtimes still match, the candidate remains deferred and is skipped for this pass.

This single comparison handles all cases without extra code at each event site:
- **Edit:** local mtime changes → candidate auto-drops on next bulk sync pass.
- **Delete:** local mtime becomes absent (0) → mismatch → auto-drops.
- **Rename:** old path's local file is absent → mismatch → old candidate auto-drops; new path enters as a fresh candidate.
- **Remote change:** remote mtime changes → mismatch → auto-drops.

The deferred candidate record must therefore persist across plugin restarts. It will be stored in a
new IndexedDB object store (alongside the existing `sync-records`, `sync-content`, `sync-stats`,
and `device` stores). Each record stores: the planned operation type, the vault path, the local and
remote mtimes at deferral time, and the timestamp when the candidate was deferred.

The sync-paused flag is also stored in IndexedDB (not in plugin settings / `data.json`). Plugin
settings are shared to other devices by the sync mechanism, so device-local state such as "this
device has paused sync" must not live there.

## Bulk Sharing Status panel
This is the entrypoint for manual fixups of deferred candidate share operations.

When the "too many changes" threshold is exceeded, bulk sync pauses itself, defers all candidates,
and directs the user here. Bulk sync remains paused while the user performs manual fixups.

### Accessing the panel

The panel must be reachable at any time so the user always has access to the pause/resume control:
- Via a command palette entry: "Open bulk sharing fixup panel."
- By clicking the persistent status bar indicator (see below).
- Navigating to the Vault Share sidebar view (if the panel lives there).

### Status bar indicator

When sync is paused or deferred candidates exist, a persistent status bar item is shown
(separate from the transient sync-progress messages). It is always visible and clickable.

- While paused with candidates pending: displays e.g. "⚠ Sharing paused – 12 files pending".
  Clicking opens the Bulk Sharing Status panel.
- While running with no candidates: the indicator is hidden.

### Startup notification

On plugin load, if the deferred-candidates store contains any records, show an Obsidian Notice
with a clickable link: "Bulk sharing has N deferred files — tap to review." Tapping opens the
Bulk Sharing Status panel.

### Panel contents

User can see:
- Current state of bulk sharing (paused or running).
- A button to manually pause or resume sharing at any time.
- Count of deferred candidates per operation type, in the table below. Tapping a row opens the
  deferred list popup for that operation type.

| Vault affected | What sharing plans to do |
| --- | --- |
| Group vault | Push a file that only exists locally |
| Group vault | Push to update a file with the newer local version |
| Group vault | Delete a file (you deleted it locally) |
| Local vault | Pull a file that only exists in the group vault |
| Local vault | Pull to update a file with the newer group vault version |
| Local vault | Delete a file (it was deleted in the group vault) |
| Local vault | Merge conflicting edits to a text file (includes the case where one vault deleted the file — treated as a merge where one side is empty) |
| Local vault | Create a conflict copy for a non-text file with conflicting edits |

When the user closes this panel while sharing is still paused, a confirmation dialog asks:
"Bulk sharing is paused. Resume sharing before closing?" with Resume and Keep Paused buttons.

## Deferred list popup

Lists all the deferred candidates for a particular kind of share operation.
Designed to render well in portrait orientation on mobile.

Header:
- Plain-language description of what sharing will do for each accepted candidate
  (e.g. "Sharing will push these files to the group vault. Accept the ones you want to allow.").
- "Select all" checkbox.
- Apply and Cancel buttons.

List:
- Each row shows the vault path of the candidate and a checkbox.
  Checking the checkbox means "I accept this planned operation."
  Checkbox changes are pending — no state changes until Apply is tapped.
- Tapping a row (not the checkbox) expands it inline to show the Manual Review detail (accordion).
  Only one row is expanded at a time; expanding a new row collapses the previous one.

Tapping Apply removes all accepted candidates from the deferred list. They will be processed in the
next bulk sync pass — immediately if sharing is running, or when the user resumes sharing if paused.
The counts in the Bulk Sharing Status panel update to reflect the change.
Tapping Cancel discards all pending checkbox changes and closes the popup.

### Manual Review (inline expansion)

Visualizes the candidate's details so the user can resolve it manually or leave it unchanged.
Rendered as an expanded section within the deferred list row — no separate modal.

The expanded section has a header and one or two file panels depending on the operation.

Header shows:
- Vault path of the candidate.
- The pending share operation in plain language.

**File panel layout:** all operations use a single read-only file panel except:
- Text conflict uses a single editable file panel showing the 3-way merged result (one side may be
  empty if one vault deleted the file). The user edits this file to resolve conflict markers before
  completing the merge.
- Non-text conflict uses two read-only panels stacked vertically: local vault file on top,
  group vault file below (downloaded on demand).

| Operation type | File panel content |
| --- | --- |
| Push | Local vault file (read-only) |
| Pull | Group vault file (read-only; downloaded on demand) |
| Delete local | Local vault file (read-only) |
| Delete remote | Group vault file (read-only; downloaded on demand) |
| Text conflict (including delete+modify) | Merged file in local vault (editable) |
| Non-text conflict | Local vault file (top, read-only) · Group vault file (bottom, read-only; downloaded on demand) |

Resolution buttons (performed immediately; removes the candidate from the deferred list):

| Operation type | Available resolution buttons |
| --- | --- |
| Push | **Proceed** · **Back out** (delete local file) · **Skip** |
| Pull | **Proceed** · **Back out** (delete from group vault) · **Skip** |
| Delete local | **Proceed** · **Back out** (restore from group vault to local) · **Skip** |
| Delete remote | **Proceed** · **Back out** (restore from local vault to group) · **Skip** |
| Text conflict | **Merge** · **Back out** (restore common base to both vaults) · **Skip** |
| Non-text conflict | **Keep local** · **Keep group** · **Delete both** · **Skip** |

Resolution semantics:
- **Proceed** — executes the planned operation immediately without waiting for bulk sync.
- **Back out** — resolves the discrepancy in the opposite direction from what sharing planned:
    - Push → delete the local file (moved to trash).
    - Pull → delete the file from the group vault.
    - Delete local → restore the file by copying from the group vault to local.
    - Delete remote → restore the file by copying from the local vault to the group vault.
    - Text conflict → copy the common base (last synced version, from the sync-content cache or Drive) to both vaults, discarding both sides' changes.
  Sync records are updated so sharing considers both sides reconciled.
- **Skip** — collapses the row, leaving the candidate deferred.
- **Keep local** — local file is copied to the group vault; sync records updated so both sides are considered identical.
- **Keep group** — group file is copied to the local vault; sync records updated so both sides are considered identical.
- **Merge** — checks the merged file currently in the editor for remaining conflict markers.
  If none remain, writes the file to both vaults immediately.
  If markers remain, shows "Resolve all conflict markers first" and keeps focus in the editor.
- **Delete both** — deletes the file from both vaults (local side is moved to trash).

## Edit action - Resolve conflict markers
This command is provided by the plugin for use in the edit view of any 3-way merged file.
It is not specific to manual review.

This command provides "find next conflict" and "find previous conflict" actions.
- Moves the cursor to the beginning of the next or previous marked conflict region. Search wraps
  around the bottom or top of the file but stops where it started if none are found. If none is
  found, or the cursor was already at the only one, the user sees "No other conflicts" and the
  cursor stays where it was.
- At the beginning of the conflict region, offers options:
    - "Skip" — does a find-next-conflict operation without resolving the current region.
    - "Keep all" — removes all conflict markers and their newlines, squashing all alternatives onto adjacent lines.
    - "Keep local version" / "Keep group version" / "Revert to base" — removes the other alternatives and all conflict markers, leaving only the text of the selected version.
        - "Keep local version": the local vault's edits.
        - "Keep group version": the group vault's edits.
        - "Revert to base": the common ancestor version at last sync.

After completing the edit, the cursor stays in place so the user can review (and manually adjust if needed).

## Open questions

- Should the Bulk Sharing Status panel be a section of the existing Vault Share sidebar view, or a separate view?
- Default keybindings for "find next conflict" and "find previous conflict" edit actions?
- Concrete schema for the deferred-candidates IndexedDB store (TBD at design time).
