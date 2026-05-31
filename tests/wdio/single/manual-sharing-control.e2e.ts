/**
 * E2e tests for manual sharing control (single vault).
 *
 * Tests cover the full planning → deferral → approval → execution pipeline
 * via the plugin's {@link CandidateStore} and {@link BulkSync} APIs, without
 * driving the UI.  A brief UI smoke test verifies the sharing status panel
 * renders, but all business-logic assertions use the programmatic API.
 *
 * Prerequisites: same as other single-vault tests — run setup:e2e:wdio once.
 *
 * Test strategy
 * -------------
 * Each `describe` block is self-contained with `before`/`after` hooks.
 *
 * `setupScenario` (used by the threshold-deferral suite) builds one
 * candidate of every SyncActionType using a two-phase approach:
 *
 * Phase 1 — Baseline sync (threshold disabled):
 *   Create files needed for delete scenarios, then bulk-sync so the
 *   CandidateStore records them as Synced with Drive copies.
 *
 * Phase 2 — Arrange all action types:
 *   - Delete Phase-1 file from local vault  → deleteRemote planned
 *   - Delete Phase-1 Drive copy             → deleteLocal  planned
 *   - Create local-only files               → push         planned
 *   - Write Drive-only files via the API    → pull         planned
 *   - Create file on both sides, diff content → conflict   planned
 *
 * Then set the threshold to 0 and run one bulk sync; all actions are
 * deferred and the store auto-pauses.
 */

import { runBulkSync, seedSyncedFiles } from '../../../wdio.conf.mts';
import type { GDriveApi } from '../../../src/gdrive/api';
import type { CandidateStore } from '../../../src/sync/candidate-store';
import type { BulkSync } from '../../../src/sync/bulk-sync';
import type { SyncActionType } from '../../../src/sync/types';

// Unique timestamp prefix isolates each test run from prior vault content.
const TS = Date.now();

// ── Files for the all-action-types scenario ──────────────────────────────────
const PUSH_FILES          = [`bsf-${TS}-push-1.md`, `bsf-${TS}-push-2.md`];
const PULL_FILES          = [`bsf-${TS}-pull-1.md`];
const CONFLICT_FILES      = [`bsf-${TS}-conflict-1.md`];
const DELETE_REMOTE_FILES = [`bsf-${TS}-del-remote-1.md`];
const DELETE_LOCAL_FILES  = [`bsf-${TS}-del-local-1.md`];

const ALL_LOCAL_FILES = [...PUSH_FILES, ...CONFLICT_FILES, ...DELETE_LOCAL_FILES];
const ALL_DRIVE_FILES = [...PULL_FILES, ...CONFLICT_FILES, ...DELETE_REMOTE_FILES];

// ── Files for the selective defer / approve / execute scenario ───────────────
/** Deferred, then approved → executes on the approved run. */
const DEFER_A = `bsf-${TS}-defer-a.md`;
/** Deferred and stays deferred → never executed. */
const DEFER_B = `bsf-${TS}-defer-b.md`;
/** Pending, then deferred → skipped on the normal run. */
const DEFER_C = `bsf-${TS}-defer-c.md`;
/** Pending and stays pending → executes on the normal run. */
const DEFER_D = `bsf-${TS}-defer-d.md`;

/** File used by the auto-revocation suite. */
const AUTO_REVOKE_FILE = `bsf-${TS}-revoke.md`;

/**
 * Minimal plugin interface for use inside `executeObsidian` callbacks.
 * TypeScript erases this type at compile time; it is safe to reference in
 * type-annotation positions inside serialised callback bodies.
 */
type PluginHandle = {
	api: GDriveApi;
	driveFolderId: string;
	candidateStore: CandidateStore;
	bulkSync: BulkSync;
	settings: {
		globalChangeMin: number;
		globalChangeThreshold: number;
	};
};

/**
 * Loads local vault and Drive with files covering all five SyncActionTypes.
 * After this function the modification threshold is 0 / min = 1; the next
 * `bulkSync.run()` call will defer all planned actions and auto-pause.
 *
 * Phase 1 preloads sync history directly via {@link seedSyncedFiles} rather
 * than running a baseline `bulkSync.run()`. The point of these tests is the
 * behaviour that follows a known initial state — driving the system under
 * test to construct that state is a circular dependency and a source of
 * flakiness (see scheduler-race rabbit hole).
 */
