import { App, PluginSettingTab, Setting } from 'obsidian';
import type VaultSharePlugin from '../main';

/**
 * Settings UI for the Vault share plugin.
 * Displayed via Settings → Community plugins → Vault share → Options.
 */
export class VaultShareSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: VaultSharePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Drive folder path')
			.setDesc(
				'Slash-separated path to the shared folder in Google Drive. ' +
				'Must start with a separator. The folder is created if it does not exist. ' +
				'Example: /vault-share/shared',
			)
			.addText(text =>
				text
					.setPlaceholder('/vault-share')
					.setValue(this.plugin.settings.driveFolderPath)
					.onChange(async value => {
						this.plugin.settings.driveFolderPath = value;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		const isConnected = this.plugin.auth.isAuthenticated;

		new Setting(containerEl)
			.setName('Google Drive connection')
			.setDesc(
				isConnected
					? 'Connected. Click disconnect to revoke access and clear stored credentials.'
					: 'Not connected. Click connect to authenticate with Google Drive.',
			)
			.addButton(btn =>
				btn
					.setButtonText(isConnected ? 'Disconnect' : 'Connect')
					.setCta()
					.onClick(async () => {
						if (this.plugin.auth.isAuthenticated) {
							await this.plugin.disconnect();
						} else {
							await this.plugin.connect();
						}
						this.display();
					}),
			);
	}
}
