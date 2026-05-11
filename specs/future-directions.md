# Future Directions
(Agents should ignore this file, it is not a spec.  It's the developer's scratchpad for potential plugin enhancements)

- Consider caching all settings in IndexDB, keyed on vault name, to make reinstall totally seamless
  Defaults for settings are mostly static constants and are used to initialize when When settings.json is deleted (e.g by plugin reinstall).
  There's already special code to dynamically initialize folder to the current local vault name.  This allows sync history and cloud connection to be reused after reinstall (so long as user was using vault name from group vault name).
  If the goal is to make reinstall really seamless, however, this isn't perfect.  Other important settings might be wrong for continued use of the vault: conflict resolution, exclude rules...
  Maybe copy *all* the settings to someplace keyed by actual vault name?  Then settings would save/restore thence and `settings.json` would be the cached echo, essentially meaningless.
  But maybe trying to do totally seamless reinstall is a bridge to far?
  Alternative isto have plugin reinstall also zap sync history and connection tokens (in machine local storage) so you get a consistent starting place.  Yes, next sync is a vault merge, but that shouldn't actually change much if the vaults were previously in sync.
- review PR for obsidian-mock; what's the purpose of duplicated implementations?
- rethink implementation of perfilestate in scheduler: multiple deadlines now, vs calculate next deadline when last one fires?