async function setupScenario(): Promise<void> {
	// ── Pre-cleanup: reset candidate state and remove any local bsf- files ───
	//
	// We do NOT do a Drive-wide bsf- scan here. Each run uses a unique `TS`
	// prefix so files from prior runs cannot interfere. A Drive-wide
	// api.listChildren() call on a folder that has accumulated many previous-run
	// files is slow and can hang the test suite.  Instead the after() hook of
	// each describe block cleans up the specific Drive files created by that run.
	await browser.executeObsidian(async ({ app }) => {
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, PluginHandle> };
		}).plugins.plugins['vault-share']!;

		await plugin.candidateStore.clear();
		await plugin.candidateStore.setPaused(false);

		for (const file of app.vault.getFiles()) {
			if (file.name.startsWith('bsf-')) await app.vault.delete(file);
		}
	});

	// ── Phase 1: preload sync history for the delete-scenario files ──────────
	// After this returns, both files exist locally and in Drive with matching
	// content, and their candidates are in state `Synced`. Phase 2 will then
	// delete one side of each so the next planning pass produces deleteRemote
	// and deleteLocal candidates respectively.
	await seedSyncedFiles(browser, [
		...DELETE_REMOTE_FILES.map(p => ({ path: p, content: `baseline content — ${p}` })),
		...DELETE_LOCAL_FILES.map(p  => ({ path: p, content: `baseline content — ${p}` })),
	]);

	// ── Phase 2: arrange all five action types ────────────────────────────────
	await browser.executeObsidian(
		async ({ app }, pushFiles, pullFiles, conflictFiles, deleteRemote, deleteLocal) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			const folderId = plugin.driveFolderId;

			// push — local only, no Drive copy, no sync record.
			for (const name of pushFiles as string[]) {
				if (!app.vault.getAbstractFileByPath(name))
					await app.vault.create(name, `push content — ${name}`);
			}

			// pull — Drive only, no local copy, no sync record.
			for (const name of pullFiles as string[]) {
				await plugin.api.writeFile(folderId, name, `pull content — ${name}`);
			}

			// conflict — both sides with different content AND different byte
			// sizes, no sync record. The byte-size difference is load-bearing:
			// `planAction`'s no-history path treats matching-size both-present
			// as a rebaseline (sync-review-followups item 17), so the conflict
			// branch only fires when sizes differ. The earlier `'local version
			// — ' / 'drive version — '` templates happened to be byte-identical
			// (both 18 bytes UTF-8), which would now rebaseline-as-Synced and
			// defeat the threshold scenario this test is checking.
			for (const name of conflictFiles as string[]) {
				if (!app.vault.getAbstractFileByPath(name))
					await app.vault.create(name, `local version — ${name}`);
				await plugin.api.writeFile(folderId, name, `drive-side variant with extra characters — ${name}`);
			}

			// deleteRemote — local file deleted; Drive copy + sync record remain.
			for (const name of deleteRemote as string[]) {
				const file = app.vault.getAbstractFileByPath(name);
				if (file) await app.vault.delete(file);
			}

			// deleteLocal — Drive copy deleted; local file + sync record remain.
			for (const name of deleteLocal as string[]) {
				const f = await plugin.api.findFile(folderId, name);
				if (f) await plugin.api.deleteFile(f.id);
			}

			// Arm the threshold: any planned action will trigger deferral.
			plugin.settings.globalChangeMin = 1;
			plugin.settings.globalChangeThreshold = 0;
		},
		PUSH_FILES, PULL_FILES, CONFLICT_FILES, DELETE_REMOTE_FILES, DELETE_LOCAL_FILES,
	);
}

// ── Sharing status panel smoke test ──────────────────────────────────────────

describe('Sharing status panel — open does not auto-pause', () => {
	before(async () => {
		await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			await plugin.candidateStore.clear();
			await plugin.candidateStore.setPaused(false);
		});
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			app.workspace.getLeavesOfType('vault-share-sharing-status')
				.forEach(leaf => leaf.detach());
			await plugin.candidateStore.setPaused(false);
		});
	});

	it('does not pause sharing when the panel is opened while sharing is running', async () => {
		const pausedBefore = await browser.executeObsidian(({ app }) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore.isPausedSync();
		}) as unknown as boolean;
		expect(pausedBefore).toBe(false);

		// Open the panel — onOpen() must not auto-pause sharing.
		await browser.executeObsidian(({ app }) => {
			(app as unknown as {
				commands: { executeCommandById: (id: string) => void };
			}).commands.executeCommandById('vault-share:open-sharing-status');
		});

		// Give onOpen() time to complete its refresh() render cycle.
		await browser.pause(500);

		const pausedAfter = await browser.executeObsidian(({ app }) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore.isPausedSync();
		}) as unknown as boolean;
		expect(pausedAfter).toBe(false);
	});
});

