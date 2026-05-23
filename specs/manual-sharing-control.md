# Manual Sharing Control
Note: originally this feature was called "bulk sync fixuup" and was focused on 
helping user correct a potentially run-away bulk share cycle.
On mature reconsideration, we realize that the tools in this view are more generally useful
so we're renaming it "Manual Syaring Control" and tweaking the user experience to match.

In all of the UI and docs, and in most of the codebase, we call the synchronization process "sharing" rather than "sync".  It's a goal to standardize on "sharing" everywhere.

Scenario: bulk share detected it was going to make "too many" changes, paused itself, notified
the user via the status bar and a startup notice, and offered manual fixups.

Scenario: user is just not sure what's going on and wants to visualize the normally background process of vault sharing.
So user manually pauses sharing by plugin command, then opens a specialized view to check things out.

## Highlight of significant changes "bulk sync" -> "manual sharing control"

- Name changes "bulk sync fixup" -> "manual sharing control"; main view renamed "bulk sharing status" -> "sharing status"
- pausing sharing affects all sharing, single-file and bulk alike.
- Opening the sharing status view pauses sharing, even if it was not already paused due to previous error.
- status view now includes a "refresh" button to update counts of all pending share operations
- status view now deals with a mixed collection of ordinary pending and deferred candidates.

## Pausing and resuming sharing
Sharing can be paused by the user and automatically, due to error detection.  
When it is paused, both bulk and single-file sharing are paused.  Any currently active file sharing operation is not interrupted is allowed to complete normally.

The plugin prefers to have sharing unpaused.  A visible indicator appears in the status bar when sharing is paused, and the user receives confirmation prompts when trying to close the plugin or Obsidian with sharing paused.

But if the user chooses to leave with sharing paused, the paused state persists across plugin restarts.  So it is not an error (but still unusual) for the plugin to start with sharing paused.

## Pending and deferred share operations
During planning for a bulk run, sharing compares *current* metadata about related files in local
and group vaults.  These are the "candidate" files, and there's a data structure that represents this potential 
sharing operation, called a "candidate".

So the candidate represents a "pending" share operation - one that will be performed sooner or later.

This spec introduces the possibility for the share operation to be put into a *deferred* state, which 
persists until manually changed.  
While a candidate is deferred, sync operations will not operate on either file.
The plugin must persist enough state to identify and skip that candidate in future sync passes. 

The candidate can get into deferred state either automatically, when bulk sharing discovers "too many" 
pending candidates and marks them all as deferred, or manually, by the user working in the Sharing Status view.

The deferred status is normally cleared by the user working in the Sharing Status view, but 
can also happen automatically as described in [](#auto-revocation-by-mtime-comparison).

## Auto-revocation by mtime comparison

If a candidate file pair gets deferred and then the user makes changes to a file by Obsidian or any external means, 
the candidate should automatically become undeferred.  That's what we mean by auto-revocation.

Deferred state is cleared by any changes to either of the candidate files through normal Obsidian operations: edit a note, copy, move or delete files in vault index, etc.

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

## Status bar indicator

When sync is paused or deferred candidates exist, a persistent status bar item is shown
(separate from the transient sync-progress messages). It is always visible and clickable.

- While paused with candidates pending: displays e.g. "⚠ Sharing paused – 12 files pending".
  Clicking opens the Bulk Sharing Status panel.
- While running with no candidates: the indicator is hidden.

## Startup notification

On plugin load, if the deferred-candidates store contains any records, show an Obsidian Notice
with a clickable link: "Bulk sharing has N deferred files — tap to review." Tapping opens the
Bulk Sharing Status panel.

## Sharing Status panel
This is the entrypoint for manual inspection and fixup of sharing operations.
Opened via:
- command palette entry: "Open sharing status panel."
- clicking the persistent status bar indicator (see below).
- navigating to the Vault Share sidebar view (if the panel lives there).

When the panel is opened, it first pauses sharing if it was not already paused by previous error detection.
Then it collects a fresh candidate list so it can display current candidate counts on first render.

### Panel contents

Panel contents are responsive, and reflect live data changes.

User can see:
- Overall sharing state: paused or running (meaning not paused).  Bulk sharing: paused (because overall sharing is paused)waiting (scheduled) or running (currently active in the background).
  Note that sharing is paused when view first opens, but user can resume sharing, then the sharing state could show active.
- Sharing status: a toggle button to manually pause or resume sharing.
- Refresh candidate counts: recomputes all candidate status and updates counts and lists of candidates.  
  Basically plans a bulk share without doing the sharing operations.
- Count of candidates per operation type, in the table below. Tapping a row opens the
  list popup for that operation type.

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
"Sharing is paused. Resume sharing before closing?" with Resume and Keep Paused buttons.

## Candidate list popup

Lists all candidates for a particular kind of share operation.
Designed to render well in portrait orientation on mobile.

Header:
- Plain-language description of what sharing will do for each accepted candidate
  (e.g. "Sharing will push these files to the group vault. Accept the ones you want to allow.").
- "Select all" checkbox.
- Apply and Cancel buttons.

List:
- Each row shows the vault path of the candidate and a checkbox.
  If the candidate is deferred, the checkbox is cleared.  If candidate is just pending, checkbox is set.
  Checking the checkbox means "I accept this planned operation."
  Changing the checkbox doesn't take effect till Apply is tapped.
- Tapping a row (not the checkbox) expands it inline to show the Manual Review detail (accordion).
  Only one row is expanded at a time; expanding a new row collapses the previous one.

Tapping Apply removes clears deferred status for all checked candidates. They will be processed in the
next bulk sync pass — immediately if sharing is running, or when the user resumes sharing if paused.
The counts in the Bulk Sharing Status panel update to reflect the change.
Tapping Cancel discards all pending checkbox changes and closes the popup.

### Manual Review (inline expansion)

Visualizes the individual candidate's details so the user can resolve it manually or leave it unchanged.
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

Resolution buttons (performed immediately; clears candidate's deferred state):

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

- Default keybindings for "find next conflict" and "find previous conflict" edit actions?
- Concrete schema for the deferred-candidates IndexedDB store (TBD at design time).
