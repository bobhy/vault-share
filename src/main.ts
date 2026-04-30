import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, VaultShareSettings } from './settings';
import { GDriveAuth } from './gdrive/auth';
import { GDriveApi } from './gdrive/api';
import { VaultShareSettingTab } from './ui/settings-tab';

/**
 * Vault Share plugin entry point.
 * Syncs Obsidian vaults with a shared folder in Google Drive.
 */
export default class VaultSharePlugin extends Plugin {
	settings: VaultShareSettings = { ...DEFAULT_SETTINGS };
	auth!: GDriveAuth;
	api!: GDriveApi;

	async onload() {
		this.auth = new GDriveAuth(this.app);
		this.api = new GDriveApi(this.auth);

		const stored = await this.loadData() as unknown as Partial<VaultShareSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

		this.auth.loadFromSecretStorage();

		this.registerObsidianProtocolHandler('vault-share-auth', async params => {
			try {
				await this.auth.handleAuthCallback(params);
				this.auth.saveToSecretStorage();
				new Notice('Google Drive connected.');
			} catch (err) {
				new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		this.addSettingTab(new VaultShareSettingTab(this.app, this));
	}

	onunload() {}

	/** Open the browser to begin the Google OAuth flow. */
	async connect() {
		const url = this.auth.getAuthorizationUrl();
		window.open(url, '_blank');
	}

	/** Revoke tokens and clear credentials. */
	async disconnect() {
		await this.auth.revokeToken();
		new Notice('Disconnected from Google Drive.');
	}
}
