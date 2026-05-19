# Future Directions
(Agents should ignore this file, it is not a spec.  It's the developer's scratchpad for potential plugin enhancements)

- Consider caching all settings in IndexDB, keyed on vault name, to make reinstall totally seamless
  Defaults for settings are mostly static constants and are used to initialize when When settings.json is deleted (e.g by plugin reinstall).
  There's already special code to dynamically initialize folder to the current local vault name.  This allows sync history and cloud connection to be reused after reinstall (so long as user was using vault name from group vault name).
  If the goal is to make reinstall really seamless, however, this isn't perfect.  Other important settings might be wrong for continued use of the vault: conflict resolution, exclude rules...
  Maybe copy *all* the settings to someplace keyed by actual vault name?  Then settings would save/restore thence and `settings.json` would be the cached echo, essentially meaningless.
  But maybe trying to do totally seamless reinstall is a bridge to far?
  Alternative isto have plugin reinstall also zap sync history and connection tokens (in machine local storage) so you get a consistent starting place.  Yes, next sync is a vault merge, but that shouldn't actually change much if the vaults were previously in sync.
- **Reactive single-file sync on vault.on('modify')**
  Background: plugins like [Tasks](https://community.obsidian.md/plugins/obsidian-tasks-plugin) modify files that are not the currently open note (e.g. checking off a task in a daily-note task query updates the source file). Those changes don't reach the group vault until the next scheduled bulk share.
  Idea: subscribe to `vault.on('modify', (file) => ...)` to detect any file change — including ones caused by other plugins — and immediately trigger a single-file sync for that file, the same way an explicit save/edit triggers one for the active file.
  Considerations: rate-limit or debounce to avoid a burst of syncs during a bulk operation; distinguish vault-share's own writes (to avoid re-syncing files it just downloaded); respect the exclude-rules list.
  Safety net: since events can be missed (plugin not loaded, crash), occasionally run a full local enumeration to reconcile — similar to how the Changes API idea below uses a periodic full walk as a backstop.
- **Use Google Drive Changes API to make bulk-share cost proportional to changes, not vault size**
  Currently `driveFs.listAll()` does a full recursive walk of the group vault folder on every bulk share, fetching every file's metadata regardless of whether it changed. For large vaults this is wasteful.
  Google Drive's [Changes API](https://developers.google.com/drive/api/reference/rest/v3/changes) provides a delta feed: after each sync, save the `startPageToken` Drive returns; on the next bulk share, call `drive.changes.list?pageToken=<saved>` to get only files added/modified/deleted since that checkpoint. This makes the remote-enumeration step O(changes) instead of O(vault size).
  Note: the Changes API covers the whole Drive, so filter results to the group vault folder. Also covers deletions (unlike a simple `modifiedTime >` filter on the existing query).
  Local-side: similarly, Obsidian's `vault.on('modify/create/delete')` events could maintain a local dirty-set between bulk runs, so local enumeration is also delta-based.
  Safety net: Drive Changes tokens can be invalidated or events dropped if the plugin was offline. Schedule an occasional full walk (e.g. once a day or on plugin startup after a long absence) to catch anything missed and reset the token.
- review PR for obsidian-mock; what's the purpose of duplicated implementations?
- rethink implementation of perfilestate in scheduler: multiple deadlines now, vs calculate next deadline when last one fires?