// ── Threshold deferral ────────────────────────────────────────────────────────

describe('Threshold deferral — all action types deferred on threshold breach', () => {
	before(async () => {
		await setupScenario();
		// With threshold=0, every planned action triggers deferral.
		const result = await runBulkSync(browser);
		expect(result.deferredByThreshold).toBe(true);
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }, localFiles, driveFiles) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;

			plugin.settings.globalChangeMin = 10;
			plugin.settings.globalChangeThreshold = 10;

			await plugin.candidateStore.clear();
			await plugin.candidateStore.setPaused(false);

			for (const name of localFiles as string[]) {
				const f = app.vault.getAbstractFileByPath(name);
				if (f) await app.vault.delete(f);
			}
			const folderId = plugin.driveFolderId;
			for (const name of driveFiles as string[]) {
				const f = await plugin.api.findFile(folderId, name);
				if (f) await plugin.api.deleteFile(f.id);
			}
		}, ALL_LOCAL_FILES, ALL_DRIVE_FILES);
	});

	it('auto-pauses sharing when the threshold is exceeded', async () => {
		const paused = await browser.executeObsidian(({ app }) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore.isPausedSync();
		}) as unknown as boolean;
		expect(paused).toBe(true);
	});

	it('transitions all planned candidates to Deferred state', async () => {
		const states = await browser.executeObsidian(({ app }) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore.getAll().map(c => c.state);
		}) as unknown as string[];

		expect(states.length).toBeGreaterThan(0);
		expect(states.every(s => s === 'Deferred')).toBe(true);
	});

	it('has one candidate for each expected action type', async () => {
		type Counts = Partial<Record<SyncActionType, number>>;
		const counts = await browser.executeObsidian(({ app }) => {
			const cs = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore;
			const out: Counts = {};
			for (const c of cs.getAll()) {
				out[c.actionType as SyncActionType] =
					(out[c.actionType as SyncActionType] ?? 0) + 1;
			}
			return out;
		}) as unknown as Counts;

		expect(counts.push).toBe(PUSH_FILES.length);
		expect(counts.pull).toBe(PULL_FILES.length);
		expect(counts.conflict).toBe(CONFLICT_FILES.length);
		expect(counts.deleteRemote).toBe(DELETE_REMOTE_FILES.length);
		expect(counts.deleteLocal).toBe(DELETE_LOCAL_FILES.length);
	});

	it('renders the sharing status table with the correct per-type counts', async () => {
		// Open the panel; sharing is paused so planOnly() runs without executing.
		await browser.executeObsidian(({ app }) => {
			(app as unknown as {
				commands: { executeCommandById: (id: string) => void };
			}).commands.executeCommandById('vault-share:open-sharing-status');
		});

		await browser.waitUntil(
			async () => browser.executeObsidian(() =>
				!!activeDocument.querySelector('.vault-share-sharing-status-table'),
			) as unknown as Promise<boolean>,
			{ timeout: 15000, interval: 500, timeoutMsg: 'Sharing status table did not appear within 15 s' },
		);

		type Row = { operation: string; count: number };
		const rows = await browser.executeObsidian(() =>
			Array.from(
				activeDocument.querySelectorAll<HTMLTableRowElement>(
					'.vault-share-sharing-status-table tbody tr',
				),
			).map(tr => ({
				operation: tr.cells[1]?.textContent?.trim() ?? '',
				count:     Number(tr.cells[2]?.textContent?.trim()),
			})),
		) as unknown as Row[];

		const byOp = new Map(rows.map(r => [r.operation, r]));
		expect(byOp.get('Push local changes to group vault')?.count).toBe(PUSH_FILES.length);
		expect(byOp.get('Pull group vault changes to local')?.count).toBe(PULL_FILES.length);
		expect(byOp.get('Resolve file conflicts')?.count).toBe(CONFLICT_FILES.length);
		expect(byOp.get('Delete from group vault')?.count).toBe(DELETE_REMOTE_FILES.length);
		expect(byOp.get('Delete from local vault')?.count).toBe(DELETE_LOCAL_FILES.length);

		await browser.executeObsidian(({ app }) => {
			app.workspace.getLeavesOfType('vault-share-sharing-status')
				.forEach(leaf => leaf.detach());
		});
	});
});

