# Synchronization feature - vault-share plugin for Obsidian
Provides synchronization between each local Obsidian vault and a designated cloud folder (herinafter called the "group vault").
Synchronization means all vaults (local and group) have the same subfolder structure and all files have the same content.

## Goals
- Supports having local copies of the vault on multiple devices, where the local copies coordinate updates through a single "group" vault, 
which is a folder structure on a cloud file server.  
- V1 goal is to support Google Drive as the file server, but OneDrive or DropBox might be added in the future.  
- Multiple users should be able to share the same group vault, abiding by the sharing rules of the cloud service.
- Support synchroniation of all types of files, with options for handling conflicting changes made on different devices.
- But specifically for text and markdown files, support an option to reconcile changes via diff3 merging.
- Support offline operation, where Obsidian is usable even if not currently online.  Files can be edited locally while offline and will be synched with the group vault when the device is back online.
- Provide a background bulk synchronization which tends to keep devices in sync within an hour of changes.
- Provide a foreground, single-file synchronization which keeps active devices in sync within seconds.
- Minimize network and local resource consumption within the above responsiveness constraints so the facility performs well on mobile devices.
- Deploy via Obsidian Community Plugins repo, runs on any device which Obsidian supports.

## Non Goals
- Not trying to support near-real-time collaborative edit when the same file is open for editing on multiple devices.  
  The sweet spot is to support a single user who runs Obsidian on a desktop, a tablet and a phone who edits a file on one of them 
  and wants to see the changes automatically on the next device s/he picks up.

## Assumptions
- If a file or folder name matches, we assume users intended them to represent the same thing (plus or minus the latest updates).  So we'll rely on file name matching.
- We won't  assume tight clock synchronization between remote and local vault.  We'll monitor clock skew and collect statistics about it.  Open question for future version: when/how to warn user if this gets too big.
- A given local vault can only be connected to one group vault (at a time).

## Key Scenarios
These scenarios include a high level description of the operation of (the synchronization feature) of the plugin, 
at least so far as the user can see.  Actual design should treat these descriptions as binding constraints on the design, howeved the requirements can be negotiated if a much better design could be realized by modifying the scenario descriptions.

### Install and configuration
User finds vault-share in Obsidian community plugins and installs it, takes all the defaults and is fully operational, getting reasonable performance and very high file integrity.

User has an archive of PDF files and movies kept in his vault and this, too, was automatically copied to other devices and work fine there.  But the user found that the archive was too large for his old smartphone, so changed configuration on the phone to omit synchronizing movie files while continuing to sync PDF files.

User finds that Obsidian features like Bases, Canvas and Web Clipper and Tasks all continue to work normally after enabling sync.  

### First time connect to a group vault
If user is running the plugin for the first time, it will create a group vault in his/her cloud storage service, default name is same as local vault.
When it first connects, the plugin checks whether the group vault has content and *merges* any local content with any group content.
When user connects second device (also using same vault name), that group vault will be merged with local vault.
If this operation would add, delete or update an "unreasonable" number of files in the local vault, the user is prompted for confirmation before proceeding.

### Resumption of connection, offline operation
If communication to the group vault is interrupted by network or server problems (including auth problems), the user sees a message in the status bar, but can continue to use Obsidian locally.
If it's a transient network problem that resolves itself later, user will notice that the status will clear and any accumulated backlog of work gets resumed without manual intervention.
If user makes configuration changes to resolve the problem, e.g. disconnects/reconnects to fix an auth issue, s/he notices that the accumulated backlog also gets resumed without explicit restart or refresh. 
However, the plugin provides commands to start/stop synchronization, so user has some manual control as well.

### Sync experience 
When the user opens a note file, s/he sees that it is usually the latest version (that is, has the latest set of changes made on any of his/her devices).  
If it is not, user sees that the view window goes busy within a few seconds after opening and then shows the latest version.  
With a lot of experience, user comes to notice that the delayed update tends to happen more often when the device has been offline for a while, 
but if the device has been online continuously it practically never happens. 
(implementation note: due to bulk sync finding more work to do after device was offline)

User can observe the synchronization process at work by setting up a bit of an experiment: 
user opens a note on one device and leaves it open there while turning to a second device, opening the same note and making changes to it.
User sees that none of the changes being made on the second device show up on the first device until the user stops typing for several seconds.  
Then, the view on the first device goes busy for a moment and displays the changes when the busy clears.  User did not have to hit refresh or anything to receive the updates on the first device.

