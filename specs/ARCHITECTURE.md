# Project Organization
## History
This project is inspired by "obsidian-air-sync" and related work by Takehito Gondo.  Credit where credit is due.
## Name of the plugin

This project is "Vault Sync".  Prior work focused on the *mechanism* (syncing), but this one is focused on the user *service*.  
The idea of this project is to allow users to *share* an Obsidian Vault, either among multiple devices owned by the same user, or among multiple users (and their multiple devices).
This name is not currently trademarked, but can be copyrighted.

In contexts where Obsidian is implicit, e.g within the Obsidian vault and plugins repo, the name should be spelled "vault-sync".
In general contexts (perhaps a folder name in a user's Cloud storage service), the name should be spelled "obsidian-vault-sync".

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

In addition, the same log stream is written to a circular buffer which can be displayed in the right sidebar (via `.ensureSideLeaf()`) when configured by user.  When active, new messages appear at the bottom of the sidebar and old ones scroll off the top.

Logging has these settings:

In Setting section "Logging":

| setting | type / units | default | description |
| ------- | ------------ | --------| ------------ |
| Log Severity | enum (Error,Warning,Info, Debug) | Warning | Don't log messages with lesser severity |
| Log to Sidebar | bool | false | Display log in sidebar |
| Sidebar buffer | int / messages | 100 | Max number of log messages to display in sidebar |

### Error handling
- Non-recoverable errors display a modal popup with a "Quit" button.  Clicking Quit causes the plugin to do best-effort cleanup and terminate.
- *Recoverable* errors display a modal popup with a "Continue" and a "Quit" button.  Clicking Continue just closes the modal.  Clicking Quit causes the plugin to do normal cleanup and to terminate.  
- Warnings or unusual successes are simply written to the plugin log at Warning or 

### Status Bar

Rather than display distracting toasts, Vault Share displays routine informational messages in the status bar.  
These are concise and remain in the status bar till replaced by another.

Events causing a status bar message can also produce a more detailed Info log entry.
