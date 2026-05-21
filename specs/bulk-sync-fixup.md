# Bulk Sync fixup
This is the user experience for correcting a potentially run-away bulk share cycle.
Scenario is that bulk share detected it was going to make "too many" changes and paused itself, somehow informing the user and  inviting him/her do manual fixups.

## Deferred state for a share operation
Currently, when sharing checks a candidate file pair, it's comparing *current* metadata about the files in local and group vaults. Now, we're introducing the possibility for a share operation to be *deferred*, meaning that there needs to be some persistent state information about these candidates as well.  

The code currently has type `SyncAction` which has all the relevant data, but this is not currently persistent, we'll have to design something later.
I don't want to presume what the actual implementation will be, so I'm going to use the term "share operation candidate", or "candidate" as a placeholder in this spec.

So, when bulk sync plans a share cycle, it generates a list of candidates.  If that list of candidates is "too" long, we will pause sync, mark all those candidates as deferred and allow manual recovery.

We also want the deferred status to be dropped automatically if the user makes a further change to either of the candidate files through normal Obsidian operations: edit a note, copy, move or delete files in vault index, etc. 

How to represent this deferred state?
- must be per candidate file pair granularity
- should be efficient in time and space
- should automatically be revoked if user subsequently does some normal obsidian operation on either file (edit or delete, copy, move in vault tree, etc)

## Bulk Sharing Status panel
This is the entrypoint for user to do manual fixups of deferred candidate share operations

Might be a section of the existing Vault Share view, or separate.

User can see:
- current state of bulk sharing (paused, running, currently active)
- what the next bulk share sync operation was going to do
    - count of candidates for each of the share operation listed below:
- a button to pause/unpause sharing 


| vault to be affected | operation bulk share wants to do |
| ----- | ---------------------------------|
| group | create new file (push) | 
| group | overwrite existing file (push, or conflict with "keep newer" policy) |
| group | delete file (deleteRemote) |
| local | create new file (pull) |
| local | overwrite existing file (pull, or conflict with "keep newer") |
| local | delete file (deleteLocal) |
| local | create conflict pair in (conflict, non-text or deleteConflict) |
| local | 3-way diff merge (text type file and (conflict or deleteConflict)) |

User can click on one of these rows to open a "deferred list" popup

User will be directed here when "too many changes" threshold exceeded, but can open this panel and do things at any time.

## Deferred list popup

Lists all the deferred candidates for a particular kind of share operation

Header: 
- explaination of the share operation for these candidates.
- "select all" checkbox

List: 
- vault path of the candidate
- a checkbox to mark the candidate as undeferred (doesn't actually change state till popup closes)
- clicking the list row opens the "manual review" popup

Closing the deferred list popup applies all the undefer state changes (no state change until this point).
Once the undefer state change happens, the candidate is immediately available for bulk sharing.
And the state change updates the count of deferred candidates  shown in the Bulk Sharing Status panel.

## Manual Review popup

Visualizes the share candidate details, so user can manually complete the share operation or leave it unchanged.

Layout of the popup has a common header above a one or two "file panel"(s) depending on the kind of share operation.

Header shows:
- vault path of the candidate
- the pending share operation

"File Panel" Depending on the kind of share operation, one or two tabs or panes in a splitter.

File panel shows:
- header
    - vault the file lives in (local or group)
    - vault path
    - resolution choices: "cancel", "keep this", "merge" (only for text conflict), "delete both", "keep other"
- body
    - (for a file in the local vault) an editable view of the file (or view only if the file type is not editable)
    - (for a file in remote vault) a read-only view of the file (implies the group file is downloaded to show in the view)

When user makes a resolution choice, the operation is perfomed immediately and the deferred state goes away.
- "cancel" - file panel closes with no change to files or to deferred status of the candidate
- "keep this" - the selected file is copied to the "other" vault so it's present in both vaults with metadata adjusted so share will consider the files identical.
- "keep other" - the file in the "other" file panel is copied to "this" vault, so it's present in both vaults with metadata adjusted so share will consider files identical.
- "merge" - when clicked plugin checks status of merged file displayed in file panel.  
  If no 3-way conflict markers, merged file is written to both vaults (not waiting for bulk sync)
  If file has conflict markers, user sees message "resolve merge conflicts" and focus is set on the file panel.
- "delete both" - file is deleted from both vaults.  (for local vault, moved to trash)

## Edit action - Resolve conflict markers
This is an edit action provided by the plugin that can be used in the edit view for any 3diff merged file.  It is not specific to manual review.

Action provides a "find next conflict" and "find previous conflict" edit action.
- action moves cursor to beginning of the next or previous marked conflict region.  Search wraps around the bottom or top of file, but stops where it started if none found. If none is found, or cursor was already at the only one, user sees message "No other conflicts" and cursor stays where it was.
- at the beginning of the conflict region, offers options:
    - "skip" -- does a find next conflict operation.
    - "keep all" -- action removes all the conflict markers and their newline, squashing all the alternatives onto adjacent lines
    - "keep `<firstOption>`", "keep `<lastOption>`, "revert to original" -- remove the "other" alternatives and all conflict markers and their newline, leaving only the text of the selected alternative.

After completing the edit, action leaves cursor where it is, so user can see the completed edit (and manually fix it up if needed).

Open question: default keybindings for find next and find previous conflict?

## open questions:
- concrete representation of deferred state -- maybe `SyncAction`, persisted in IndexedDB?
- Design of "defer list" -- Popup modal or pop out window?
- When "too many" threshold exceeded and sharing is paused, should all the affected candidates start off in deferred state, or left as is but with sharing guaranteed to be paused?
  - Pausing sharing but not deferring all the current candidates is a bit fragile.  If sharing get unpaused unexpectedly, user gets deluged with the undesired share operations.
  - Could do *both*, pause sharing *and* mark all the current candidates as deferred.  More robust.
  - Or we could just defer all the candidates and not pause bulk sharing.  
    Then the undesired share operations don't happen, but user could proceed with editing existing files normally and those changes would be shared.  
    But we would need to periodically remind the user that s/he must deal with the backlog of deferred candidates eventually.  
    Also, bulk share must not get slowed down by presence of many deferred candidates.  This situation might persist over many bulk share cycles.
  - [A] Yes, after threshold exceeded, all candidates should be in deferred state.  Still not sure whether sharing should be paused or left running.

User can open the panel at any time, so the status information has to be correct for any state of bulk sharing.