User naturally wonders what happens if he were to make changes to the same note on *both* devices, at the "same" time.  User starts off with a test note, carefully 
arranges to make different changes to the same line of the note on each device at pretty much the same time.  User sees that sync is not magic, it could not decide which change was the "winner", so, the same several seconds after making both changes, user sees both devices showing a diff-3 style edit conflict in both edit windows.  When the user manually resolves the conflicting changes on one device, s/he sees that the resolved version is now displayed on both devices.

None of this required user to hit "refresh" or do other manual intervention to see the updated note.

## Design Sketches
(These are not literal design specs, they are more a design sketch to be refined between dev and agent in further reviews.)
 
### Sync engine
Sync engine manages all the synchronization capabilities for the plugin.

#### Sync History
From the user's perspective sync history is an opaque and invisible cache that improves performance.
Design of the sync history will be finalized when the sync engine is designed.  
For now, we assume it includes per-file information, is persistent across plugin unload/reload, is stored *outside* the vault, perhaps in IndexedDB,
and cannot usefully be synced between vaults.  
We also assume that individual instances of per-file information are updated atomically, so can be assumed to be self-consistent for a given file.

#### Sync Operations
These are all the ways the sync engine can effect related files based on their status in a local vault "A" and a (remote, cloud-based) group vault "B":

##### No sync history
If there is no local sync history to rely on, we cannot determine whether a missing file ever existed, so we cannot decide to *delete* a file.  
(Add to user doc: when no sync history, and strategy merge or keep both, if 2 files exist, we always create conflict files.  
If use newer, we blindly rely on file modification date).

| status in local vault "A" | status in group vault "B" | operation | additional constraint |
| --------- | ------------------- | ------------------- |  --------- |
| present, no sync history | absent, no sync history | copy A -> B | and vice versa |
| present | present | handle per setting fileConflict |  |

##### With sync history
If there *is* local sync history, we can be confident about knowing the file's status since last sync, and can, e.g, determine a file was recently deleted and replicate the deletion.  We also have access to an unmodified version of the file to use for 3-way diff of text files.

| status in local vault "A" | status in group vault "B" | operation | additional constraint |
| --------- | ------------------- | ------------------- |  --------- |
| modified | absent or unmodified | copy A -> B | |
| absent or unmodified | modified | copy B -> A | |
| deleted | unmodified | delete B | |
| unmodified | deleted | delete A | |
| deleted | modified | resolve per fileConflict (possibly creating placeholder conflict file for delete) | |
| modifed | deleted | resolve per fileConflict (possibly creating placeholder conflict file for delete ) | |
| modified | modified | resolve per fileConflict | |

- "Modified" or "unmodified" mean "... since last known status in sync history"
- "Deleted" means file was recorded as present at some point in the sync history, but is absent now.

##### Conflict handing strategies
When there is a conflict between a local and group file, setting `fileConflict` controls how sync should resolve the conflict.

If the conflict is that one file exists and the other was *deleted*,
create a placeholder with text "Placeholder for deleted file" to stand for the deleted file on that client, then rename the placeholder as above.

Placeholder text doesn't need to be more specific: the conflict filename includes the original file name as a base.

