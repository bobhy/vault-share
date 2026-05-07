# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1]
### Changed
- Default Drive folder path is now the local vault name (e.g. `/my-vault`) instead of the fixed string `/vault-share`. Existing saved settings are unaffected; only first-run or reset-to-defaults behaviour changes.

### Fixed
- Simply viewing an open file no longer causes "syncing..." to lock view every few seconds.

## [0.1.0]
### Changed
- Restarted design, based on learnings from from last updates to [forked air-sync](https://github.com/bobhy/obsidian-air-sync)

