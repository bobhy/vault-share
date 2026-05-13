import { Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, VaultShareSettings } from './settings';
import { GDriveAuth } from './gdrive/auth';
import { GDriveApi } from './gdrive/api';
import { Logger } from './logger';
import { SyncStore } from './sync/store';
import { StatsTracker } from './sync/stats-tracker';
import { resolveClientId } from './sync/client-id';
import { ExcludeMatcher } from './sync/exclude';
import { LocalFs } from './sync/local-fs';
import { DriveFsAdapter } from './sync/drive-fs';
import { BulkSync } from './sync/bulk-sync';
import { SyncScheduler } from './sync/scheduler';
import { SyncContext } from './sync/types';
import { VaultShareSettingTab } from './ui/settings-tab';
import { SyncLogView, SYNC_LOG_VIEW_TYPE } from './ui/sync-log-view';
import { ConfirmationModal } from './ui/confirmation-modal';

/**
 * Vault Share plugin entry point.
 * Handles lifecycle only; all logic is delegated to dedicated modules.
 */
export default class VaultSharePlugin extends Plugin {
	settings: VaultShareSettings = { ...DEFAULT_SETTINGS };
	auth!: GDriveAuth;
	api!: GDriveApi;
	logger!: Logger;
	store?: SyncStore;
	statsTracker?: StatsTracker;
	scheduler?: SyncScheduler;

	private clientId = '';
	private driveFolderId = '';
	private excludeMatcher!: ExcludeMatcher;
	private localFs!: LocalFs;
	private driveFs!: DriveFsAdapter;
	private settingTab!: VaultShareSettingTab;
	private statusBarEl!: HTMLElement;
	private monitoringStatusBarEl!: HTMLElement;

	async onload() {
		// 1. Settings
		const stored = await this.loadData() as unknown as Partial<VaultShareSettings>;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			{ driveFolderPath: `/vault-share/${this.app.vault.getName()}` },
			stored,
		);

		// 2. Auth + API
		this.auth = new GDriveAuth(this.app);
		this.api = new GDriveApi(this.auth);
		this.auth.loadFromSecretStorage();

		// 3. Logger (plugin-wide, constructed before anything that logs)
		this.logger = new Logger(
			() => this.settings.logSeverity,
			() => this.settings.logHorizon,
		);

		// 4. IndexedDB store
		this.store = new SyncStore(this.app.vault.getName());
		await this.store.open();

		// 5. Client ID
		this.clientId = await resolveClientId(this.store);

		// 6. Stats
		this.statsTracker = new StatsTracker(this.store);
		await this.statsTracker.load();

		// 7. File system adapters
		this.excludeMatcher = new ExcludeMatcher(this.settings.excludeRules);
		this.localFs = new LocalFs(this.app);
		this.driveFs = new DriveFsAdapter(this.api);

		// 8. Status bar (sync status) + monitoring status bar
		this.statusBarEl = this.addStatusBarItem();
		const setStatusBar = (text: string) => { this.statusBarEl.setText(text); };
		this.monitoringStatusBarEl = this.addStatusBarItem();

		// 9. Resolve Drive folder (best-effort at load; scheduler retries on each bulk pass)
		if (this.auth.isAuthenticated) {
			this.driveFolderId = await this.resolveDriveFolder().catch(err => {
				this.logger.warning('Could not resolve Drive folder at startup', String(err));
				return '';
			});
		}

		// 10. Build SyncContext
		const ctx: SyncContext = {
			app: this.app,
			localFs: this.localFs,
			driveFs: this.driveFs,
			store: this.store,
			statsTracker: this.statsTracker,
			settings: () => this.settings,
			clientId: this.clientId,
			driveFolderId: () => this.driveFolderId,
			logger: this.logger,
		};

		// 11. Bulk sync + scheduler
		const bulkSync = new BulkSync(ctx, this.excludeMatcher, this.app, setStatusBar);
		this.scheduler = new SyncScheduler({
			ctx,
			bulkSync,
			workspace: this.app.workspace,
			setStatusBar,
			registerEvent: ref => this.registerEvent(ref),
			registerInterval: id => this.registerInterval(id),
		});

		// 12. Sidebar log view
		this.registerView(SYNC_LOG_VIEW_TYPE, leaf => new SyncLogView(leaf, this.logger, () => {
			this.settings.logToSidebar = false;
			void this.saveData(this.settings);
		}));
		if (this.settings.logToSidebar) {
			this.app.workspace.onLayoutReady(() => { void this.activateSidebarLogView(); });
		}

