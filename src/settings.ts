export interface VaultShareSettings {
	/** Slash-separated path to the shared Google Drive folder. Must begin with a separator. */
	driveFolderPath: string;
}

export const DEFAULT_SETTINGS: VaultShareSettings = {
	driveFolderPath: '/vault-share',
};
