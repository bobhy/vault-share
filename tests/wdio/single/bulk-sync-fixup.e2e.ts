/**
 * End-to-end tests for the bulk sharing fixup feature (single vault).
 *
 * Prerequisites: same as other single-vault tests — run setup:e2e:wdio once.
 *
 * Test strategy
 * -------------
 * Each test requires a set of files whose sharing operations cover every
 * distinct SyncActionType. The helper {@link setupBulkFixupScenario} creates
 * this set using a two-phase approach:
 *
 * Phase 1 — Baseline sync (threshold disabled):
 *   Create the files needed for delete scenarios locally, then run a bulk sync
 *   so those files have Drive copies and sync records. This establishes the
 *   history the decision engine needs to recognise a delete on either side.
 *
 * Phase 2 — Arrange the full scenario:
 *   - Delete the Phase 1 file from local vault → deleteRemote planned
 *   - Delete the Phase 1 file from Drive      → deleteLocal  planned
 *   - Create local-only files                 → push         planned
 *   - Write Drive-only files via the API      → pull         planned
 *   - Create a file on both sides (different
 *     content, no sync record)                → conflict     planned
 *
 * Then set the modification threshold to 0 and run one more bulk sync.
 * Because any planned action now exceeds the 0 % threshold, all actions are
 * deferred and the sync auto-pauses.  Tests verify the resulting state.
 */

import { runBulkSync } from '../../../wdio.conf.mts';
import type { GDriveApi } from '../../../src/gdrive/api';
import type { DeferralManager } from '../../../src/sync/deferral-manager';
import type { SyncActionType } from '../../../src/sync/types';

// Unique timestamp prefix isolates each test run from prior vault content.
const TS = Date.now();

const PUSH_FILES         = [`bsf-${TS}-push-1.md`, `bsf-${TS}-push-2.md`];
const PULL_FILES         = [`bsf-${TS}-pull-1.md`];
const CONFLICT_FILES     = [`bsf-${TS}-conflict-1.md`];
const DELETE_REMOTE_FILES = [`bsf-${TS}-del-remote-1.md`];
const DELETE_LOCAL_FILES  = [`bsf-${TS}-del-local-1.md`];

// All filenames created during setup, used for cleanup in after().
const ALL_LOCAL_FILES = [...PUSH_FILES, ...CONFLICT_FILES, ...DELETE_LOCAL_FILES];
const ALL_DRIVE_FILES = [...PULL_FILES, ...CONFLICT_FILES, ...DELETE_REMOTE_FILES];

/**
 * Minimal plugin interface used inside executeObsidian callbacks.
 * TypeScript erases this type at compile time, so it is safe to reference
 * in type-annotation positions inside serialised callback bodies.
 */
type PluginHandle = {
	api: GDriveApi;
	driveFolderId: string;
	deferralManager: DeferralManager;
	settings: {
		fileModificationConfirmationMin: number;
		fileModificationConfirmationThreshold: number;
	};
};

/**
 * Pre-loads the local vault and Drive with files that will produce one
 * deferred candidate of every SyncActionType when the next bulk sync runs
 * with the modification threshold set to zero.
 *
 * After this function returns the threshold is already set to 0 / min=1.
 * Call {@link runBulkSync} once to trigger deferral of all planned actions.
 */
