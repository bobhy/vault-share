export type FileConflictStrategy = 'Use Newer' | 'Keep Both';
export type TextFileConflictStrategy = 'Use Newer' | 'Keep Both' | 'Merge';
export type LogSeverity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export interface VaultShareSettings {
	/** Slash-separated path to the shared Google Drive folder. Must begin with a separator. */
	driveFolderPath: string;

	/** Ordered exclude rules (last-match-wins, ! prefix re-includes). */
	excludeRules: string[];

	/** Conflict resolution strategy for mutually modified non-text files. */
	fileConflict: FileConflictStrategy;

	/** Conflict resolution strategy for mutually modified text files (.md, .txt). */
	textFileConflict: TextFileConflictStrategy;

	/** Show confirmation modal before bulk sync modifies more than this % of vault files. */
	fileModificationConfirmationThreshold: number;

	/** Skip confirmation modal when vault has fewer than this many syncable files. */
	fileModificationConfirmationMin: number;

	/** How often bulk sync runs, in seconds. */
	bulkSyncPoll: number;

	/** How often single-file sync polls an open visible file, in seconds. */
	openFilePoll: number;

	/** Seconds after the last local edit before single-file sync is triggered. */
	openFileChangeHoldDown: number;

	/** Minimum severity level written to log output. */
	logSeverity: LogSeverity;

	/** When true, recent log entries are shown in a right-sidebar leaf. */
	logToSidebar: boolean;

	/** Maximum number of log entries retained for the sidebar view. */
	logHorizon: number;
}

export const DEFAULT_SETTINGS: VaultShareSettings = {
	driveFolderPath: '',  // overridden at runtime with /vault-share/<vault-name>; never used as-is
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- static constant; Vault#configDir is unavailable here; runtime code should use vault.configDir if overriding
	excludeRules: ['.obsidian', '!.obsidian/plugins/vault-share'],
	fileConflict: 'Keep Both',
	textFileConflict: 'Merge',
	fileModificationConfirmationThreshold: 10,
	fileModificationConfirmationMin: 10,
	bulkSyncPoll: 3600,
	openFilePoll: 10,
	openFileChangeHoldDown: 5,
	logSeverity: 'WARNING',
	logToSidebar: false,
	logHorizon: 1000,
};
