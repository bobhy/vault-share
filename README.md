# Vault Share

Share your Obsidian vault across multiple devices, synced through a shared folder Google Drive (the so-called "group" vault).

This plugin was inspired by [obsidian-air-sync](https://github.com/takezoh/obsidian-air-sync) by Takehito Gondo (and Claude).

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

## Initial setup

1. Install `vault-share` from Obsidian Community Plugins into a new or existing local Obsidian vault.
2. In Settings, (review the settings for "Drive folder path" and "Conflict resolution"), 
   then click the "Google Drive connection" connect button.  
    a. This will open up the (OAuth2) "Sign in with Google" tab in your browser.  Click on a Google account to use.
    b. In the "...Wants to access your Google Account", click Continue.

Once you complete this process on a given device, your local vault will remain connected to Google Drive even if you close and re-open Obsidian or update the plugin.

The first time the plugin connects to the group vault, it synchronizes any same-named files as configured by the [synchronization settings](#synchronization), but it simply pulls from the group vault any files it finds there that don't exist in the local vault and pushes to the group vault any local files it doesn't see in the group.  No files are ever deleted on that first sync.  And it caches a sync history for subsequent use.  

The sync history helps the plugin determine, e.g that a file was once present so it should be deleted in other vaults.  The sync history also provides the common base version of a text file to perform the diff3 merge operation.

Consider *disabling* the core plugin (Obsidian) `sync`.  It shows an icon in the status bar that could be confusing.

## Settings

TBD
 
## Troubleshooting
Synchronization can be tricky to debug; file names can be changed (due to conflicts), things are happening in multiple places at once and 
the action is, by design, mostly happening offstage.  

If you run into a problem, raise an [issue](https://github.com/bobhy/vault-share/issues)  

Please try to describe a simple and reliable way for someone else to reproduce your problem.  

Do include a DEBUG log (using the elegant and sophisticated logging features included in the plugin -- see "Log" section in settings!)
