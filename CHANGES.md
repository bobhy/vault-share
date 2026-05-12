# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [unreleased]

### Added
- option to monitor an open file; polls group vault for changes to update local file even if local file not being changed at same time.
- buttons for clear log and copy log to clipboard; ability to select log contents by select all.
 
### Changed
- default vault now `/vault-sync/<localVaultName>`

### Fixed
- make gdrive access tokens per-instance, so multiple vaults on same device can each connect to Google Drive.

## [0.1.1]
### Changed
- Default Drive folder path is now the local vault name (e.g. `/my-vault`) instead of the fixed string `/vault-share`. Existing saved settings are unaffected; only first-run or reset-to-defaults behaviour changes.

### Fixed
- Simply viewing an open file no longer causes "syncing..." to lock view every few seconds.

## [0.1.0]
### Changed
- Restarted design, based on learnings from from last updates to [forked air-sync](https://github.com/bobhy/obsidian-air-sync)

