/**
 * Plugin entry point. Wires together all sync subsystems on `onload` and tears
 * them down on `onunload`. Holds no business logic of its own — every
 * non-trivial decision is delegated to a dedicated module under `src/sync/`,
 * `src/gdrive/`, or `src/ui/`.
 *
 * Construction order in {@link VaultSharePlugin.onload} is load-bearing:
 * settings → auth/API → logger → IDB store → client id → stats → fs adapters →
 * status bar items → drive folder → SyncContext → CandidateStore → BulkSync →
 * Scheduler → views → OAuth handler → settings tab → commands → context menus.
 * Earlier steps construct what later steps depend on; reorder with care.
 *
 * @packageDocumentation
 */
import { MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, VaultShareSettings, migrateSettings } from './settings';
import { GDriveAuth } from './gdrive/auth';
import { GDriveApi } from './gdrive/api';
import { GDriveError } from './gdrive/errors';
import { checkDriveSchema, readDriveSchemaVersion, DRIVE_SCHEMA_VERSION } from './sync/drive-schema';
import { Logger } from './logger';
import { SyncStore } from './sync/store';
import { StatsTracker } from './sync/stats-tracker';
import { resolveClientId } from './sync/client-id';
import { ExcludeMatcher } from './sync/exclude';
import { LocalFs } from './sync/local-fs';
import { DriveFsAdapter } from './sync/drive-fs';
import { BulkSync } from './sync/bulk-sync';
import { CandidateStore } from './sync/candidate-store';
import { SyncActivity } from './sync/sync-activity';
import { SyncScheduler } from './sync/scheduler';
import { SyncContext } from './sync/types';
import { VaultShareSettingTab } from './ui/settings-tab';
import { SharingPanelView, SHARING_STATUS_VIEW_TYPE } from './ui/sharing-panel';
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
	/** Set true on `onLayoutReady`; the scheduler skips bulk sync until then so a
	 * not-yet-loaded vault index can't be misread as mass local deletions. */
	private vaultReady = false;
	private excludeMatcher!: ExcludeMatcher;
	private localFs!: LocalFs;
	private driveFs!: DriveFsAdapter;
	private settingTab!: VaultShareSettingTab;
	private statusBarEl!: HTMLElement;
	private deferralStatusBarEl!: HTMLElement;
	private monitoringStatusBarEl!: HTMLElement;
	private deferralNoticeShown = false;

	async onload() {
		// 1. Settings — migrate the stored shape to the current schema, falling
		// back to defaults for any absent field. See `specs/upgrade-path.md`.
		const { settings, migrated } = migrateSettings(
			await this.loadData(),
			{
				driveFolderPath: `/vault-share/${this.app.vault.getName()}`,
				// Exclude the vault config directory by default.Applied only on first run; a stored
				// `excludeRules` overrides this.
				excludeRules: [this.app.vault.configDir, '.trash'],
			},
		);
		this.settings = settings;

		// Persist the migrated shape so subsequent loads start at the current
		// schema version. Fire-and-forget — a failed save just means the
		// migration is retried on next load, which is idempotent.
		if (migrated) {
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

		// Live activity tracker for the Sharing Status panel's "Current file" /
		// running indicators. Unlike CandidateStore.onChange (which covers
		// persistent state), this carries the transient "a pass is running /
		// syncing file X" signal. Threaded through SyncContext so syncOneFile —
		// the single place every sync path funnels through — owns the per-file
		// "Current file" signal.
		const syncActivity = new SyncActivity();

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
			activity: syncActivity,
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

		// Re-render the Sharing Status panel whenever live activity changes (a bulk
		// pass starts/stops, advances to the next file, or single-file sync runs).
		syncActivity.onChange(() => { this.refreshSharingStatusViews(); });

		// Warm the in-memory cache so isPausedSync() and isDeferred() are accurate
		// from the very first scheduler tick.
		await candidateStore.init();

		// 12. Bulk sync + scheduler
		this.bulkSync = new BulkSync(ctx, this.excludeMatcher, setStatusBar, candidateStore,
			(count) => { this.showThresholdPauseNotice(count); },
			(count) => { this.showSuspectDeletePauseNotice(count); },
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
			isExcludedPath: path => this.excludeMatcher.isExcluded(path),
			isVaultReady: () => this.vaultReady,
		});

		// Keep the panel's "Idle till HH:MM:SS" line responsive to reschedules
		// (trigger, resume, or a completed pass arming the next one).
		this.scheduler.onNextRunChange(() => { this.refreshSharingStatusViews(); });

		// 13. Consolidated sharing panel (log + status in one leaf). It is NOT
		// opened on startup — that would steal focus from the user's default note
		// (e.g. the Daily Note). A ribbon icon and commands open it on demand.
		this.registerView(SHARING_STATUS_VIEW_TYPE, leaf =>
			new SharingPanelView(
				leaf,
				candidateStore,
				bulkSync,
				ctx,
				this.logger,
				() => this.settings.logSeverity,
				severity => {
					// The Logger reads logSeverity on every append, so this takes
					// effect on the next log line without re-wiring anything.
					this.settings.logSeverity = severity;
					void this.saveData(this.settings);
				},
				() => this.scheduler?.getNextBulkSyncAt() ?? 0,
			),
		);
		this.addRibbonIcon('alert-triangle', 'Sharing status', () => {
			void this.activateSharingStatusView();
		});

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
			name: 'Repair Google Drive duplicates',
			callback: () => {
				const folderId = this.driveFolderId;
				if (!folderId) {
					new Notice('Not logged in to Google Drive — cannot repair duplicates.');
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

		// Log and status are now one panel; this command ID is immutable (already
		// published) so it stays, pointing at the consolidated Sharing status panel.
		this.addCommand({
			id: 'open-log-panel',
			name: 'Open log panel',
			callback: () => { void this.activateSharingStatusView(); },
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

		// 18b. Record explicit local deletions so the next bulk sync can trust the
		// resulting deleteRemote instead of deferring it as a suspect (possibly
		// truncated-enumeration) deletion. Folder deletes flag every tracked path
		// beneath them. markLocallyDeleted no-ops for untracked / never-synced
		// paths and for files mid-deleteLocal (plugin-propagated remote deletes).
		this.registerEvent(this.app.vault.on('delete', file => {
			const paths = file instanceof TFolder
				? candidateStore.getAll()
					.filter(c => c.path.startsWith(`${file.path}/`))
					.map(c => c.path)
				: [file.path];
			for (const p of paths) void candidateStore.markLocallyDeleted(p);
		}));

		// 18c. Defer the first bulk sync until the vault is fully loaded. Until then
		// localFs.list() can return an incomplete file set, which would be
		// misread as mass local deletions. The scheduler's heartbeat checks this
		// flag before dispatching any bulk pass.
		this.app.workspace.onLayoutReady(() => { this.vaultReady = true; });

		// 19. Start scheduler (triggers initial bulk sync once the vault is ready)
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

	private showSuspectDeletePauseNotice(count: number): void {
		const frag = createFragment();
		frag.appendText(
			`Sharing paused — ${count} file${count === 1 ? '' : 's'} missing locally without a delete signal. ` +
			`This can mean the vault was still loading or a listing was incomplete, not that you deleted them. ` +
			`Review before they are removed from the group vault — `,
		);
		const link = frag.createEl('a', { text: 'Tap to review' });
		link.addEventListener('click', () => { void this.activateSharingStatusView(); });
		new Notice(frag);
	}

	private async resolveDriveFolder(): Promise<string> {
		const folderId = await this.api.resolveFolder(this.settings.driveFolderPath);
		await this.verifyDriveSchema(folderId);
		return folderId;
	}

	/**
	 * Read the schema version stamped on the shared (group) Drive folder, for
	 * display in the Statistics section. Returns `null` when not connected (no
	 * auth or unresolved folder) or when the read fails — the settings tab shows
	 * that as "Not connected" rather than a number. See `specs/upgrade-path.md`.
	 */
	async getGroupVaultSchemaVersion(): Promise<number | null> {
		if (!this.auth.isAuthenticated || !this.driveFolderId) return null;
		try {
			return await readDriveSchemaVersion(this.api, this.driveFolderId);
		} catch {
			return null;
		}
	}

	/**
	 * Reconcile the shared folder's schema version with this plugin's
	 * {@link DRIVE_SCHEMA_VERSION}. Claims/forward-migrates older folders; on a
	 * folder written by a newer plugin this is a non-recoverable condition — it
	 * shows an acknowledgement modal that disables the plugin on dismissal, and
	 * throws so the caller leaves `driveFolderId` empty and no sync runs in the
	 * interim. See `specs/upgrade-path.md`.
	 */
	private async verifyDriveSchema(folderId: string): Promise<void> {
		const check = await checkDriveSchema(this.api, folderId);
		switch (check.status) {
			case 'ok':
				break;
			case 'stamped':
				this.logger.info(`Stamped shared Drive folder with schema version ${DRIVE_SCHEMA_VERSION}`);
				break;
			case 'migrated':
				this.logger.info(`Migrated shared Drive folder schema from version ${check.from} to ${DRIVE_SCHEMA_VERSION}`);
				break;
			case 'tooNew': {
				const msg = `This shared vault was upgraded by a newer version of Vault Share `
					+ `(folder schema version ${check.folderVersion}; this plugin supports ${DRIVE_SCHEMA_VERSION}). `
					+ `Update the plugin to continue sharing this vault.`;
				this.logger.error('Shared Drive folder schema is newer than supported', msg);
				// Inform-and-disable. Not awaited: the throw below gates sync
				// immediately, while the modal resolves seconds later — well
				// after onload() has returned, so self-disable is safe.
				void ConfirmationModal.alert(this.app, 'Vault Share needs an update', msg, 'OK')
					.then(() => { this.disableSelf(); });
				throw new GDriveError(
					`Drive folder schema version ${check.folderVersion} is newer than supported ${DRIVE_SCHEMA_VERSION}`,
					'unknown',
				);
			}
		}
	}

	/**
	 * Disable this plugin from within after a non-recoverable condition.
	 * `app.plugins` is an internal API absent from the public typings; the cast
	 * is narrowed to the single method used and guarded so a future API change
	 * degrades to a no-op rather than throwing.
	 */
	private disableSelf(): void {
		const plugins = (this.app as unknown as {
			plugins?: { disablePlugin?: (id: string) => Promise<void> };
		}).plugins;
		void plugins?.disablePlugin?.(this.manifest.id);
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

	/** Refresh all currently open Sharing status panels. */
	private refreshSharingStatusViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SHARING_STATUS_VIEW_TYPE)) {
			// A leaf restored from a saved layout is a lightweight DeferredView until
			// the user visits it (Obsidian ≥ 1.7.7) — it has no refresh(). Skip those;
			// they render fresh from current state when activated.
			if (leaf.view instanceof SharingPanelView) leaf.view.refresh();
		}
	}
}
