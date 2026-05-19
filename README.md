# Vault Share

Share all or part of an Obsidian vault with multiple devices via Google Drive.

Changes on one device are uploaded quickly, but are shared to other devices lazily or on demand.  This conserves network bandwidth while
ensuring you'll see the latest version of a file when you open it, wherever you choose to open it (and have a cloud backup of the vault, to boot).

This plugin was inspired by [obsidian-air-sync](https://github.com/takezoh/obsidian-air-sync) by Takehito Gondo (and Claude).

## Initial setup

1. Install `vault-share` from Obsidian Community Plugins into a new or existing local Obsidian vault.
2. In plugin settings, 
  a. Review "Drive folder path".  This is the folder that will mirror your vault in Google Drive.  The plugin will create the folder on first use.
  b. Review "Conflict resolution".  The default is "Merge", and should be useful for most users.
  c. Click the "Login" button in "Google Drive account".  
    1. This will open up the (OAuth2) "Sign in with Google" tab in your browser.  Click on a Google account to use.
    2. In the "...Wants to access your Google Account", click Continue.
3. At this point, an initial full share operation will start running in the background to copy your vault to the cloud.  
   If other devices have already started using it, the plugin will also copy cloud files to your local vault.

Once you log in, the plugin will remain authenticated to Google Drive across Obsidian sessions until you log out or reset the plugin (at the bottom of settings page).

We recommend disabling the core Obsidian sync plugin: it displays a "Sync" icon in the status bar that could be confusing.

## How sharing works 

The core function of the plugin is to share changes made in a local Obsidian vault with the shared folder in Google Drive, the so-called "group" vault. 
Whenever it runs, the sharing operation checks for recent changes in both vaults and ensures the file is updated in both places.

The "update" operation can:
1. Actually update (overwrite) an older, unmodified file in one vault with the latest version from the other vault.
2. Handle files which have changed in *both* the local and group vault since the last sharing operation.  
You have options, configured in "Conflict resolution" in Settings:
  a. Keep the newer file, or keep *both* files in both vaults.  
  For "newer", comparison is based on last modification timestamp of each file.  For "both", both files are renamed to include the source vault they came from.  
  After reviewing them, you should delete one and rename the other back to its original name to resolve the conflict.
  b. (An additional option, for .txt and .md files only) Merge changes from each into a combined new version.  
  This is a 3-way diff, comparing both changed files with the last common base.
  If both files changed the same line(s), the merged file will contain "conflict" markers and you must manually edit it to resolve the conflict.  
  The resolved file is then updated in the other vault.
3. Delete a file in one vault when you have manually deleted it from the other.  
This works both ways!  If you manually delete a file on *any* device, that deletion is propagated to the group vault and then all of the other devices will delete that file from their local vault at their next opportunity.

The above rules apply when the plugin has a cached history of prior sharing operations.  The history is saved in IndexDB, not in the local vault, so you can't see it.  It is retained across login/logout to the same group vault.  But you can reset it and start from scratch by clicking the "Plugin Reset" button in Settings.

When the plugin logs in to a group vault for the first time, it has no history of sharing with that vault and 
cannot determine whether an older file is in fact unmodified as for rule 1 above, 
or whether it was manually deleted as for rule 3, so the initial sharing operation will only:
1. Copy missing files from one vault to the other.  
That is, if a file is present in one vault and not present in the other, it will be copied into the other vault. 
It is not presumed to have been *deleted* from the other: without history, we can't tell.
2. Treat both-present files as a conflict and resolve per settings and file type.  

This can get ugly if the group vault is similar to, but not an exact replica of the local vault.  
You could end up with lots of conflict file pairs or merged text files to resolve by hand.  

For this reason, we recommend that you do first-time sharing only with a group vault that is empty or is one you recently logged out of and is likely to be very similar o your local vault.  To reduce the risk of unintended conflicts, the plugin will prompt for manual confirmation if any bulk share operation would change more that 10% of the files.

### Timing of share operations

There's a background "bulk" operation, which scans all local files and all group files looking for changes.  
This runs when you first open Obsidian, or manually by the "Vault Share: Start or Resume Sharing" plugin command, or hourly in the background, 
but only when Obsidian running.
On mobile, Obsidian is suspended when the screen is locked, so it spends most of its time not running.  
The bulk operation will catch up when Obsidian is brought back to the foreground and pick up where it left off.

There's also a foreground "single-file" operation which operates only on files that you open for viewing or editing in a tab.  
It runs once when you first open the file, to check for recent changes in the group vault.
It runs again while you're *editing* the file (or otherwise making changes to it), whenever you pause typing for a few seconds.  
This shares your most recent changes with the group vault but also picks up any changes from the group vault and refreshes your edit window.

If you're just one person using one device at a time, this is enough to ensure that you'll always see the most current version of a file no matter which device you pick up.
But if there are multiple people making changes to the file at the same time on different devices and you're not actively editing the file yourself, 
you can enable "monitor" mode (a plugin command, also in the right-click context menu of the view tab).  
This refreshes your view every few seconds to pick up changes from group vault.

All these timers are configurable in settings.

## Google Drive authentication and usage

1. This plugin **requires a Google account.** for access to Google Drive.  
2. When you first log the plugin in to Google Drive, you'll see an OAuth screen in your browser and you can select the Google account to use.  
3. The plugin has full read and write access to  Google Drive, but only to files created by this or some other instance of the plugin connected to the selected user's Google Drive.  
  The plugin will *not* see or be able to access any files you manually put into the group vault folder (e.g, by the Google Drive app).  
However, if you manually *delete* a file from the group vault folder, the corresponding local file *will* be deleted from your local vault.
4. To facilitate the authentication with Google Drive, this plugin depends on an auth server (`vault-share.bobhy.dev`).  
The auth server handles OAuth authentication tokens, but is not involved in the Google Drive API and never sees vault data.  
The auth server is owned and operated by the plugin maintainer, deployed as a Cloud Worker on Cloudflare.  
You are taking a dependency on these third parties for continued functioning of the plugin.

## Settings
* Connection section
  * Drive folder path
  Folder in Google Drive to use as the group vault folder.  Default for a local vault named `<localVault>`, is `/vault-share/<localVault>`.  
  You can specify any path you like, but you must let the plugin (or some other instance of this plugin) create the folder.  The plugin has *no* access to files and folders that it did not create, per Google Drive API security rules.
* Conflict resolution  
  Separate handling for text and markdown file types and for others
  * For most files  
  Applies to files other than `.txt`. and `.md`.  Default is "Keep both" (to avoid losing data by default).  Options are:
    * Keep Both (default)  
    Rename a file `<baseName>` to  `<baseName>-conflict-<timestamp>-<device>`, so both files can coexist in the vault.
    * Keep newer  
    Only keep the file with newer modification timestamp
  * For text files (`.md, .txt`)
    * Merge (default)  
    Combine changes in both files into a single merged file. Where one file changed and the other didn't simply insert the change.  
    Where *both* files changed, insert conflict markers to highlight the alternavie lines.
    * "Keep both" and "Keep newer" as above.
* Sharing
  Options to manage file sharing
  * Exclude rules  
  Directories and files to *exclude* from sharing.  
  Specify glob-style patterns, one per line. To *include* a subdirectory whose parent was
  *excluded*, prefix it with a `!`.
  * Sharing interval
    How often the bulk share operation runs in the background. Default, 1 hour.
  * Open file poll interval  
    How often an open file is checked for group folder changes, but only when monitor mode is enabled for an open file.  Default is 10 seconds.
  * Edit holddown  
  How long to wait after the last kestroke before sharing an edited file.  Default is 5 seconds.
* Logging
  * Log Level  
    Minimum severity of messages to write to log: DEBUG, INFO, WARNING, ERROR, default WARNING
  * Show log in sidebar  
    Enable to display log in right hand sidebar of Obsidian window.  This tab can be undocked to a separate window.  This is a scrolling view of the last `Log history size` entries.
    Log is always written to the javascript console, visible when you type Ctrl-Shift-I in Obsidian window.
  * Log history size  
    Number of most recent log entries to retain in the sidebar view  
* Statistics
  Counts of plugin activity.
  * Reset statistics button  
    Click this to zero all the counters.  Does not affect plugin operation. 
* Plugin
  * Reset plugin button  
    Logs out of the cloud service and clears local share history and statistics.  Does not delete any vault files.

The Connection section lets you set the Google Drive folder path where vault files are shared (e.g. /vault-share/my-vault) and log in or out of your Google account. 

The Sharing section controls behaviour: 

the Conflict resolution settings determine what happens when the same file has been changed in two vaults — for most files you choose between keeping both versions (renamed with a timestamp) or keeping the newer one; for text files (.md, .txt) you can additionally choose a 3-way merge that combines changes inline. 

Exclude rules let you filter which files are shared, one glob-style rule per line (prefix ! to re-include). Sharing interval and Edit holddown control how often background sharing runs and how long to wait after a keystroke before sharing an open file. The Logging section controls log verbosity and whether recent log entries appear in a right-sidebar panel. The Statistics section shows counters for sharing activity and conflicts since the last reset. Finally, Reset plugin logs you out and clears all local share history, useful for starting fresh without deleting vault files.

TBD
 
## Troubleshooting
Synchronization can be tricky to debug; file names can be changed (due to conflicts), things are happening in multiple places at once and 
the action is, by design, mostly happening offstage.  

If you run into a problem, raise an [issue](https://github.com/bobhy/vault-share/issues)  

Please try to describe a simple and reliable way for someone else to reproduce your problem.  

Do include a DEBUG log (using the elegant and sophisticated logging features included in the plugin -- see "Log" section in settings!)
