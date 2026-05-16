# Vault Share

Share your Obsidian vault with all your devices, synced through Google Drive.
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
3. At this point, an initial sync operation will start running in the background to copy your vault to the cloud.  
   If other devices have already started using it, the plugin will also copy cloud files to your local vault.

Once you log in, the plugin will remain authenticated to Google Drive across Obsidian sessions until you log out or reset the plugin (at the bottom of settings page).

## How sharing works 

The core function of the plugin is to share changes made in a local Obsidian vault with the shared folder in Google Drive, the so-called "group" vault. 
Whenever it runs, the sharing operation checks for recent changes in both vaults and ensures the file is left updated in both places.

The "update" operation can:
1. Update (overwrite) an older, unmodified file in one vault with the latest version from the other vault.
2. Handle files which have changed in *both* the local and group vault since the last sharing operation.  You have options, configured in "Conflict resolution" in Settings:
  a. (for plaintext files, like markdown notes) Merge changes into a new version in both vaults.  
  This is a 3-way diff, comparing both changed files with the last common base.
  If both files changed the same line(s), you must manually edit the file to resolve the conflict.
  b. (for non-mergable files, such as JPG or PDF), keep the newer file, or keep *both* files in both vaults.  
  For "newer", comparison is based on last modification timestamp of each file.  For "both", both files are renamed to include which vault they came from.  
  After reviewing both, you should delete one and rename the other back to its original name to resolve the conflict.
3. Delete a file in one vault when you have manually deleted it from the other.  This works both ways!  If you manually delete a file on *any* device, that deletion is propagated to the group vault and then all of the other devices will delete that file from their local vault at their next opportunity.

The default setting for "Conflict resolution" is "Merge", which will
The above rules apply when the plugin has a cached history of prior sharing operations.  The history is saved in IndexDB, not in the local vault, so you can't see it.  It is retained across login/logout to the same group vault.  But you can reset it and start from scratch by clicking the "Plugin Reset" button in Settings.

When the plugin logs in to a group vault for the first time, it has no history of sharing with that vault and 
cannot determine whether an older file is in fact unmodified as for rule 1 above, 
or was manually deleted as for rule 3, so the initial sharing operation will only:
1. Pro


There's a background "bulk" operation, which scans all local files and all group files looking for changes.  This runs hourly, but only when Obsidian is running. 
On mobile, Obsidian is suspended when the screen is locked, so it spends most of its time not running, and the bulk operation picks up where it was suspended 
as soon as Obsidian is brought into the foreground.
And there's a foreground "single-file" operation which runs on files that you open in a tab.  
It runs once when you first open the file to check for recent changes in the group vault.
While you're *editing* the file (or otherwise making changes to it), it runs a few seconds after you stop typing or making other changes to upload your most recent changes 
to the group vault.  
If you're just one person using one device at a time, this is enough to ensure that you'll always see the most current version of a file no matter which device you pick up.
But if there are multiple people making changes to the file at the same time on different devices, there's a plugin command to enable a "monitor" mode for the open view 
which checks the group vault every few seconds for changes from other devices even if you're not making changes to that file yourself.
All these timers are configurable in settings.

The sharing operation works by comparing a local file with the corresponding file in the group vault (considering any saved history of previous operations).
It can decide to:
1. add a missing file to the place it's missing from
2. update a recently changed file in the 
2. delete a file recently deleted in one vault in the other
3.  and with any saved synchronization history it may have cached from a previous run.  Normally, there is a saved history and the normal When This operation can:
1. decide the file is npresent in one place and absent in the other, | copy the 

| 
1. 
There is a 

The first time the plugin connects to the group vault, it synchronizes any same-named files as configured by the [synchronization settings](#synchronization), but it simply pulls from the group vault any files it finds there that don't exist in the local vault and pushes to the group vault any local files it doesn't see in the group.  No files are ever deleted on that first sync.  And it caches a sync history for subsequent use.  

The sync history helps the plugin determine, e.g that a file was once present so it should be deleted in other vaults.  The sync history also provides the common base version of a text file to perform the diff3 merge operation.

Consider *disabling* the core plugin (Obsidian) `sync`.  It shows an icon in the status bar that could be confusing.
## Google Drive authentication and usage

1. **Requires a Google account.** for access to Google Drive.  
The group vault folder is located in My Drive for this Google account.
2. When you first connect the plugin to Google Drive, you'll see an OAuth screen in your browser and you can select the Google account to use.  
Once the plugin is connected, it will stay connected across restarts of Obsidian.  
3. The plugin has full read and write access to  Google Drive, but only to files created by this or some other instance of the plugin connected to this user's Google Drive.   If you manually create other files in the group vault folder (e.g, by the Google Drive web site), the plugin will *not* see or be able to access it. 
However, if you manually *delete* a file within the group vault on Drive, the corresponding local file *will* be deleted from your local vault.
4. To facilitate the authentication with Google Drive, this plugin depends on an auth server (`vault-share.bobhy.dev`).  
The auth server handles OAuth authentication tokens, but is not involved in the Google Drive API and never sees vault data.  
The auth server is owned and operated by the plugin maintainer, deployed as a Cloud Worker on Cloudflare.  You are taking a dependency on these third parties for continued functioning of the plugin.

## Features
- Multi-master sharing
  Any device can alter any file and the changes will be progagated to all other devices (sooner or later).
- Low latency, resource-efficient synchronization
  The plugin is quick to push local changes to the group vault, but is slow to pull changes from other devices in the group.  
  However, it does pull group changes for a file when you open it locally.
  If you anticipate that someone might be editing that file on some other device in the group, 
  you can enable a "monitor" mode for the file to continue checking for group changes while the file remains open.
- Options for resolving conflicting changes made elsewhere in the group, including diff3 merging for markdown and other text files.



## Settings

TBD
 
## Troubleshooting
Synchronization can be tricky to debug; file names can be changed (due to conflicts), things are happening in multiple places at once and 
the action is, by design, mostly happening offstage.  

If you run into a problem, raise an [issue](https://github.com/bobhy/vault-share/issues)  

Please try to describe a simple and reliable way for someone else to reproduce your problem.  

Do include a DEBUG log (using the elegant and sophisticated logging features included in the plugin -- see "Log" section in settings!)
