# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [unreleased]

### Changed
- refactored settings Connect/Disconnect button into Log in/Log out, which better clarifies its actual behavior
- refactored settings Conflict Resolution to create independent sections for text and for non-text files, each with all the relevant options.  
  This is an incompatible change!  Delete your `data.json` file in the plugin folder before logging back into Google Drive!

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