		// 13. OAuth callback
		this.registerObsidianProtocolHandler('vault-share-auth', async params => {
			try {
				await this.auth.handleAuthCallback(params);
				this.auth.saveToSecretStorage();
				this.driveFolderId = await this.resolveDriveFolder();
				this.scheduler?.triggerBulkSync();
				new Notice('Google Drive connected.');
				this.settingTab.display();
			} catch (err) {
				new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		// 14. Settings tab
		this.settingTab = new VaultShareSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// 15. Commands
		this.addCommand({
			id: 'pause-sync',
			name: 'Pause sync',
			callback: () => {
				this.scheduler?.setPaused(true);
				setStatusBar('Sync paused');
			},
		});

		this.addCommand({
			id: 'start-sync',
			name: 'Start sync',
			callback: () => {
				this.scheduler?.setPaused(false);
				this.scheduler?.triggerBulkSync();
			},
		});

		this.addCommand({
			id: 'toggle-file-monitoring',
			name: 'Toggle monitoring for remote changes on current file',
			editorCallback: (_editor, ctx) => {
				const file = ctx.file;
				if (!file || this.excludeMatcher.isExcluded(file.path)) return;
				this.toggleMonitoringForFile(file.path);
			},
		});

		this.addCommand({
			id: 'copy-sync-log',
			name: 'Copy sync log to clipboard',
			callback: () => {
				const lines: string[] = [];
				for (const entry of this.logger.getEntries()) {
					const timeStr = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false });
					const line = `${timeStr} [${entry.severity}] ${entry.message}`;
					lines.push(entry.detail ? `${line}\n  ${entry.detail}` : line);
				}
				void navigator.clipboard.writeText(lines.join('\n'));
			},
		});

		this.addCommand({
			id: 'clear-sync-log',
			name: 'Clear sync log',
			callback: () => { this.logger.clear(); },
		});

		// 16. Context menus
		this.registerEvent(this.app.workspace.on('file-menu', (menu, abstractFile) => {
			if (!(abstractFile instanceof TFile)) return;
			if (this.excludeMatcher.isExcluded(abstractFile.path)) return;
			const monitored = this.scheduler?.isMonitored(abstractFile.path) ?? false;
			menu.addItem(item => {
				item
					.setTitle(monitored
						? 'Stop monitoring for remote changes to this file'
						: 'Monitor for remote changes to this file')
					.setIcon('sync')
					.onClick(() => { this.toggleMonitoringForFile(abstractFile.path); });
			});
		}));

		this.registerEvent(this.app.workspace.on('editor-menu', (menu, _editor, info) => {
			const file = info.file;
			if (!file || this.excludeMatcher.isExcluded(file.path)) return;
			const monitored = this.scheduler?.isMonitored(file.path) ?? false;
			menu.addItem(item => {
				item
					.setTitle(monitored
						? 'Stop monitoring for remote changes to this file'
						: 'Monitor for remote changes to this file')
					.setIcon('sync')
					.onClick(() => { this.toggleMonitoringForFile(file.path); });
			});
		}));

		// 17. Active-leaf-change: update monitoring status bar
		this.registerEvent(this.app.workspace.on('active-leaf-change', _leaf => {
			this.updateMonitoringStatusBar();
		}));

		// 18. Start scheduler (triggers initial bulk sync)
		this.scheduler.start();
		this.scheduler.triggerBulkSync();
	}

	onunload() {
		this.scheduler?.destroy();
		void this.statsTracker?.flush();
		this.store?.close();
	}

	/** Open the browser to begin the Google OAuth flow. */
	async connect() {
		const url = this.auth.getAuthorizationUrl();
		window.open(url, '_blank');
	}

	/** Revoke tokens and clear credentials. */
	async disconnect() {
		await this.auth.revokeToken();
		this.driveFolderId = '';
		new Notice('Disconnected from Google Drive.');
	}

	/** Called by settings tab when driveFolderPath changes. */
	async onDriveFolderPathChange(newPath: string): Promise<void> {
		const oldPath = this.settings.driveFolderPath;
		if (newPath === oldPath) return;

		const hasHistory = (await this.store?.getAllRecords() ?? []).length > 0;
		if (hasHistory) {
			const proceed = await ConfirmationModal.prompt(
				this.app,
				'Change group vault',
				`Changing the group vault will disconnect from <strong>${oldPath}</strong> ` +
				`and require you to connect to <strong>${newPath}</strong>. ` +
				`The plugin will then merge with <strong>${newPath}</strong>. Proceed?`,
			);
			if (!proceed) return;
			await this.store?.clearAll();
			await this.statsTracker?.reset();
		}

		this.settings.driveFolderPath = newPath;
		await this.saveData(this.settings);
		this.driveFolderId = '';

		if (this.auth.isAuthenticated) {
			this.driveFolderId = await this.resolveDriveFolder().catch(() => '');
			this.scheduler?.triggerBulkSync();
		}
	}

	/** Reset all plugin state: sync records, stats, and OAuth tokens. Leaves settings intact. */
	async pluginReset(): Promise<void> {
		await this.store?.clearAll();
		await this.statsTracker?.reset();
		this.auth.clearSecretStorage();
		this.driveFolderId = '';
		this.scheduler?.triggerBulkSync();
	}

	/** Rebuild ExcludeMatcher after excludeRules change. */
	rebuildExcludeMatcher(): void {
		this.excludeMatcher = new ExcludeMatcher(this.settings.excludeRules);
	}

	/** Open or close the sidebar log view based on current logToSidebar setting. */
	async updateSidebarLogView(): Promise<void> {
		if (this.settings.logToSidebar) {
			await this.activateSidebarLogView();
		} else {
			this.app.workspace.detachLeavesOfType(SYNC_LOG_VIEW_TYPE);
		}
	}

	/** Toggle monitoring for a file and refresh the monitoring status bar. */
	private toggleMonitoringForFile(path: string): void {
		this.scheduler?.toggleMonitoring(path);
		this.updateMonitoringStatusBar();
	}

	/** Update the monitoring status bar based on the currently active file. */
	private updateMonitoringStatusBar(): void {
		const file = this.app.workspace.getActiveFile();
		if (file && this.scheduler?.isMonitored(file.path)) {
			const name = file.path.split('/').pop() ?? file.path;
			this.monitoringStatusBarEl.setText(`Monitoring ${name}`);
		} else {
			this.monitoringStatusBarEl.setText('');
		}
	}

	private async resolveDriveFolder(): Promise<string> {
		return this.api.resolveFolder(this.settings.driveFolderPath);
	}

	private async activateSidebarLogView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SYNC_LOG_VIEW_TYPE);
		if (existing[0]) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		// getRightLeaf(false) throws when the right sidebar panel hasn't been created yet.
		let leaf: WorkspaceLeaf | null = null;
		try {
			leaf = this.app.workspace.getRightLeaf(false);
		} catch {
			return;
		}
		if (!leaf) return;
		await leaf.setViewState({ type: SYNC_LOG_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
