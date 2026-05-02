# Synchronization feature
Provides synchronization between each local Obsidian vault and a designated cloud folder (herinafter called the "group vault").
Synchronization means all vaults (local and group) have the same subfolder structure and all files have the same content.

## Open questions
1. How to handle multi-client overlapping difference sections (text files only), if there are `> 1` conflicting edits?<br>
As long as we assume only one user at a time, we can support as many devices as we like.  But as soon as there can be 2-3 users active "at the same time", our 3-way merge fails to consider all the overlapping updates.  You could have: 1. the last common base; 2. the vault version (same as one of the user versions); 3. local client 1 version; 4. local client 2 version;
If each user makes a non-overlapping edit, the vault version will (eventually) reflect them all.

For now, document the limitation.
For the future consider a fancy way to handle this (maybe  a folder with each devices 3-way diff?)
## Goals
- Supports a single user having local copies of the vault on multiple devices
- Supports multiple users having copies of the same vault as well, given that one user creates the group vault
  then shares it with other users using native cloud sharing.
- Minimize network traffic and load on the cloud service, 
    - however, spend bandwidth to prioritize tracking changes to files that any client currently has open.
    - cache synchronization status locally to minimize traffic and resources in future operations.
- Change tracking for open files is not intended to be a full-fledged "collaborative edit" capability where multiple clients are editing the same file at the same time.  But it is intended to work very well for the typical case of a single user who uses Obsidian on one device then on another 
and wants to see the most recent changes from one device as soon as s/he opens Obsidian on another.

## Assumptions
- If a file or folder name matches, we assume users intended them to represent the same thing (plus or minus the latest updates).  So we'll rely on file name matching.
- We won't  assume tight clock synchronization between remote and local vault.  We'll monitor clock skew (somehow) and, if it's "too big", warn the user if s/he's about to depend on it for conflict resolution.
- A given local vault can only be connected to one group vault (at a time).
- We won't take a strong dependency on cloud provider facilities that support collaborative edit, i.e, that allow multiple users to work on different (or even the same!) sections of a file at the same time.  For now, we'll read and write whole files when we detect changes.  We will try to use atomic read or write operations, where available.

## Key Scenarios
These scenarios include a high level description of the operation of (the synchronization feature) of the plugin, 
at least so far as the user can see.  Actual design should treat these descriptions as binding constraints on the design, howeved the requirements can be negotiated if a much better design could be realized by modifying the scenario descriptions.

### Connecting to a group vault

When the plugin is loaded it will attempt to connect to and synchronize with the configured group vault.  

This is a "bulk" synchronization, checking all files in both vaults to establish a baseline.
It proceeds at a lower priority so it does not preempt interactive operations.  It updates a status line as it runs so the user can be aware.

This first synchronization may involve manual intervention and may take more effort depending on presence of sync  history saved from previous plugin sessions.  This first run leaves behind a sync history that is used by all subsequent sync operations.

#### Initial bulk synchronization without sync history

When the (synchronization feature of the) local vault has no memory of having connected to this particular group vault, 
it checks these conditions in order:
- if local vault has no files outside of .obsidian, that is, has no user content, then it accepts whatever is present in the group vault (which also might have no user files either). No user guidance necessary.
- otherwise (local vault does have some user content), if group vault is empty, push all configured local content to the group vault.  Again, no user guidance is necessary.
- otherwise (some user content in both local and group), use a selected conflict resolution strategy (as specified below).
  The user may be prompted to make case-by-case resolution decisions.

#### Initial bulk synchronization *with* sync history

When local vault *does* have a memory of previous connection to this group vault, it will use this information to proceed more efficiently.  From the user's perspective, the sync history allows the bulk synchronization to 
avoid uploading or downloading vault files
and may reduce manual resolution decisions as well.

### Background synchronization
Once connected and having completed the first bulk synchronization, the plugin will repeat the bulk synchronization periodically, as long as the plugin is loaded and active.

There are configuration settings that manage the frequency of bulk synchronization.

### Tracking changes to currently open file(s)
The synchronization feature prioritizes keeping open files in sync across all devices.  
This involves relatively frequent updates to the remote vault as any user makes edits, 
and potential "Updating" messages during edit sessions. 