| Strategy | action | 
| -------- | ------ |
| "Use Newer" | Copy file with newer modification time over file with older. |
| "Keep Both" | Rename the conflicing files in each vault as described below |
| "Merge" | If files are text files, do ()[#3-way-merge]. If not text, do "Keep Both" strategy. |

Note on "merge": this strategy is used for plain text and for markdown files.  But it is not used for JSON or YAML files which are text but would be broken by diff-3 markup.  It is also not used for non-text files such as MP3 or PDF files.

Dev note, not spec: Originally had an "ignore", but sync would keep tripping over the conflict and it would never resolve.

If the strategy involves creating conflict files, use this file naming pattern:

When there is a conflict between versions of a file named:
`<name>.<ext>` 
and the resolution strategy is "Keep both", 
each vault's version of the file will be renamed to:
`<name>-conflict-<clientId>-<timestamp>.<ext>`
and it will be propagated as a unique new file to all the other vaults.

where:
- `<clientId>` is the stable client id for this device.  
- `<timestamp>` is the moment that the conflict was detected

Note on clientId: we rely on the plugin to compute a "client id" based on the hostname or a stable guid.  If the plugin is deleted and reinstalled, the "client Id" should stay the same.  By convention the "client id" for the group vault is "group". (which means it's a bad idea to set hostname for a client device to "group")

###### 3-way-merge

When the conflict is resolved by combining 2 modified text files into a single, merged file, use this git-based format:

- use diff3 algorithm, 
- make the overlapping difference regions as small as possible, but always a full line (based on newline delimiter)
- don't use "local" and "remote" for source of difference sections.  Use client IDs which will make sense when the merged file is replicated to any vault
- use an 'x' prefix on the difference section markers, so the section looks ok in markdown.

E.g, 

```text
x<<<<< clientId1
l1
l2
x||||| base
l11
l21
x=====
l infinity
x>>>>> clientId2
```

As elsewhere, if one of the sources is the group vault, use clientId = "group"

#### Bulk Synchronization
Periodically compares *all* the configured files in the local and group vault, looking for syncable additions, deletions and changes in the files.

It is triggered to run when Obsidian is started and the plugin is initialized and then triggered to run again approximately every `bulkSyncPoll` seconds thereafter.  It is not triggered when Obsidian is in the background or obscured, though a previously triggered instance may continue to run in these situations.

Additional considerations:
- can access *all* the files in the vault, hidden or not.
  But the default is to manage all visible files (that is, all user-created content), 
  the vault-share plugin itself and all hidden files other than `.obsidian` (which has device-specific obsidian settings).  
  See setting `excludeRules` for details.
- creates or updates a [sync history](#sync-history) to optimize subsequent processing.
- Gets user confirmation before modifying "too" many files in a single bulk sync pass.
  In each pass, bulk sync determines how many files in the vault are syncable (as configured via setting `excludeRules`) and how many are planned to be 
  created, modified or deleted.  If there are more than `fileModificationConfirmationMin` syncable files in the vault and if the percentage of to-be-modified exceeds setting `fileModificationConfirmationThreshold`, bulk sync displays a confirmation modal and aborts the pass if the user clicks "quit".
- it processes one file synchronization operation at a time, waiting for completion of that one before dispatching another. 
 File sync operations are assumed to be independent of one another, so can be done in any order.
If a network or other error interrupts the current file sync operation, it gives up the current pass and tries again at next regularly scheduled run.  But it does update status bar with an error.
- It lets any queued  [single-file-sync](#single-file-sync) operation run before running the next bulk file sync operation.

#### Single file sync
The sync engine provides a single-file sync capability which performs all of the same sync operations using the same conflict resolution strategies as bulk sync, 
but optimized to run on a file the user has already or wants to open.  When the user is editing the file, it handles pushing the changes to the group vault.

This single-file sync is invoked as soon as a user opens a file and approximately every `openFilePoll` interval thereafter, while the file stays open.

#### Sync Settings

Note on 'setting' column in this and other Settings sections: the symbol in 'settings' column might be a name in the public API, but it is not exposed in the user interface.  Users and user doc refer to settings via Description column.

| Setting | Type / units | Default | Description |
| ------- | ------------ | --------| ------------ |
| excludeRules  | ordered list of (gitignore glob) strings | .obsidian\n!.obsidian/plugins/vault-share | Files and folders to *exclude* from bulk synchronization. See below for details.|
| fileConflict | enum("Use Newer", "Keep Both", "Merge") | "Merge" | What to do with mutually modified files. See [](#conflict-handing-strategies)|
| fileModificationConfirmationThreshold | int / percentage | 10 (percent) | Get user confirmation before letting bulk sync modify or delete <br> more than this percentage of files in a vault |
| fileModificationConfirmationMin | int | 10 | If vault contains fewer than this number of syncable files, do *not* prompt user for confirmation per `fileModificationConfirmationThreshold`. |
| bulkSyncPoll | int / seconds | 60*60 | How often a bulk sync runs while the plugin is active. |
| openFilePoll | int / seconds | 10 | Perform a single file sync on the currently open file this often |
| openFileChangeHoldDown | int / seconds | 5 | Perform a single file sync on the currently open file this many seconds after a local edit |

Note on excludeRules: Based on agent suggestion, the filtering will use ordered ignore rules — a single string[] in settings, one pattern per line, processed top-to-bottom with last-match-wins semantics. A ! prefix negates (re-includes) a pattern.
This is not official gitignore style, in that we do allow reincluding a file whose parent has not been reincluded.

For example, our default is:

```text
.obsidian
!.obsidian/plugins/vault-share
```

This will sync all user files in the vault, but will skip Obsidian config files and plugins, but *will* sync the vault-share plugin (which is designed to be safely sync-able).

Note on fileConflict: See [conflict handling strategies](#conflict-handing-strategies)

#### Sync Statistics
These values are shown in a separate section of plugin settings, but they are read-only statistics and do not affect operation.
They are reset when sync history is cleared (meaning they can be persisted in IndexedDB)

| setting | type  | units | description |
| ------- | ------------ | --------| ------------ |
| APIResponseTime | int | milliseconds | Latency of server API for `file.get` or stat operation | 
| serverClockSkew | int | milliseconds | Last sample of difference between local and cloud server clock |
| bulkSyncPasses | int | | Number of times bulk sync was started |
| singleFileSyncCount | int | | Number of times single-file-sync was initiated |
| filesPushed | int | | Count of group files created or overwritten by local files |
| filesPulled | int | | Count of local files created or overwritten by group files |
| filesMerged | int | | Count of files actually merged (via diff3) |
| contentConflicts | int | | Count of conflicts handled, other than modify-delete conflicts |
| deleteConflicts | int | | Count of modify-delete conflicts handled. |

#### Status Messages 

The sync facility provides these messages in the status bar as it runs:

| event | status bar text |
| ----- | --------------- |
| bulk sync starts | Syncing |
| bulk sync completes | Synced: n downloaded, n uploaded, n deleted |
| bulk sync encounters communication error, can't complete pass | Sync interrupted: \<error\> |
| single file sync completes for an open file | Updated \<openFileName\> |
| single file sync encounters persistent communication error | Interrupted \<openFileName\>: \<error\> |

### Viewing and editing text files
The key user interaction with Obsidian is displaying and editing notes or other files.  
Bulk sync is mostly concerned with improving the odds that a local copy of the file will already be up to date when the user opens it.
Single file sync is focused on ensuring that the user is working with the newest version when s/he opens the file.

#### file viewing

When user opens a file, or the view containing a previously opened file becomes visible, single-file sync runs to do an initial update (if needed).  
As long as the open file is visible, single file sync runs to check for changes on intervals `openFilePoll`.
Polling is cancelled when the user closes the file.

If multiple files are open and visible at the same time, e.g in main and right hand panel, each of them gets this treatment.  But files open in different
tabs of the main panel are not all visible, and the ones not visible are not synced (until they become visible).

The most common situation is that single-file sync finds no group updates for the open view. This should not cause any refresh or interruption in the viewing experience.  If sync *does* find group updates for an open, visible file, it proceeds as follows, 
to avoid creating a jarring viewing or editing experience for the user.

1. the open view is disabled for interaction and a DOM overlay displays a "Syncing..." message
2. the contents of the view are refreshed with new content (or possibly the old file is closed and a renamed conflict file is opened in the same view).
User's previous scroll position in the view is preserved if possible.
3. The "syncing..." overlay is removed and the open view is re-enabled for interaction.

#### file editing

Whenever the user makes a change to the open file, the plugin schedules a single-file sync to occur `openFileChangeHoldDown` seconds later.  (in addition to the `openFilePoll` schedule).
If the user makes more changes before the interval passes, the sync operation is deferred an additional `openFileChangeHoldDown` seconds later.  
If the user kept making changes, this holdDown timer might never trigger a sync.  However, the `openFilePoll` timer is not delayed by file changes,
and will eventually trigger a single file sync.

Whenever it *does* run on an edited file, single-file sync automatically saves the open file to disk, so it has the latest information for merging. 

The sync operation may find conflicting changes in the group vault that must be merged or otherwise combined with the local changes.  If sync created a merged text file, that will be shown in the open view.  If sync created conflict files, 2 things happen:
1. the view is reopened on the new conflict file that was created with the local vault client id. (This file has same content as last edit, but the file name is changed.)
2. User gets a modal popup with just a "dismiss" button, text says "Synced downloaded a conflicting change to the currently open file, the conflicting file is `<conflictFileFromOtherClient>`

This also covers a modify-delete conflict.  
If the group version was deleted, sync will download a conflict file with placeholder text and that's the file named in the dismiss dialog.

### Group Vault name change
When user changes the group vault name in settings, if there is sync history and it's not for the new name,
a confirmation dialog is displayed, text "Changing the group vault will disconnect from \<oldVault\> and require you to connect to \<newVault\>.  Plugin will then merge with \<newVault\>.  Do you want to proceed?". (or words to that effect)
If user clicks "Quit", the group vault name change is reverted.  
If the user clicks "Continue", sync history is cleared, the existing cloud connection is disconnected leaving user at settings page showing "Connect" on the connection button and local files are retained.  When user does connect to another group vault, local and the new group vault will be merged as in [no sync history](#no-sync-history).

### Plugin commands for sync

- "Pause sync" - stops bulk and single-file sync after any currently pending file sync operation completes, until explicitly restarted (next command), or until Obsidian is restarted.
- "Start sync" - clears any pause state and also initiates a bulk sync pass.

## Design issues

### Cloud API Rate limiting
Vault-share plugin should be a well-behaved Google Drive client.  But I don't know what the rules are.

Agent should research community and vendor standard solutions for this and we'll decide on an approach.

### Timestamp and Datetime format
Wherever a file timestamp or other date/time value is used in the UI, it should be displayed in local time (per device OS) as an ISO 8601 string with milliseconds precision but no timezone offset.

E.g 
`2026-05-01T13:12:11.123`

When the date/time is part of a file name, the colons (illegal in some OS filenames) are replaced by hyphens, e.g:
`2026-05-01T13-12-11.123`

### Clock skew monitoring
The plugin samples the file modification timestamp on the first file it creates or modifies in the group vault in each bulk sync pass.
It also samples the server API response time for `file.get` or `stat` operations.  So it can estimate clock skew between the cloud server and local device as:
`<fileModificationReported> - <localDateTimeFileChangeInvoked> - <APIResponseTime>/2.`  The most recent sample is saved in statistic `observedClockSkew`.  

### Heartbeat
single-file sync is run on file open events, but also on a `openFileChangeHoldDown` and `openFilePoll` schedules.
bulk sync is run on plugin initialization, but also on `bulkSyncPoll` schedule.

These schedules should not be managed by scheduling a future Event for each operation; in normal operation of the holdDown timer at least, the event is often cancelled before it can fire, that's unnecessary overhead.  

Instead, all schedules should be managed from a single 1 second heartbeat event.  Each operation is represented by the future datetime that that process should run.
The heartbeat compares current time to the scheduled execution time of the various operations and dispatches it when they are due (or past due).

This gracefully handles catchup when the app is backgrounded or whenever the heartbeat event does not fire:  when the app is once again foregrounded, the next 
heartbeat will discover that deadlines have passed and will initiate all past-due operations.

### Delete Conflict placeholder file
When populating the delete conflict file, we currently use a placeholder.  Does it make sense to recover the file from vault or system wastbasket and resuscitate that content?

## Future directions
(Claude and other agents should ignore text under this heading)
(these are not part of the current spec, but identified here for discussion)
### conflict difference regions syntax
When conflicting versions of a text file are merged, if there is a section which cannot be automatically merged, 
we're left with a difference region that the user must resolve manually.

1. Choose a syntax that's markdown-friendly.
2. How to handle more than one client's proposed new version (assuming the vault version is different too?)
There could be many different versions of that section: the base version (which is the same for all clients, by definition);
the version found in the group vault (also the same for all clients); and a version from each of the clients (worst case, each client made a different change to the same section).
So we need an extended diff3 like format to represent all those versions.

We might have a single file version, or we might have to resort to a directory containing multiple divergent versions and a lot of code to merge from the folder into the new merged successor.

### plugin command to enhance difference region editing
When conflicting versions of a text file are merged and result in visible difference regions (as above), 
consider having the plugin provide a command to streamline the manual resolution process:
1. advances in the currently open note to the start of the next difference region
2. Offers user an option to select which alternative version to adopt, including "just edit" for entirely manual fixup.
3. If user chooses one of the alternatives, command would keep the selected version and delete everything else in the difference region.
