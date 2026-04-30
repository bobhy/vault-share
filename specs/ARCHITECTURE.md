# Project Organization
## History
This project is inspired by "obsidian-air-sync" and related work by Takehito Gondo.  Credit where credit is due.
## Naming

This project is "Vault Sync".  Prior work focused on the *mechanism* (syncing), but this one is focused on the user *service*.  
The idea of this project is to allow users to *share* an Obsidian Vault, either among multiple devices owned by the same user, or among multiple users (and their multiple devices).
This name is not currently trademarked, but can be copyrighted.

In contexts where Obsidian is implicit, e.g within the Obsidian vault and plugins repo, the name should be spelled "vault-sync".
In general contexts (perhaps a folder name in a user's Cloud storage service), the name should be spelled "obsidian-vault-sync".

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