// ── Selective defer / approve / execute ──────────────────────────────────────

/**
 * Verifies that CandidateStore correctly gates which candidates execute:
 *
 * | File | Journey                                    | Expected in Drive |
 * |------|--------------------------------------------|-------------------|
 * | A    | Default → deferred → approved              | yes (approved run)|
 * | B    | Default → deferred → stays deferred        | no                |
 * | C    | Default → deferred                         | no                |
 * | D    | Default → stays pending                    | yes (normal run)  |
 */
describe('Selective defer and approve — candidate execution control', () => {
	before(async () => {
		// Clean state, create four local push files, and populate the store.
		await browser.executeObsidian(async ({ app }, files) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;

			await plugin.candidateStore.clear();
			await plugin.candidateStore.setPaused(false);
			// Disable threshold so normal planning runs execute.
			plugin.settings.globalChangeMin = 100;

			for (const name of files as string[]) {
				if (!app.vault.getAbstractFileByPath(name))
					await app.vault.create(name, `defer test — ${name}`);
			}

			// planOnly() populates candidates for all four files as Default(push).
			await plugin.bulkSync.planOnly();
		}, [DEFER_A, DEFER_B, DEFER_C, DEFER_D]);
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }, files) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;

			await plugin.candidateStore.clear();
			await plugin.candidateStore.setPaused(false);
			plugin.settings.globalChangeMin = 10;
			plugin.settings.globalChangeThreshold = 10;

			for (const name of files as string[]) {
				const f = app.vault.getAbstractFileByPath(name);
				if (f) await app.vault.delete(f);
			}
			const folderId = plugin.driveFolderId;
			for (const name of files as string[]) {
				const f = await plugin.api.findFile(folderId, name);
				if (f) await plugin.api.deleteFile(f.id);
			}
		}, [DEFER_A, DEFER_B, DEFER_C, DEFER_D]);
	});

	it('defer([A,B,C]) marks them Deferred while D remains Default', async () => {
		await browser.executeObsidian(async ({ app }, a, b, c) => {
			const cs = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore;
			await cs.defer([a as string, b as string, c as string]);
		}, DEFER_A, DEFER_B, DEFER_C);

		type States = { a: string; b: string; c: string; d: string };
		const states = await browser.executeObsidian(({ app }, a, b, c, d) => {
			const cs = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore;
			const get = (path: string) =>
				cs.getAll().find(x => x.path === path)?.state ?? 'missing';
			return {
				a: get(a as string),
				b: get(b as string),
				c: get(c as string),
				d: get(d as string),
			};
		}, DEFER_A, DEFER_B, DEFER_C, DEFER_D) as unknown as States;

		expect(states.a).toBe('Deferred');
		expect(states.b).toBe('Deferred');
		expect(states.c).toBe('Deferred');
		expect(states.d).toBe('Default');
	});

	it('D (pending) is pushed to Drive; A, B, C (deferred) are not', async () => {
		// Scheduler is stopped (see wdio.conf.mts injectAndConfigure), so this
		// run is the sole driver. uploaded must include D.
		const result = await runBulkSync(browser);
		expect(result.uploaded).toBeGreaterThanOrEqual(1);

		// Confirm D landed in Drive.
		const dPushed = await browser.executeObsidian(async ({ app }, d) => {
			const p = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			return !!(await p.api.findFile(p.driveFolderId, d as string));
		}, DEFER_D) as unknown as boolean;
		expect(dPushed).toBe(true);

		// A, B, C must not have been pushed (they are Deferred).
		type Absence = { a: boolean; b: boolean; c: boolean };
		const absent = await browser.executeObsidian(async ({ app }, a, b, c) => {
			const p = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			const missing = async (n: string) => !(await p.api.findFile(p.driveFolderId, n as string));
			return { a: await missing(a as string), b: await missing(b as string), c: await missing(c as string) };
		}, DEFER_A, DEFER_B, DEFER_C) as unknown as Absence;

		expect(absent.a).toBe(true); // deferred — not pushed
		expect(absent.b).toBe(true); // deferred — not pushed
		expect(absent.c).toBe(true); // deferred — not pushed
	});

	it('candidateStore.approve([A]) transitions A to Approved; B remains Deferred', async () => {
		await browser.executeObsidian(async ({ app }, a) => {
			const cs = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore;
			await cs.approve([a as string]);
		}, DEFER_A);

		type States = { a: string; b: string };
		const states = await browser.executeObsidian(({ app }, a, b) => {
			const cs = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore;
			const get = (path: string) =>
				cs.getAll().find(x => x.path === path)?.state ?? 'missing';
			return { a: get(a as string), b: get(b as string) };
		}, DEFER_A, DEFER_B) as unknown as States;

		expect(states.a).toBe('Approved');
		expect(states.b).toBe('Deferred');
	});

	it('approved A is pushed to Drive; B and C (deferred) remain absent', async () => {
		// Scheduler is stopped — this run drives the approved path for A.
		const result = await runBulkSync(browser);
		expect(result.uploaded).toBeGreaterThanOrEqual(1);

		// Confirm A landed in Drive via the approved-execution path.
		const aPushed = await browser.executeObsidian(async ({ app }, a) => {
			const p = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			return !!(await p.api.findFile(p.driveFolderId, a as string));
		}, DEFER_A) as unknown as boolean;
		expect(aPushed).toBe(true);

		// B and C must still be absent — they are Deferred and were never approved.
		type Absence = { b: boolean; c: boolean };
		const absent = await browser.executeObsidian(async ({ app }, b, c) => {
			const p = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			const missing = async (n: string) => !(await p.api.findFile(p.driveFolderId, n as string));
			return { b: await missing(b as string), c: await missing(c as string) };
		}, DEFER_B, DEFER_C) as unknown as Absence;

		expect(absent.b).toBe(true); // still deferred
		expect(absent.c).toBe(true); // still deferred
	});
});

