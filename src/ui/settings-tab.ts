import { App, PluginSettingTab, Setting } from 'obsidian';
import type VaultSharePlugin from '../main';
import { ConfirmationModal } from './confirmation-modal';

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

		// --- Connection ---
		new Setting(containerEl).setName('Connection').setHeading();

		new Setting(containerEl)
			.setName('Drive folder path')
			.setDesc(
				'Slash-separated path to the group vault folder in Google Drive. ' +
				'Must start with a separator. Full path is created if it does not exist. ' +
				'Example: /vault-share/shared',
			)
			.addText(text => {
				text
					.setPlaceholder(`/vault-share/${this.plugin.app.vault.getName()}`)
					.setValue(this.plugin.settings.driveFolderPath);
				text.inputEl.addEventListener('blur', () => {
					void this.plugin.onDriveFolderPathChange(text.getValue());
				});
			});

		const isConnected = this.plugin.auth.isAuthenticated;
		new Setting(containerEl)
			.setName('Google Drive connection')
			.setDesc(
				isConnected
					? 'Connected. Click disconnect to clear stored credentials for this vault.'
					: 'Not connected. Click connect to authenticate with Google Drive.',
			)
			.addButton(btn =>
				btn
					.setButtonText(isConnected ? 'Disconnect' : 'Connect')
					.setCta()
					.onClick(async () => {
						if (this.plugin.auth.isAuthenticated) {
							await this.plugin.disconnect();
							this.display();
						} else {
							await this.plugin.connect();
						}
					}),
			);

		// --- Sync ---
		new Setting(containerEl).setName('Synchronization').setHeading();

		new Setting(containerEl)
			.setName('Conflict resolution')
			.setDesc('How to handle files modified on two devices before syncing.')
			.addDropdown(drop =>
				drop
					.addOption('Merge', 'Merge (combine changes with conflict markers)')
					.addOption('Keep Both', 'Keep both (rename both versions)')
					.addOption('Use Newer', 'Use newer (keep the most recently modified)')
					.setValue(this.plugin.settings.fileConflict)
					.onChange(async value => {
						this.plugin.settings.fileConflict = value as typeof this.plugin.settings.fileConflict;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('Exclude rules')
			.setDesc(
				'Ordered rules controlling which files are synced. ' +
				'One rule per line. A ! prefix re-includes a previously excluded path. ' +
				'Last matching rule wins.',
			)
			.addTextArea(area => {
				area
					.setPlaceholder('One rule per line')
					.setValue(this.plugin.settings.excludeRules.join('\n'))
					.onChange(async value => {
						this.plugin.settings.excludeRules = value.split('\n');
						await this.plugin.saveData(this.plugin.settings);
						this.plugin.rebuildExcludeMatcher();
					});
				area.inputEl.rows = 6;
			});

		new Setting(containerEl)
			.setName('Bulk sync interval')
			.setDesc('How often (in seconds) a full vault sync runs in the background.')
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.bulkSyncPoll))
					.onChange(async value => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.bulkSyncPoll = n;
							await this.plugin.saveData(this.plugin.settings);
						}
					}),
			);

		new Setting(containerEl)
			.setName('Open file poll interval')
			.setDesc('How often (in seconds) an open visible file is checked for remote changes.')
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.openFilePoll))
					.onChange(async value => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.openFilePoll = n;
							await this.plugin.saveData(this.plugin.settings);
						}
					}),
			);

		new Setting(containerEl)
			.setName('Edit holddown')
			.setDesc('Seconds to wait after the last keystroke before syncing an edited file.')
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.openFileChangeHoldDown))
					.onChange(async value => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.openFileChangeHoldDown = n;
							await this.plugin.saveData(this.plugin.settings);
						}
					}),
			);

		const isPaused = this.plugin.scheduler?.isPaused() ?? false;
		new Setting(containerEl)
			.setName('Sync status')
			.setDesc(isPaused ? 'Sync is paused.' : 'Sync is running.')
			.addButton(btn =>
				btn
					.setButtonText(isPaused ? 'Start sync' : 'Pause sync')
					.setCta()
					.onClick(() => {
						if (isPaused) {
							this.plugin.scheduler?.setPaused(false);
							this.plugin.scheduler?.triggerBulkSync();
						} else {
							this.plugin.scheduler?.setPaused(true);
						}
						this.display();
					}),
			);

		// --- Statistics (read-only) ---
		new Setting(containerEl).setName('Statistics').setHeading();

		const stats = this.plugin.statsTracker?.getCurrent();
		if (stats) {
			const fields: Array<[string, string, string | number]> = [
				['Server clock skew', 'serverClockSkew', `${stats.serverClockSkew} ms`],
				['Api response time', 'APIResponseTime', `${stats.APIResponseTime} ms`],
				['Bulk sync passes', 'bulkSyncPasses', stats.bulkSyncPasses],
				['Single file syncs', 'singleFileSyncCount', stats.singleFileSyncCount],
				['Files pushed', 'filesPushed', stats.filesPushed],
				['Files pulled', 'filesPulled', stats.filesPulled],
				['Files merged', 'filesMerged', stats.filesMerged],
				['Content conflicts', 'contentConflicts', stats.contentConflicts],
				['Delete conflicts', 'deleteConflicts', stats.deleteConflicts],
			];
			for (const [name, , value] of fields) {
				new Setting(containerEl)
					.setName(name)
					.setDesc(String(value));
			}

			new Setting(containerEl)
				.setName('Reset statistics')
				.setDesc('Reset all counters to zero.')
				.addButton(btn =>
					btn
						.setButtonText('Reset')
						.setCta()
						.onClick(async () => {
							await this.plugin.statsTracker?.reset();
							this.display();
						}),
				);
		}

		// --- Logging ---
		new Setting(containerEl).setName('Logging').setHeading();

		new Setting(containerEl)
			.setName('Log level')
			.setDesc('Minimum severity of messages written to the log.')
			.addDropdown(drop =>
				drop
					.addOption('DEBUG', 'Debug')
					.addOption('INFO', 'Info')
					.addOption('WARNING', 'Warning')
					.addOption('ERROR', 'Error')
					.setValue(this.plugin.settings.logSeverity)
					.onChange(async value => {
						this.plugin.settings.logSeverity = value as typeof this.plugin.settings.logSeverity;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('Show log in sidebar')
			.setDesc('Display recent log messages in a right-sidebar panel.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.logToSidebar)
					.onChange(async value => {
						this.plugin.settings.logToSidebar = value;
						await this.plugin.saveData(this.plugin.settings);
						await this.plugin.updateSidebarLogView();
					}),
			);

		new Setting(containerEl)
			.setName('Log history size')
			.setDesc('Number of most recent log entries to retain for the sidebar view.')
			.addText(text =>
				text
					.setValue(String(this.plugin.settings.logHorizon))
					.onChange(async value => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.logHorizon = n;
							await this.plugin.saveData(this.plugin.settings);
						}
					}),
			);

		// --- Plugin ---
		new Setting(containerEl).setName('Plugin').setHeading();

		new Setting(containerEl)
			.setName('Reset plugin')
			.setDesc(
				'Deletes connection to cloud service and local sync history and statistics ' +
				'for the plugin. Does not delete any vault files.',
			)
			.addButton(btn =>
				btn
					.setButtonText('Reset plugin')
					.setWarning()
					.onClick(async () => {
						const confirmed = await ConfirmationModal.prompt(
							this.plugin.app,
							'Reset plugin?',
							'This will permanently delete your Google Drive connection, all local ' +
							'sync records, and statistics. Your vault files will not be affected. ' +
							'To sync again you will need to reconnect — the plugin will then merge ' +
							'your local vault with the group vault from scratch.',
						);
						if (!confirmed) return;
						await this.plugin.pluginReset();
						this.display();
					}),
			);
	}
}

