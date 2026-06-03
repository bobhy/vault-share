# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [unreleased]

### Changed
- Handle Google Drive rate limiting (429 status) by backing off and retrying.  Core fix for several flaky sync bugs.

### Fixed
- fix dependabot nags - manual override version `serialize-javascript`
- fix problem of bulk sync sometimes deleting local files because it thought the corresponding drive files were gone.
But real problem what that Google Drive 429 response truncated a (paged) drive file enumeration.

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

