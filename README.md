# Vault Share

Share your Obsidian vault with other devices or other users, synced through a shared folder Google Drive.

The sharing is multi-master - any device can alter any file and the changes will be progagated to all other devices (eventually).
Multiple devices can edit the same file at the same time, with the conflicts resolved via 3-way diff for Markdown and other plain text files.
Other file types either choose the most recently updated version or keep multiple versions of conflicting files.

Each device is eager to inform the shared folder of local changes, but is (configurably) lazy about retrieving changes made elsewhere, 
except for the file the local user is currently viewing.

> **Requires a Google account.** This plugin communicates with Google Drive API (`googleapis.com`) for file sync and with an auth server (`vault-share.bobhy.dev`) for OAuth token exchange. No vault data is sent to the auth server — it only handles authentication tokens. Custom OAuth lets you manage authorization independently.

This plugin was inspired by [obsidian-air-sync](https://github.com/takezoh/obsidian-air-sync) by Takehito Gondo (and Claude).


