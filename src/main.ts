import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
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
import { CandidateStore } from './sync/candidate-store';
import { SyncScheduler } from './sync/scheduler';
import { SyncContext } from './sync/types';
import { VaultShareSettingTab } from './ui/settings-tab';
import { SyncLogView, SYNC_LOG_VIEW_TYPE } from './ui/sync-log-view';
import { SharingStatusView, SHARING_STATUS_VIEW_TYPE } from './ui/sharing-status-view';
import { ConfirmationModal } from './ui/confirmation-modal';
import { ConflictMarkerNavigator, conflictHighlightExtension } from './ui/conflict-marker-navigator';
import { formatSyncStatus } from './ui/sync-status-bar';

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
	candidateStore?: CandidateStore;
	bulkSync?: BulkSync;
	scheduler?: SyncScheduler;

	private clientId = '';
	private driveFolderId = '';
	private excludeMatcher!: ExcludeMatcher;
	private localFs!: LocalFs;
	private driveFs!: DriveFsAdapter;
	private settingTab!: VaultShareSettingTab;
	private statusBarEl!: HTMLElement;
	private deferralStatusBarEl!: HTMLElement;
	private monitoringStatusBarEl!: HTMLElement;
	private deferralNoticeShown = false;

	async onload() {
		// 1. Settings
		const stored = await this.loadData() as unknown as (Partial<VaultShareSettings> & {
			// One-shot migration shape: the old field names used before
			// sync-review-followups item (7). See the migration block below.
			fileModificationConfirmationThreshold?: number;
			fileModificationConfirmationMin?: number;
		}) | null;

		// One-shot rename from `fileModificationConfirmation*` to `globalChange*`
		// (item 7 — the new names reflect that the threshold counts changes on
		// either side of the sync, not just local modifications). Carry the
		// stored values across; the new numerator/denominator semantics are
		// slightly different but the user's chosen threshold/min values
		// continue to express the same intent (their tolerance for noise).
		// Persist the cleaned-up shape so the migration only runs once per
		// install.
		let migrationApplied = false;
		if (stored) {
			if (typeof stored.fileModificationConfirmationThreshold === 'number'
				&& typeof stored.globalChangeThreshold !== 'number') {
				stored.globalChangeThreshold = stored.fileModificationConfirmationThreshold;
				migrationApplied = true;
			}
			if (typeof stored.fileModificationConfirmationMin === 'number'
				&& typeof stored.globalChangeMin !== 'number') {
				stored.globalChangeMin = stored.fileModificationConfirmationMin;
				migrationApplied = true;
			}
			if (migrationApplied) {
				delete stored.fileModificationConfirmationThreshold;
				delete stored.fileModificationConfirmationMin;
			}
		}

		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			{ driveFolderPath: `/vault-share/${this.app.vault.getName()}` },
			stored,
		);

		// Persist the migrated shape so subsequent loads don't see the old
		// keys. Fire-and-forget — failure to save here just means the
		// migration is retried on next load, which is idempotent.
		if (migrationApplied) {
			void this.saveData(this.settings);
		}

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

		// 8. Status bar items: sync status, deferral indicator, monitoring
		this.statusBarEl = this.addStatusBarItem();
		const setStatusBar = (text: string) => { this.statusBarEl.setText(text); };
		this.deferralStatusBarEl = this.addStatusBarItem();
		this.deferralStatusBarEl.setText('Checking…');  // replaced once the first plan completes
		this.registerDomEvent(this.deferralStatusBarEl, 'click', () => { void this.activateSharingStatusView(); });
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

		// 11. CandidateStore — single source of truth for all per-file sharing state
		this.candidateStore = new CandidateStore(this.store.getIdb());
		const candidateStore = this.candidateStore;

		// Wire the change listener: update status bar and refresh all Sharing Status views.
		// PendingListModal subscribes separately in its onOpen; the modal's own
		// listener handles re-rendering its rows when reconcile fires mid-modal.
		candidateStore.onChange(() => {
			const count = candidateStore.getPendingCount();
			if (!this.deferralNoticeShown && count !== null && count > 0) {
				this.deferralNoticeShown = true;
				this.showDeferralNotice(count);
			}
			this.updateDeferralStatusBar();
			this.refreshSharingStatusViews();
		});

		// Warm the in-memory cache so isPausedSync() and isDeferred() are accurate
		// from the very first scheduler tick.
		await candidateStore.init();

		// 12. Bulk sync + scheduler
		this.bulkSync = new BulkSync(ctx, this.excludeMatcher, setStatusBar, candidateStore,
			(count) => { this.showThresholdPauseNotice(count); },
		);
		const bulkSync = this.bulkSync;

		this.scheduler = new SyncScheduler({
			ctx,
			bulkSync,
			candidateStore,
			workspace: this.app.workspace,
			setStatusBar,
			registerEvent: ref => this.registerEvent(ref),
			registerInterval: id => this.registerInterval(id),
			isSharingPaused: () => candidateStore.isPausedSync(),
			isDeferredPath: path => candidateStore.isDeferred(path),
		});

		// 13. Sidebar log view
		this.registerView(SYNC_LOG_VIEW_TYPE, leaf => new SyncLogView(leaf, this.logger, () => {
			this.settings.logToSidebar = false;
			void this.saveData(this.settings);
		}));
		if (this.settings.logToSidebar) {
			this.app.workspace.onLayoutReady(() => { void this.activateSidebarLogView(); });
		}

		// 13a. Sharing status view
		this.registerView(SHARING_STATUS_VIEW_TYPE, leaf =>
			new SharingStatusView(leaf, candidateStore, bulkSync, ctx),
		);

		// 14. OAuth callback
		this.registerObsidianProtocolHandler('vault-share-auth', async params => {
			try {
				await this.auth.handleAuthCallback(params);
				this.auth.saveToSecretStorage();
				this.driveFolderId = await this.resolveDriveFolder();
				this.scheduler?.triggerBulkSync();
				new Notice('Logged in to Google Drive.');
				this.settingTab.display();
			} catch (err) {
				new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		// 15. Settings tab
		this.settingTab = new VaultShareSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// 16. Commands
		this.addCommand({
			id: 'open-sharing-status',
			name: 'Open sharing status panel',
			callback: () => { void this.activateSharingStatusView(); },
		});

		this.addCommand({
			id: 'pause-sync',
			name: 'Pause sharing',
			callback: () => {
				void this.candidateStore?.setPaused(true);
				setStatusBar('Sharing paused');
			},
		});

		this.addCommand({
			id: 'start-sync',
			name: 'Start or resume sharing',
			callback: () => {
				// setPaused(false) persists the change and fires onChanged.
				// Because doRun() checks getApproved() before any planning pass,
				// there is no race between approved candidates and triggerBulkSync():
				// approved state is in IDB and survives any number of scheduler ticks.
				void this.candidateStore?.setPaused(false).then(() => {
					this.scheduler?.triggerBulkSync();
				});
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

		this.registerEditorExtension(conflictHighlightExtension);
		const conflictNavigator = new ConflictMarkerNavigator();

		this.addCommand({
			id: 'find-next-conflict',
			name: 'Find next conflict marker',
			editorCallback: (editor, ctx) => {
				conflictNavigator.navigateForward(editor, ctx instanceof MarkdownView ? ctx : undefined);
			},
		});

		this.addCommand({
			id: 'find-prev-conflict',
			name: 'Find previous conflict marker',
			editorCallback: (editor, ctx) => {
				conflictNavigator.navigateBackward(editor, ctx instanceof MarkdownView ? ctx : undefined);
			},
		});

		this.addCommand({
			id: 'repair-drive-duplicates',
			name: 'Repair Drive duplicates', // eslint-disable-line obsidianmd/ui/sentence-case -- "Drive" is a proper noun (Google Drive)
			callback: () => {
				const folderId = this.driveFolderId;
				if (!folderId) {
					new Notice('Not logged in to Drive — cannot repair duplicates.'); // eslint-disable-line obsidianmd/ui/sentence-case -- "Drive" is a proper noun
					return;
				}
				void this.driveFs.repairDuplicates(folderId, this.logger)
					.then(({ pathsWithDuplicates, filesDeleted }) => {
						if (filesDeleted === 0) {
							this.logger.info('Drive repair: no duplicate files found');
							new Notice('Drive repair: no duplicate files found.');
						} else {
							this.logger.info(
								`Drive repair: deleted ${filesDeleted} duplicate file${filesDeleted === 1 ? '' : 's'} ` +
								`across ${pathsWithDuplicates} path${pathsWithDuplicates === 1 ? '' : 's'}`,
							);
							new Notice(
								`Drive repair: deleted ${filesDeleted} duplicate file${filesDeleted === 1 ? '' : 's'} ` +
								`across ${pathsWithDuplicates} path${pathsWithDuplicates === 1 ? '' : 's'}.`,
							);
							void this.statsTracker?.resetDuplicateCounter();
						}
					})
					.catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						this.logger.error('Drive repair failed', msg);
						new Notice(`Drive repair failed: ${msg}`);
					});
			},
		});

		this.addCommand({
			id: 'copy-sync-log',
			name: 'Copy share log to clipboard',
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
			name: 'Clear share log',
			callback: () => { this.logger.clear(); },
		});

		// 17. Context menus
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

		// 18. Active-leaf-change: update monitoring status bar
		this.registerEvent(this.app.workspace.on('active-leaf-change', _leaf => {
			this.updateMonitoringStatusBar();
		}));

		// 19. Start scheduler (triggers initial bulk sync)
		this.scheduler.start();
		this.scheduler.triggerBulkSync();

		// If sharing is already paused at startup, the scheduler's bulk sync bails
		// immediately (before calling reconcile), so onChanged would never fire
		// and the status bar would stay "Checking…" forever.  Run planOnly() now to
		// populate the status bar and, if applicable, the startup notice.
		if (candidateStore.isPausedSync()) {
			void bulkSync.planOnly();
		}
	}

	onunload() {
		this.scheduler?.destroy();
		void this.statsTracker?.flush();
		this.store?.close();
	}

	/** Open the browser to begin the Google OAuth flow. */
	async login() {
		const url = this.auth.getAuthorizationUrl();
		window.open(url, '_blank');
	}

	/** Clear local credentials without revoking the Google authorization. Revoking
	 * would invalidate all other connected clients sharing the same Google account. */
	async logout() {
		this.auth.clearSecretStorage();
		this.driveFolderId = '';
		new Notice('Logged out from Google Drive.');
	}

	/** Called by settings tab when driveFolderPath changes. */
	async onDriveFolderPathChange(newPath: string): Promise<void> {
		const oldPath = this.settings.driveFolderPath;
		if (newPath === oldPath) return;

		const hasHistory = this.candidateStore?.hasSyncHistory() ?? false;
		if (hasHistory) {
			const proceed = await ConfirmationModal.prompt(
				this.app,
				'Change group vault',
				`Changing the group vault will log out from <strong>${oldPath}</strong> ` +
				`and require you to log in to <strong>${newPath}</strong>. ` +
				`The plugin will then merge with <strong>${newPath}</strong>. Proceed?`,
			);
			if (!proceed) return;
			await this.candidateStore?.clear();
			await this.store?.clearContent();
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
		await this.candidateStore?.clear();
		await this.store?.clearContent();
		await this.store?.clearStats();
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

	/** Update the persistent deferral status bar item. */
	private updateDeferralStatusBar(): void {
		const count = this.candidateStore?.getPendingCount() ?? null;
		const paused = this.candidateStore?.isPausedSync() ?? false;
		this.deferralStatusBarEl.setText(formatSyncStatus(paused, count));
	}

	/** Show a one-time Notice when the first plan pass finds pending files. */
	private showDeferralNotice(count: number): void {
		const frag = createFragment();
		frag.appendText(`Sharing has ${count} pending file${count === 1 ? '' : 's'} — `);
		const link = frag.createEl('a', { text: 'Tap to review' });
		link.addEventListener('click', () => { void this.activateSharingStatusView(); });
		new Notice(frag);
	}

	/** Show a Notice when the threshold guard defers all changes and pauses sharing. */
	private showThresholdPauseNotice(count: number): void {
		const frag = createFragment();
		frag.appendText(`Sharing paused — ${count} global change${count === 1 ? '' : 's'} deferred for review — `);
		const link = frag.createEl('a', { text: 'Tap to review' });
		link.addEventListener('click', () => { void this.activateSharingStatusView(); });
		new Notice(frag);
	}

	private async resolveDriveFolder(): Promise<string> {
		return this.api.resolveFolder(this.settings.driveFolderPath);
	}

	/** Open (or reveal) the Sharing Status panel in the right sidebar. */
	private async activateSharingStatusView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SHARING_STATUS_VIEW_TYPE);
		if (existing[0]) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		let leaf: WorkspaceLeaf | null = null;
		try {
			leaf = this.app.workspace.getRightLeaf(false);
		} catch {
			return;
		}
		if (!leaf) return;
		await leaf.setViewState({ type: SHARING_STATUS_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Refresh all currently open Sharing Status panels. */
	private refreshSharingStatusViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SHARING_STATUS_VIEW_TYPE)) {
			void (leaf.view as SharingStatusView).refresh();
		}
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
