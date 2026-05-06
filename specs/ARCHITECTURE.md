# Project Organization
## History
This project is inspired by "obsidian-air-sync" and related work by Takehito Gondo.  Credit where credit is due.
## Name of the plugin

This project is "Vault Sync".  Prior work focused on the *mechanism* (syncing), but this one is focused on the user *service*.  
The idea of this project is to allow users to *share* an Obsidian Vault, either among multiple devices owned by the same user, or among multiple users (and their multiple devices).
This name is not currently trademarked, but can be copyrighted.

In contexts where Obsidian is implicit, e.g within the Obsidian vault and plugins repo, the name should be spelled "vault-share".
In general contexts (perhaps a folder name in a user's Cloud storage service), the name should be spelled "obsidian-vault-share".

## Vision
Primary goal is to allow users to *share* an Obsidian vault across multiple devices and multiple users.  
All local vaults sync to the same cloud folder structure, 
but sharing should only be limited by the kinds of sharing that the cloud platform supports.

A secondary goal is to provide a backup in the cloud for a *single* vault.
## Components
### Authorization
Oauth2, using google oauth2 desktop credential.  This project includes a proxy service to be deployed as a Github page, to redirect the auth flow back to the app.

### Synchronization engine
Prior work resulted in too much data movement without giving the user best chance to see globally current data.
This project incldes a sync engine that attempts to make better tradeoffs

### Obsidian plugin
It's all integrated into a standard Obsidian framework

### Testing
Designed for testability, both unit tests and end to end tests, some of which are live on the network.

### Logging

The plugin generates a continuous log stream which has configurable filter based on message severity.
By default, the log is written to the javascript console, where it is viewable (on some plaforms) by obsidian-cli.

In addition, the same log stream is written to the right sidebar (via `.ensureSideLeaf()`) when configured by user.  
When active, new messages appear at the bottom of the sidebar and older ones scroll off the top.

#### Settings

| Setting | Type / units | Default | Description |
| ------- | ------------ | --------| ------------ |
| logSeverity | enum {DEBUG,INFO, WARNING, ERROR} | WARNING | severity of log message to display |
| logToSidebar | bool | FALSE | Display recent log messages in new tab in right sidebar |
| logHorizon | int | 1000 | Number of most recent log entries to display in sidebar if enabled. |

### Error and User confirmation popups

- Non-recoverable errors display a modal popup with a "Quit" button.  Clicking Quit causes the plugin to do best-effort cleanup and terminate.
- *Recoverable* errors display a modal popup with a "Continue" and a "Quit" button.  Clicking Continue just closes the modal.  Clicking Quit causes the plugin to do normal cleanup and to terminate.  
- Warnings or unusual successes are simply written to the plugin log at Warning or Info severity and do not generate modals or toasts.
- Situations requiring user confirmation, like recoverable errors, display a modal popup with a "Continue" and "Quit" button. The confirmation only applies to the specific situation being described by the popup.  Clicking "quit" aborts that particular process (not the whole plugin), and clicking "continue" allows it to proceed normally.  For example: the plugin can be configured to ask for confirmation before modifying or deleting "too many" files in a synchronization pass.  Clicking Quit aborts the synchronization pass without modifying them; clicking Continue allows the files to be modified.

### User awareness via Status Bar

Rather than display distracting toasts, Vault Share displays routine informational messages in the status bar.  
These are concise and remain in the status bar till replaced by another.

Events causing a status bar message generally also produce a detailed Info log entry.