When a user opens a file in the local vault:
1. Synchronization facility checks whether the remote vault has updated that file since last known use.  
   If the group vault is not connected, skip to step 3
2. If the remote file has been updated, the file window displays a "Synchronizing" or "Updating" overlay while the changes are downloaded and reconciled, so the user's first real interaction is with newest content.  This may include marked difference regions if using 3-way diff.  If it's taking "too" long, the user can interrupt the Updating overlay and gain full access to the file by (doing something, but what?  Type some "interrupt" character, like ^C?  Run a command from the command pallette? TBD)
3. When the open file is *modified* (either by direct user edit or by some plugin or other Obsidian operation), the synchronization facility starts "rapidly" sending changes to the group vault (so other users can see those changes "quickly") and also checking "rapidly" for changes that some other user might be making simultaneously.  
If remote changes to the currently open file are detected, they will be handled as described in step 2.
There are configuration settings that manage how rapidly changes to open files are tracked.
If the remote vault is not connected, changes are buffered until they can eventually be synced.

Change tracking updates and relies on the same sync history as bulk syncronization.

## Deliverables
### Main class -- `VaultSync`
This is the main library class which supports synchronization for the plugin. 

### Test Infrastructure

## Design issues

### Clock skew monitoring
A background process runs to monitor the difference between cloud server system clock and local device.
If the difference exceeds setting `tolerableClockSkew` when VaultSync is creating or modifying files in the remote vault, user receives a notification informing of the actual value and warning that the files were correctly written but future sync operations may trigger incorrectly because of this.

### Sync history
- Each instance of the plugin (on each device) has its own sync history, relating its local files to the remote vault.  It's not globally shared in the remote vault.
- mostly per-file, but should also track some aggregate performance statistics
- represents state at the completion of the last successful sync operation.  This is the last known "common base" for comparison.
- includes comparable file metadata such as last modified date time, hash of contents.  In some cases, will include complete file contents as well.

### per-file synchronization 
When looking at corresponding files, the synchronization action can be one of:
- Overwrite Local, Overwrite Remote
  One file has been modifed since last sync (that is, the last sync of that particular file), the other is unmodified.  
  Overwrite the unmodified file with the (latest version of) the modified file.
- Delete Local, Delete Remote
  One file was present at last sync, is now missing from one vault and is unmodified from last sync in the other.
  Delete the file from the unmodified vault. (and record the deletion and modifed time of the deleted file in sync history)
- Conflict - merge via 3-way diff
  Both files have changed since last sync.
  Both files are text files of some sort.
  Merge via 3-way diff, producing minimalized overlapping difference regions.
  Merged file is propagated back to vault on next bulk sync (TODO: check this is true!)
  When user manually resolves, fixed file is also propagated back to vault and distributed to other devices (TODO: check this!)
- Conflict - can't merge as text, produce multiple alternatives
  Both files have changed since last sync, and are *not* text files.
  TODO: figure out how to handle.

### Settings

These setting map to settable properties of classes in this module.  When the setting changes, the new value
is used the next time the referencing code runs.

In section Synchronization 

| setting | type / units | default | description |
| ------- | ------------ | --------| ------------ |


Advanced settings

| setting | type / units | default | description |
| ------- | ------------ | --------| ------------ |
| tolerableClockSkew | int / ms | 1000 | When changing files on the server, user is warned if server clock differs from local device system clock by more than this amount |


### Status Messages 

These events produce status messages

| event | status bar text |
| ----- | --------------- |
| initial sync starting - empty local vault |  Initializing local from group vault |
| initial sync starting - empty group vault | Initializing group vault from local |
| completion of bulk sync | Sync: X local changed, Y group changed |



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
```

### plugin command to enhance difference region editing
When conflicting versions of a text file are merged and result in visible difference regions (as above), 
consider having the plugin provide a command to streamline the manual resolution process:
1. advances in the currently open note to the start of the next difference region
2. Offers user an option to select which alternative version to adopt, including "just edit" for entirely manual fixup.
3. If user chooses one of the alternatives, command would keep the selected version and delete everything else in the difference region.