// ── Deferred auto-revocation ──────────────────────────────────────────────────

describe('Deferred auto-revocation — file modification reverts candidate to pending', () => {
	before(async () => {
		await browser.executeObsidian(async ({ app }, name) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			await plugin.candidateStore.clear();
			await plugin.candidateStore.setPaused(false);
			if (!app.vault.getAbstractFileByPath(name as string))
				await app.vault.create(name as string, 'initial content');
		}, AUTO_REVOKE_FILE);
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }, name) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			await plugin.candidateStore.clear();
			await plugin.candidateStore.setPaused(false);
			const f = app.vault.getAbstractFileByPath(name as string);
			if (f) await app.vault.delete(f);
		}, AUTO_REVOKE_FILE);
	});

	it('revokes deferral and returns the candidate to Default when the local file is modified', async () => {
		// Populate candidate and immediately defer it.
		await browser.executeObsidian(async ({ app }, name) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!;
			await plugin.bulkSync.planOnly();
			await plugin.candidateStore.defer([name as string]);
		}, AUTO_REVOKE_FILE);

		const deferredBefore = await browser.executeObsidian(({ app }, name) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore.isDeferred(name as string);
		}, AUTO_REVOKE_FILE) as unknown as boolean;
		expect(deferredBefore).toBe(true);

		// Modify the file locally — changes its mtime.
		await browser.executeObsidian(async ({ app }, name) => {
			const file = app.vault.getFileByPath(name as string);
			if (!file) throw new Error(`${name} not found in vault`);
			await app.vault.modify(file, 'modified content');
		}, AUTO_REVOKE_FILE);

		// planOnly() → reconcile sees the changed mtime → revokes deferral.
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.bulkSync.planOnly();
		});

		const deferredAfter = await browser.executeObsidian(({ app }, name) => {
			return (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore.isDeferred(name as string);
		}, AUTO_REVOKE_FILE) as unknown as boolean;
		expect(deferredAfter).toBe(false);

		// Candidate should now be Default(push), ready to execute on next run.
		type CandState = { state: string; actionType: string } | undefined;
		const cand = await browser.executeObsidian(({ app }, name) => {
			const cs = (app as unknown as {
				plugins: { plugins: Record<string, PluginHandle> };
			}).plugins.plugins['vault-share']!.candidateStore;
			const c = cs.getAll().find(x => x.path === name);
			return c ? { state: c.state, actionType: c.actionType } : undefined;
		}, AUTO_REVOKE_FILE) as unknown as CandState;

		expect(cand?.state).toBe('Default');
		expect(cand?.actionType).toBe('push');
	});
});