async function setupBulkFixupScenario(): Promise<void> {
	// ── Pre-cleanup: remove any bsf- leftovers from previous runs ───────────

	await browser.executeObsidian(async ({ app }) => {
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, PluginHandle> };
		}).plugins.plugins['vault-share']!;
		const folderId = plugin.driveFolderId;

		// Release any stale deferred candidates.
		const grouped = await plugin.deferralManager.getGroupedByType();
		const stalePaths = [...grouped.values()].flatMap(cs => cs.map(c => c.path));
		if (stalePaths.length > 0) await plugin.deferralManager.releaseByPath(stalePaths);
		await plugin.deferralManager.setPaused(false);

		// Delete local bsf- files.
		for (const file of app.vault.getFiles()) {
			if (file.name.startsWith('bsf-')) await app.vault.delete(file);
		}

		// Delete Drive bsf- files.
		const driveFiles = await plugin.api.listChildren(folderId);
		for (const f of driveFiles) {
			if (f.name.startsWith('bsf-')) await plugin.api.deleteFile(f.id);
		}
	});

	// ── Phase 1: create files that need history, sync them ──────────────────

	await browser.executeObsidian(async ({ app }, deleteRemote, deleteLocal) => {
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, PluginHandle> };
		}).plugins.plugins['vault-share']!;
		// Disable the threshold so this baseline sync executes normally.
		plugin.settings.fileModificationConfirmationMin = 100;

		for (const name of [...(deleteRemote as string[]), ...(deleteLocal as string[])]) {
			if (!app.vault.getAbstractFileByPath(name)) {
				await app.vault.create(name, `baseline content — ${name}`);
			}
		}
	}, DELETE_REMOTE_FILES, DELETE_LOCAL_FILES);

	const baseline = await runBulkSync(browser);
	expect(baseline.deferredByThreshold).toBe(false);
	expect(baseline.uploaded).toBeGreaterThanOrEqual(2);

	// ── Phase 2: arrange all remaining operation types ───────────────────────

	await browser.executeObsidian(
		async ({ app }, pushFiles, pullFiles, conflictFiles, deleteRemote, deleteLocal) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			const folderId = plugin.driveFolderId;

			// push — local only, no Drive copy, no record
			for (const name of pushFiles as string[]) {
				if (!app.vault.getAbstractFileByPath(name)) {
					await app.vault.create(name, `push content — ${name}`);
				}
			}

			// pull — Drive only, no local copy, no record
			for (const name of pullFiles as string[]) {
				await plugin.api.writeFile(folderId, name, `pull content — ${name}`);
			}

			// conflict — both sides, different content, no record
			for (const name of conflictFiles as string[]) {
				if (!app.vault.getAbstractFileByPath(name)) {
					await app.vault.create(name, `local version — ${name}`);
				}
				await plugin.api.writeFile(folderId, name, `drive version — ${name}`);
			}

			// deleteRemote — local file deleted; remote + record remain
			for (const name of deleteRemote as string[]) {
				const file = app.vault.getAbstractFileByPath(name);
				if (file) await app.vault.delete(file);
			}

			// deleteLocal — Drive file deleted; local + record remain
			for (const name of deleteLocal as string[]) {
				const f = await plugin.api.findFile(folderId, name);
				if (f) await plugin.api.deleteFile(f.id);
			}

			// Arm the threshold: any non-zero modifyCount will now trigger deferral.
			plugin.settings.fileModificationConfirmationMin = 1;
			plugin.settings.fileModificationConfirmationThreshold = 0;
		},
		PUSH_FILES, PULL_FILES, CONFLICT_FILES, DELETE_REMOTE_FILES, DELETE_LOCAL_FILES,
	);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Bulk sharing fixup', () => {

	before(async () => {
		await setupBulkFixupScenario();

		// Trigger the deferral sync.  With threshold=0, all planned actions are
		// deferred and the manager auto-pauses sharing.
		const result = await runBulkSync(browser);
		expect(result.deferredByThreshold).toBe(true);
	});

	after(async () => {
		// Restore settings and clear deferred state so subsequent test suites
		// start from a clean baseline.
		await browser.executeObsidian(async ({ app }, localFiles, driveFiles) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;

			plugin.settings.fileModificationConfirmationMin = 10;
			plugin.settings.fileModificationConfirmationThreshold = 10;

			// Release all deferred candidates and unpause.
			const grouped = await plugin.deferralManager.getGroupedByType();
			const allPaths = [...grouped.values()].flatMap(cs => cs.map(c => c.path));
			if (allPaths.length > 0) {
				await plugin.deferralManager.releaseByPath(allPaths);
			}
			await plugin.deferralManager.setPaused(false);

			// Delete remaining local test files.
			for (const name of localFiles as string[]) {
				const f = app.vault.getAbstractFileByPath(name);
				if (f) await app.vault.delete(f);
			}

			// Delete remaining Drive test files.
			const folderId = plugin.driveFolderId;
			for (const name of driveFiles as string[]) {
				const f = await plugin.api.findFile(folderId, name);
				if (f) await plugin.api.deleteFile(f.id);
			}
		}, ALL_LOCAL_FILES, ALL_DRIVE_FILES);
	});

	it('auto-pauses sharing when the threshold is exceeded', async () => {
		const paused = await browser.executeObsidian(async ({ app }) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.deferralManager.isPaused();
		}) as unknown as boolean;

		expect(paused).toBe(true);
	});

	it('opens the bulk sharing fixup panel via the command palette', async () => {
		await browser.executeObsidian(({ app }) => {
			(app as unknown as {
				commands: { executeCommandById: (id: string) => void };
			}).commands.executeCommandById('vault-share:open-bulk-sharing-fixup');
		});

		// Allow the async ItemView.onOpen() and refresh() to complete.
		await browser.pause(1000);

		const tableVisible = await browser.executeObsidian(() => {
			return !!activeDocument.querySelector('.vault-share-bulk-status-table');
		}) as unknown as boolean;

		expect(tableVisible).toBe(true);
	});

	it('reflects the expected file presence in local vault and Drive', async () => {
		type FileMatrix = {
			local: Record<string, boolean>;
			drive: Record<string, boolean>;
		};

		const matrix = await browser.executeObsidian(
			async ({ app }, pushFiles, pullFiles, conflictFiles, deleteRemoteFiles, deleteLocalFiles) => {
				const plugin = (app as unknown as {
					plugins: { plugins: Record<string, PluginHandle> };
				}).plugins.plugins['vault-share']!;
				const folderId = plugin.driveFolderId;

				const localHas = (name: string) => app.vault.getAbstractFileByPath(name) !== null;
				const driveHas = async (name: string) =>
					(await plugin.api.findFile(folderId, name)) !== null;

				return {
					local: {
						// push files were created locally and have no Drive copy yet
						pushPresent:        (pushFiles as string[]).every(localHas),
						// pull files were written to Drive only — must not appear locally
						pullAbsent:         !(pullFiles as string[]).some(localHas),
						// conflict files exist on both sides
						conflictPresent:    (conflictFiles as string[]).every(localHas),
						// delete-remote scenario: local file was deleted; must not appear locally
						deleteRemoteAbsent: !(deleteRemoteFiles as string[]).some(localHas),
						// delete-local scenario: Drive was deleted; local file still exists
						deleteLocalPresent: (deleteLocalFiles as string[]).every(localHas),
					},
					drive: {
						// push files have not been synced to Drive yet (deferred)
						pushAbsent:         !(await Promise.all((pushFiles as string[]).map(driveHas))).some(Boolean),
						// pull files were written directly to Drive
						pullPresent:        (await Promise.all((pullFiles as string[]).map(driveHas))).every(Boolean),
						// conflict files were written to Drive during setup
						conflictPresent:    (await Promise.all((conflictFiles as string[]).map(driveHas))).every(Boolean),
						// delete-remote scenario: Drive copy still present (pending deleteRemote action)
						deleteRemotePresent:(await Promise.all((deleteRemoteFiles as string[]).map(driveHas))).every(Boolean),
						// delete-local scenario: Drive copy was deleted during setup
						deleteLocalAbsent:  !(await Promise.all((deleteLocalFiles as string[]).map(driveHas))).some(Boolean),
					},
				} satisfies FileMatrix;
			},
			PUSH_FILES, PULL_FILES, CONFLICT_FILES, DELETE_REMOTE_FILES, DELETE_LOCAL_FILES,
		) as unknown as FileMatrix;

		// Local vault assertions
		expect(matrix.local.pushPresent).toBe(true);
		expect(matrix.local.pullAbsent).toBe(true);
		expect(matrix.local.conflictPresent).toBe(true);
		expect(matrix.local.deleteRemoteAbsent).toBe(true);
		expect(matrix.local.deleteLocalPresent).toBe(true);

		// Drive assertions
		expect(matrix.drive.pushAbsent).toBe(true);
		expect(matrix.drive.pullPresent).toBe(true);
		expect(matrix.drive.conflictPresent).toBe(true);
		expect(matrix.drive.deleteRemotePresent).toBe(true);
		expect(matrix.drive.deleteLocalAbsent).toBe(true);
	});

	it('reports the correct deferred candidate count for each operation type', async () => {
		type Counts = Record<SyncActionType, number>;
		const counts = await browser.executeObsidian(async ({ app }) => {
			const grouped = await (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.deferralManager.getGroupedByType();
			const out: Partial<Counts> = {};
			for (const [type, candidates] of grouped) {
				out[type as SyncActionType] = candidates.length;
			}
			return out;
		}) as unknown as Partial<Counts>;

		expect(counts.push).toBe(PUSH_FILES.length);           // 2
		expect(counts.pull).toBe(PULL_FILES.length);           // 1
		expect(counts.conflict).toBe(CONFLICT_FILES.length);   // 1
		expect(counts.deleteRemote).toBe(DELETE_REMOTE_FILES.length); // 1
		expect(counts.deleteLocal).toBe(DELETE_LOCAL_FILES.length);   // 1
	});

	it('shows the correct per-type counts in the status view table', async () => {
		type Row = { vault: string; operation: string; count: number };
		const rows = await browser.executeObsidian(() => {
			return Array.from(
				activeDocument.querySelectorAll<HTMLTableRowElement>(
					'.vault-share-bulk-status-table tbody tr',
				),
			).map(tr => ({
				vault:     tr.cells[0]?.textContent?.trim() ?? '',
				operation: tr.cells[1]?.textContent?.trim() ?? '',
				count:     Number(tr.cells[2]?.textContent?.trim()),
			}));
		}) as unknown as Row[];

		const byOperation = new Map(rows.map(r => [r.operation, r]));

		expect(byOperation.get('Push local changes to group vault')?.count).toBe(PUSH_FILES.length);
		expect(byOperation.get('Pull group vault changes to local')?.count).toBe(PULL_FILES.length);
		expect(byOperation.get('Resolve file conflicts')?.count).toBe(CONFLICT_FILES.length);
		expect(byOperation.get('Delete from group vault')?.count).toBe(DELETE_REMOTE_FILES.length);
		expect(byOperation.get('Delete from local vault')?.count).toBe(DELETE_LOCAL_FILES.length);
	});
});
