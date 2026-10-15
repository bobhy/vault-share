# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [unreleased]

### Changed
- Development: e2e tests now run on current Node releases (verified on Node 22, 24 and 26) instead of being pinned to Node 22.  Removed `.nvmrc` and the Node-version check in the wdio configs; CI now uses the current Node LTS.
- Development: upgraded the WebdriverIO e2e stack to 9.32 (`webdriver`/`webdriverio` 9.27.1 → 9.32.0, `expect-webdriverio` 5 → 6) and `wdio-obsidian-service` to 3.3.0.  WebdriverIO 9.30 fixed the Node 26 `UND_ERR_INVALID_ARG` failure ([webdriverio#15265](https://github.com/webdriverio/webdriverio/issues/15265)).
- Updated runtime and development dependencies via Dependabot (#20): 14 minor and patch updates, including `undici`, `tar`, `ws` and `postcss`.
- Security: `vitest` and its coverage packages 4.1.8 → 4.1.12 (fixes the `@vitest/mocker` path-traversal advisory), and `moment` (pulled in by the `obsidian` typings package) overridden to 2.31.0.  None of these ship in the plugin bundle.

No user-facing changes to the plugin itself in this release.

## [1.0.6]

### Changed 
- Consolidated sharing log and sharing status panels to a single panel.  Allows you to see the log activity when you pause or resume sharing, e.g.
- each file modified by sharing is now logged at INFO rather than DEBUG severity.  So INFO is a reasonable setting for logging filter.
- Sharing status panel is much cheaper to keep open during a big sharing pass: a new log line now re-renders only the log section, not the whole panel (status line, controls and pending table).
- In the pending-file review, collapsing and re-expanding a file keeps its preview (and any edits in the merge text box) instead of re-downloading it.  The "Loading…" placeholder now actually shows while the preview loads.
- Conflict merge preview fetches the local, group vault and last-shared copies in parallel, so it opens faster.
- Internal cleanup of the UI code (no intended functional change beyond the items above): removed duplicated helpers and state, shared the file-read and error-message helpers with the sync layer, and converted repetitive unit tests to table-driven cases.
- `npm run build` now also type-checks the e2e (wdio) tests.

### Added
- do single-file sharing for *any* file modified or created in the local vault, not just a file open for editing.  Previously, non-edit file changes (e.g, the Tasks plugin updating a task status in the the original note) would not be shared until the next bulk sharing cycle and other devices would lag in tracking the change.

### Fixed
- Conflicts on text files other than `.md` / `.txt` (e.g. `.json`, `.yaml`, `.css`) offered a **Merge** button that could never succeed ("File content not loaded yet").  They now offer **Keep local** / **Keep group vault** / **Delete both**, matching what sharing itself does with those files.

## [1.0.5]

### Added
- Updated `obsidian-mock` to enable unit tests on UI, added a fairly comprehensive set of UI tests, getting coverage from 0% to 90%-ish.
No actual bugs found and no functional changes.
- `npm run test:coverage` subspecies to report code coverage in all tests.

### Fixed
- In conflict resolution header displayed after 'find next conflict', alternative resolutions buttons moved to the bottom of the view on mobile and are now tappable.  They were displaying at the top, but were overlaid by Android status bar.
- updated dev dependency eslint-plugin-obsidianmd to 0.3 and fixed miscellaneous nits it picked.

## [1.0.3]

### Changed
- Streamlined logging - Logging view is now enabled by default in right sidebar.
  - Added "vault share: open logging view" command to (re-open) the logging view if user closed it.
  - Removed settings fields to enable logging and set severity
  - Removed commands to clear logging view and copy - these are available in logging view itself.

### Fixed
- Various nags being raised by the Obsidian community plugins automated review.

## [1.0.2]

### Changed
- diff3 with 3+ clients was recursively nesting an already merged file with a new variant, producing garbled merged text.
Changed the layout of a merged file (no longer exactly diff3), it's a flat N-way merged format that any number of clients can contribute to.  But:
  - only files changed from the same original base version can be merged into a file
  - Alternative versions in a conflict section are de-duped.  So if multiple devices contribute the same version, only one will appear in the merged file.
  - Once you start an edit session to resolve the merge conflicts, the file will not be shared until you resolve *all* the conflicts.  This keeps sharing from thrashing the other devices.
  - The catch-all treatment if we can't create a clean merge from local and group file is to rename them per "keep-both" merge strategy.
- Sharing Status panel now shows live counts whether sharing is paused or not.  
- Log view now lets you change severity in the log panel, and always shows the clear log and copy log controls whether docked or not.

## [1.0.1]

### Added
- `npm run test:e2e:scale` to verify correct operation with tens to hundreds of files.  Run it, but sparingly.

### Changed
- Handle Google Drive rate limiting (429 status) by backing off and retrying.  Core fix for several flaky sync bugs.
- Use Obsidian `onDelete()` event to distinguish explicit delete from mysteriously vanished from local vault; 
defer remote delete of just vanished local file; 
Pause sharing if there are any such deferred deletes, user can manage in Sharing Status panel under Remote Deletes.

### Fixed
- fix dependabot nags - manual override version `serialize-javascript`
- fix problem of bulk sync sometimes deleting local files because it thought the corresponding drive files were gone.
But real problem what that Google Drive 429 response truncated a (paged) drive file enumeration.
- on startup, wait till Obsidian finishes indexing vault before first bulk sync.
Ensures sharing doesn't think local files vanished since previous run.

## [1.0.0]
RTM! Support available through github.

### Added
- `npm run dev` auto rebuild plugin after source change and autodeploy to designated test vaults; see CONTRIBUTING.md/#debugging for details.
- schema version added to `data.json` and to group vault google drive folder (as app attribute of the folder, not a hidden file).  
Now we can do definitive migrations on all persistent plugin data in upgrade scenarios.

### Changed
- Sharing Status panel now allows user to review all pending sharing operations and, case-by-case, decide to defer, allow or roll back the planned operation.
- Sharing Status panel now shows separate counts of deferred and pending files queued for sharing.
- Stop syncing vault trash folder (`.trash`) and plugin config dir (`.obsidian/plugins/vault-sync`) by default.

### Fixed
- Display a notice that sharing was paused (and a link to the Sharing status panel) when bulk sharing finds "too many" pending changes.
- Avoid marking pairs of files as a conflict when they are content-identical (even if mtimes are different).  
  Use sha256 hash, which Google Drive provides "for free".
  Also in no-sync-history case, avoid declaring conflict when local and group files are actually content-identical.
- Improved reliability of e2e testing in headless mode.  Should be usable in CI now.
- Do an immediate bulk sharing pass when resuming from paused state (rather than wainting for next regularly scheduled pass).
- Corrected stale e2e:single test (code is right, test was wrong)

## [0.9.0]
Close to v1.0 release!

### Added
- Editor function "Find next/previous conflict marker", finds the beginning of a 3-way diff conflicting change region, 
includes buttons to select which alternative(s) to retain.  
Bindable to a hotkey!
- New "Sharing status" view in sidebar allows manual review and fixup of pending sharing operations.
Shows files pending sharing and allows user to accept the operation, defer it (until further notice) 
or to *revert* it (e.g push local file to group vault rather than allow group file to overwrite local because it was newer).
- New "Open Sharing" command to open Sharing status view.
- New command: Repair Drive Duplicates  
Google Drive allows duplicate file names in the same folder.  
This command scans the whole group vault in Google Drive and deletes the older duplicates, ensures that the most recently changed version survives. 
- Added a perf counter to indicate when duplicate files are being found in group vault.
- Attestation of release artifacts via SigStore Public Good Instance (to make Obsidian community happy).

### Changed
- Pause Sync command stops all sharing of changes, both for individual files being edited and the background bulk sharing as well.

### Fixed
- Plugin now checks for duplicate files in same folder (which Google Drive allows) and processes only the one most recently changed (latest modification timestamp).  Does not automatically delete older duplicates, but there's a command for that.

## [0.2.2]

### Changed
- refactored settings Connect/Disconnect button into Log in/Log out, which better clarifies its actual behavior
- refactored settings Conflict Resolution to create independent sections for text and for non-text files, each with all the relevant options.  
  This is an incompatible change!  Delete your `data.json` file in the plugin folder before logging back into Google Drive!
- Changed wording throughout UI: it's "sharing", not "synchronization"

### Removed
- The Start/Pause sync button was removed from Settings.  There's a plugin command for that!

## [0.2.0]

### Changed

### Added
- Many unit tests, trying to get code coverage numbers off the floor.
  Currently, this project has a devDependency on an unreleased version of `obsidian-mocks` to get broader test coverage.

### Fixed
- when creating new files in Google Drive, create them in correct subdirectory, not in GUID folder in root.
- excludeRules now correctly re-include only the folders that exactly match the pattern. 
  (A bug found by new unit tests!)
- fixed [#6](https://github.com/bobhy/vault-share/issues/6); 
  when user clicks "Disconnect", just forget local copy of credentials, don't revoke the authorization grant.
- Updated end-to-end tests to use current credential.


## [0.1.3]

**BETA VERSION**  
Releasing pre V1.0 because I think it's basically reliable and I'm eager for your feedback (about any aspect of this project).
However, no part of the user or other accessible interface should be considered stable.  

Once we hit V1.0 (soon), this project will abide by semver semantics and you'll be able to do the stability calculus yourself.

### Changed
- depend on not-yet-accepted PR version of `obsidian-mocks`; changed dev dependency here to pull from PR branch in Github (no functional difference)
- cleaned up Settings page.
- prepare for beta release: add care-and-feeding user doc to README.md

### Removed
- settings "Modification confirmation threshold" and "Minimum files for confirmantion" removed from settings page.    
Plugin still can raise a warning if the threshold is exceeded, but the only way to change the limits is to edit `data.json` and restart the plugin.

## [0.1.2]

### Added
- option to monitor an open file; polls group vault for changes to update local file even if local file not being changed at same time.
- buttons for clear log and copy log to clipboard; ability to select log contents by select all.
 
### Changed
- default vault now `/vault-sync/<localVaultName>`
- broadened scope of "Clear sync history" to "Reset plugin" (which also clears statistics and cached auth tokens), now requiring user confirmation.

### Fixed
- make gdrive access tokens per-instance, so multiple vaults on same device can each connect to Google Drive.

### Removed
- no longer poll remote for changes to all open files; user must explicitly enable "monitoring".

## [0.1.1]
### Changed
- Default Drive folder path is now the local vault name (e.g. `/my-vault`) instead of the fixed string `/vault-share`. Existing saved settings are unaffected; only first-run or reset-to-defaults behaviour changes.

### Fixed
- Simply viewing an open file no longer causes "syncing..." to lock view every few seconds.

## [0.1.0]
### Changed
- Restarted design, based on learnings from from last updates to [forked air-sync](https://github.com/bobhy/obsidian-air-sync)

