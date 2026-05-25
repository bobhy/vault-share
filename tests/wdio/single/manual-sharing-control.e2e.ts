/**
 * End-to-end tests for the manual sharing control feature (single vault).
 *
 * Prerequisites: same as other single-vault tests — run setup:e2e:wdio once.
 *
 * Test strategy
 * -------------
 * Each test requires a set of files whose sharing operations cover every
 * distinct SyncActionType. The helper {@link setupScenario} creates
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
import type { BulkSync } from '../../../src/sync/bulk-sync';
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

// ── Apply-scenario files ──────────────────────────────────────────────────────
// Four push candidates covering every checkbox-combination in PendingListModal.Apply:
/** Was deferred; user checks its checkbox → released after Apply. */
const APPLY_FILE_A = `bsf-${TS}-apply-a.md`;
/** Was deferred; user leaves checkbox unchecked → stays deferred after Apply. */
const APPLY_FILE_B = `bsf-${TS}-apply-b.md`;
/** Was pending; user unchecks its checkbox → deferred after Apply. */
const APPLY_FILE_C = `bsf-${TS}-apply-c.md`;
/** Was pending; user leaves checkbox checked → stays pending (not deferred) after Apply. */
const APPLY_FILE_D = `bsf-${TS}-apply-d.md`;

/**
 * Minimal plugin interface used inside executeObsidian callbacks.
 * TypeScript erases this type at compile time, so it is safe to reference
 * in type-annotation positions inside serialised callback bodies.
 */
