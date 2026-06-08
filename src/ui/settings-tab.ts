/**
 * Settings tab rendered under Settings → Community plugins → Vault share →
 * Options.
 *
 * Holds no business logic of its own — every setting's `.onChange` writes
 * through the plugin's `saveData` and, where the change affects running
 * subsystems (drive folder path, exclude rules, log severity), invokes the
 * appropriate handler on `VaultSharePlugin`.
 *
 * @packageDocumentation
 */
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
				'Example: /vault-share/my-local-vault',
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
			.setName('Google Drive account')
			.setDesc(
				isConnected
					? 'Logged in. Click Log Out to clear stored credentials for this vault.'
					: 'Not logged in. Click Log In to authenticate with Google Drive.',
			)
			.addButton(btn =>
				btn
					.setButtonText(isConnected ? 'Log Out' : 'Log In')
					.setCta()
					.onClick(async () => {
						if (this.plugin.auth.isAuthenticated) {
							await this.plugin.logout();
							this.display();
						} else {
							await this.plugin.login();
						}
					}),
			);

		// --- Conflict resolution ---
		new Setting(containerEl).setName('Conflict resolution').setHeading();

		new Setting(containerEl)
			.setName('For most files')
			.setDesc(
				'Applies when both the local vault and the group vault have changed a file since it was last shared. ' +
				'Keep both: rename both versions with a timestamp suffix. ' +
				'Use newer: keep whichever was modified most recently.',
			)
			.addDropdown(drop =>
				drop
					.addOption('Keep Both', 'Keep both')
					.addOption('Use Newer', 'Use newer')
					.setValue(this.plugin.settings.fileConflict)
					.onChange(async value => {
						this.plugin.settings.fileConflict = value as typeof this.plugin.settings.fileConflict;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('For text files (.md, .txt)')
			.setDesc(
				'Merge: attempt a 3-way merge; if the same lines were changed on both sides, ' +
				'inline conflict markers are inserted for manual resolution. ' +
				'Keep both and Use newer work as described above.',
			)
			.addDropdown(drop =>
				drop
					.addOption('Merge', 'Merge')
					.addOption('Keep Both', 'Keep both')
					.addOption('Use Newer', 'Use newer')
					.setValue(this.plugin.settings.textFileConflict)
					.onChange(async value => {
						this.plugin.settings.textFileConflict = value as typeof this.plugin.settings.textFileConflict;
						await this.plugin.saveData(this.plugin.settings);
					}),
			);

		// --- Sharing ---
		new Setting(containerEl).setName('Sharing').setHeading();

		new Setting(containerEl)
			.setName('Exclude rules')
			.setDesc(
				'Ordered rules controlling which files are shared. ' +
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
			.setName('Sharing interval')
			.setDesc('How often (in seconds) vault sharing runs in the background.')
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
			.setDesc('Seconds to wait after the last keystroke before sharing an edited file.')
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

		// --- Logging ---
		// The log level is set from the log panel's own dropdown, and the panel
		// is shown by default (reopen via the "Open log panel" command), so the
		// only logging setting here is history size.
		new Setting(containerEl).setName('Logging').setHeading();

		new Setting(containerEl)
			.setName('Log history size')
			.setDesc('Number of most recent log entries to retain for the log panel.')
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

		// --- Statistics (read-only) ---
		new Setting(containerEl).setName('Statistics').setHeading();

		const stats = this.plugin.statsTracker?.getCurrent();
		if (stats) {
			const fields: Array<[string, string, string | number]> = [
				['Server clock skew', 'serverClockSkew', `${stats.serverClockSkew} ms`],
				['Api response time', 'APIResponseTime', `${stats.APIResponseTime} ms`],
				['Bulk sharing passes', 'bulkSyncPasses', stats.bulkSyncPasses],
				['Passes with Drive duplicates', 'bulkPassesWithDuplicates', stats.bulkPassesWithDuplicates],
				['Single file shares', 'singleFileSyncCount', stats.singleFileSyncCount],
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

			// Schema version of the shared folder. Fetched asynchronously (it's a
			// Drive metadata read) so the row renders immediately with a
			// placeholder and fills in once the value arrives.
			const schemaSetting = new Setting(containerEl)
				.setName('Group vault schema')
				.setDesc('Checking…');
			void this.plugin.getGroupVaultSchemaVersion().then(version => {
				schemaSetting.setDesc(version === null ? 'Not connected' : String(version));
			});

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

		// --- Plugin ---
		new Setting(containerEl).setName('Plugin').setHeading();

		new Setting(containerEl)
			.setName('Reset plugin')
			.setDesc(
				'Logs out of the cloud service and clears local share history and statistics ' +
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
							'This will log you out of your Google Drive connection, clear all local ' +
							'share records and statistics. Your vault files will not be affected. ' +
							'To resume, you will need to log in again and the plugin will merge ' +
							'your local vault with the group vault from scratch.',
						);
						if (!confirmed) return;
						await this.plugin.pluginReset();
						this.display();
					}),
			);
	}
}