type PluginHandle = {
	api: GDriveApi;
	driveFolderId: string;
	deferralManager: DeferralManager;
	bulkSync: BulkSync;
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
async function setupScenario(): Promise<void> {
	// ── Pre-cleanup: remove any bsf- leftovers from previous runs ───────────

	await browser.executeObsidian(async ({ app }) => {
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, PluginHandle> };
		}).plugins.plugins['vault-share']!;
		const folderId = plugin.driveFolderId;

		// Release any stale deferred candidates and unpause.
		await plugin.deferralManager.releaseAll();
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

// ── Panel open does not auto-pause ───────────────────────────────────────────

describe('Sharing status panel — open behaviour', () => {

	before(async () => {
		// Ensure sharing starts unpaused with no deferred candidates.
		await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			await plugin.deferralManager.releaseAll();
			await plugin.deferralManager.setPaused(false);
		});
	});

	after(async () => {
		// Close any open sharing status panel; sharing should already be unpaused.
		await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			app.workspace.getLeavesOfType('vault-share-sharing-status')
				.forEach(leaf => leaf.detach());
			await plugin.deferralManager.setPaused(false);
		});
	});

	it('does not pause sharing when the panel is opened while sharing is running', async () => {
		// Confirm sharing is running before opening the panel.
		const pausedBefore = await browser.executeObsidian(async ({ app }) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.deferralManager.isPaused();
		}) as unknown as boolean;
		expect(pausedBefore).toBe(false);

		// Open the panel — onOpen() no longer auto-pauses (bfa3f74); it only
		// shows current state and a "Pause sharing" button.
		await browser.executeObsidian(({ app }) => {
			(app as unknown as {
				commands: { executeCommandById: (id: string) => void };
			}).commands.executeCommandById('vault-share:open-sharing-status');
		});

		// Give onOpen() time to complete its refresh() render cycle.
		await browser.pause(500);

		const pausedAfter = await browser.executeObsidian(async ({ app }) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.deferralManager.isPaused();
		}) as unknown as boolean;
		expect(pausedAfter).toBe(false);
	});
});

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Manual sharing control', () => {

	before(async () => {
		await setupScenario();

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
			await plugin.deferralManager.releaseAll();
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

	it('opens the sharing status panel via the command palette', async () => {
		await browser.executeObsidian(({ app }) => {
			(app as unknown as {
				commands: { executeCommandById: (id: string) => void };
			}).commands.executeCommandById('vault-share:open-sharing-status');
		});

		// Sharing is already paused here (from setupScenario), so onOpen() calls
		// planOnly() and renders the candidate table. Poll until it appears rather
		// than a fixed pause so the test is robust against Drive API latency.
		await browser.waitUntil(
			async () => browser.executeObsidian(() =>
				!!activeDocument.querySelector('.vault-share-sharing-status-table'),
			) as unknown as Promise<boolean>,
			{ timeout: 15000, interval: 500, timeoutMsg: 'Sharing status table did not appear within 15 s' },
		);
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

	it('reports the correct pending candidate count for each operation type', async () => {
		type Counts = Record<SyncActionType, number>;
		const counts = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;

			// planOnly() returns the combined list (pending + deferred) tagged with isDeferred.
			// After threshold deferral all candidates are deferred; counts are the same.
			const candidates = await plugin.bulkSync.planOnly();
			const out: Partial<Counts> = {};
			for (const c of candidates) {
				out[c.actionType as SyncActionType] = (out[c.actionType as SyncActionType] ?? 0) + 1;
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
					'.vault-share-sharing-status-table tbody tr',
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

// ── PendingListModal Apply — four checkbox-combination outcomes ───────────────

/**
 * Verifies that PendingListModal.applyAccepted() correctly handles every
 * combination of initial state × user checkbox action:
 *
 * | File | Initial state | User action      | Expected after Apply |
 * |------|--------------|------------------|----------------------|
 * | A    | deferred     | check (accept)   | released (not deferred) |
 * | B    | deferred     | leave unchecked  | still deferred       |
 * | C    | pending      | uncheck (reject) | now deferred         |
 * | D    | pending      | leave checked    | still not deferred   |
 *
 * Setup: create four local push files (Drive-API-free).  A and B are deferred
 * inside the {@link it} body immediately before the panel opens, so the stored
 * mtime (TFile.stat.mtime) matches what reconcile() sees with no race window.
 */
describe('PendingListModal — Apply with mixed deferred/pending push candidates', () => {

	before(async () => {
		// Close any open sharing status panel; release stale deferred state;
		// remove any apply-* leftovers from prior runs.
		await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			app.workspace.getLeavesOfType('vault-share-sharing-status')
				.forEach(leaf => leaf.detach());
			await plugin.deferralManager.releaseAll();
			await plugin.deferralManager.setPaused(false);
			for (const file of app.vault.getFiles()) {
				if (file.name.includes('-apply-')) await app.vault.delete(file);
			}
		});

		// Create all four push files (Drive-API-free) and pause sharing.
		// A and B are NOT yet deferred here — their mtimes are captured in the test
		// body right before the panel opens, avoiding a race where the OS updates the
		// inode mtime between vault.create() and planOnly()/reconcile().
		await browser.executeObsidian(async ({ app }, fileA, fileB, fileC, fileD) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			for (const name of [fileA, fileB, fileC, fileD] as string[]) {
				if (!app.vault.getAbstractFileByPath(name)) {
					await app.vault.create(name, `apply test — ${name}`);
				}
			}
			// Pause sharing so C and D are not pushed before the panel opens.
			await plugin.deferralManager.setPaused(true);
		}, APPLY_FILE_A, APPLY_FILE_B, APPLY_FILE_C, APPLY_FILE_D);
	});

	after(async () => {
		// Close the panel, clear all deferred state, unpause, delete local test files.
		// A, B, C, D were never pushed to Drive, so no Drive cleanup is needed.
		await browser.executeObsidian(async ({ app }, files) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			app.workspace.getLeavesOfType('vault-share-sharing-status')
				.forEach(leaf => leaf.detach());
			await plugin.deferralManager.releaseAll();
			await plugin.deferralManager.setPaused(false);
			for (const name of files as string[]) {
				const f = app.vault.getAbstractFileByPath(name);
				if (f) await app.vault.delete(f);
			}
		}, [APPLY_FILE_A, APPLY_FILE_B, APPLY_FILE_C, APPLY_FILE_D]);
	});

	it('releases deferred, keeps deferred, defers pending, and keeps pending for all four checkbox combinations', async () => {
		// Defer A and B right before the panel opens so the stored mtimes match what
		// localFs.stat() / reconcile() will read.  localFs.stat() uses TFile.stat.mtime
		// (getFileByPath().stat.mtime); doing this after before() completes ensures the
		// OS has finished updating the inode mtime following vault.create().
		await browser.executeObsidian(async ({ app }, fileA, fileB) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			const now = Date.now();
			const toDefer = ([fileA, fileB] as string[]).map(name => ({
				path: name,
				actionType: 'push' as const,
				localMtime: app.vault.getFileByPath(name)?.stat.mtime ?? 0,
				remoteMtime: 0,
				deferredAt: now,
			}));
			await plugin.deferralManager.addDeferred(toDefer);
		}, APPLY_FILE_A, APPLY_FILE_B);

		// Open the sharing status panel (pauses sharing, runs planOnly).
		await browser.executeObsidian(({ app }) => {
			(app as unknown as {
				commands: { executeCommandById: (id: string) => void };
			}).commands.executeCommandById('vault-share:open-sharing-status');
		});

		// Wait for the status table to render (planOnly involves a Drive API call).
		await browser.waitUntil(
			async () => browser.executeObsidian(() =>
				!!activeDocument.querySelector('.vault-share-sharing-status-table'),
			) as unknown as Promise<boolean>,
			{ timeout: 15000, interval: 500, timeoutMsg: 'Sharing status table did not appear within 15 s' },
		);

		// Click the push row to open PendingListModal for the four push candidates.
		await browser.executeObsidian(() => {
			const rows = activeDocument.querySelectorAll<HTMLTableRowElement>(
				'.vault-share-sharing-status-table tbody tr',
			);
			for (const row of rows) {
				if (row.cells[1]?.textContent?.trim() === 'Push local changes to group vault') {
					row.click();
					break;
				}
			}
		});

		// Wait for PendingListModal to appear.
		await browser.waitUntil(
			async () => browser.executeObsidian(() =>
				!!activeDocument.querySelector('.vault-share-pending-modal'),
			) as unknown as Promise<boolean>,
			{ timeout: 5000, interval: 200, timeoutMsg: 'PendingListModal did not appear within 5 s' },
		);

		// Toggle checkboxes to cover all four combinations:
		//   A (deferred → unchecked by default) → check it   → will be released
		//   B (deferred → unchecked by default) → leave as-is → stays deferred
		//   C (pending  → checked by default)   → uncheck it  → will be deferred
		//   D (pending  → checked by default)   → leave as-is → stays not deferred
		await browser.executeObsidian(({ app: _app }, fileAPath, fileCPath) => {
			const a = fileAPath as string;
			const c = fileCPath as string;
			const items = activeDocument.querySelectorAll<HTMLElement>('.vault-share-pending-item');
			for (const li of items) {
				const pathEl = li.querySelector<HTMLElement>('.vault-share-pending-path');
				const cb = li.querySelector<HTMLInputElement>('.vault-share-pending-checkbox');
				if (!pathEl || !cb) continue;
				const path = pathEl.textContent?.trim() ?? '';
				if (path === a) {
					// A was deferred (initially unchecked) → check to release
					cb.checked = true;
					cb.dispatchEvent(new Event('change'));
				} else if (path === c) {
					// C was pending (initially checked) → uncheck to defer
					cb.checked = false;
					cb.dispatchEvent(new Event('change'));
				}
				// B: leave unchecked → stays deferred
				// D: leave checked  → stays not deferred
			}
		}, APPLY_FILE_A, APPLY_FILE_C);

		// Click Apply.
		await browser.executeObsidian(() => {
			const btn = activeDocument.querySelector<HTMLButtonElement>(
				'.vault-share-pending-modal .modal-button-container button.mod-cta',
			);
			btn?.click();
		});

		// Wait for the modal to close — signals that applyAccepted() has fully resolved.
		await browser.waitUntil(
			async () => browser.executeObsidian(() =>
				!activeDocument.querySelector('.vault-share-pending-modal'),
			) as unknown as Promise<boolean>,
			{ timeout: 5000, interval: 200, timeoutMsg: 'PendingListModal did not close within 5 s' },
		);

		// Assert the final deferral state via the in-memory cache (warmed by the panel).
		type DeferralResult = { a: boolean; b: boolean; c: boolean; d: boolean };
		const deferred = await browser.executeObsidian(
			({ app }, fileA, fileB, fileC, fileD) => {
				const dm = (app as unknown as {
					plugins: { plugins: Record<string, PluginHandle> };
				}).plugins.plugins['vault-share']!.deferralManager;
				return {
					a: dm.isDeferredPathSync(fileA as string),
					b: dm.isDeferredPathSync(fileB as string),
					c: dm.isDeferredPathSync(fileC as string),
					d: dm.isDeferredPathSync(fileD as string),
				};
			},
			APPLY_FILE_A, APPLY_FILE_B, APPLY_FILE_C, APPLY_FILE_D,
		) as unknown as DeferralResult;

		expect(deferred.a).toBe(false); // was deferred → user accepted (checked) → released
		expect(deferred.b).toBe(true);  // was deferred → user left unchecked → still deferred
		expect(deferred.c).toBe(true);  // was pending  → user unchecked → now deferred
		expect(deferred.d).toBe(false); // was pending  → user left checked → still not deferred
	});
});
