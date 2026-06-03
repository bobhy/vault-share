/**
 * Initial, no-history bulk sync — the three "alignment" scenarios.
 *
 * Reproduction harness for the reported misbehaviour where bulk sync deletes
 * group-vault files and then re-pushes them when sync history is absent or out
 * of alignment with a fresh local or group vault.
 *
 * Each scenario constructs its initial conditions *directly* (no `runBulkSync`
 * in the arrange phase — see specs/testing-e2e.md) and then asserts the
 * invariants from specs/sync-model.md:
 *
 *   Scenario 1 — populated local, empty group, no history  → push only (inv. 2)
 *   Scenario 2 — empty local, populated group, no history  → pull only (inv. 3)
 *   Scenario 3 — identical files both sides, no history     → rebaseline (inv. 4)
 *
 * For every scenario the first pass must do exactly the expected work with ZERO
 * deletes, and the candidate store must end with every path `Synced` / `noOp`.
 * A second pass must be a complete no-op (inv. 5) — no boomerang.
 */

import { cleanupTestDriveFolder, runBulkSync } from "../../../wdio.conf.mts";
import type { DriveFsAdapter } from "../../../src/sync/drive-fs";

/** Number of files per scenario. The bug surfaced at scale; ~100 is the target. */
const FILE_COUNT = 100;

type NameContent = [string, string];

/** Build `count` flat file specs under a unique prefix. */
function makeFiles(prefix: string, count: number, body: (i: number) => string): NameContent[] {
	const files: NameContent[] = [];
	for (let i = 0; i < count; i++) {
		files.push([`${prefix}/note-${i}.md`, body(i)]);
	}
	return files;
}

/** A flattened candidate view that survives the WebDriver JSON boundary. */
interface CandidateView {
	path: string;
	state: string;
	actionType: string;
}

// ── Direct state construction (arrange-phase only) ──────────────────────────

/** Create files in the local vault, creating parent folders as needed. */
async function createLocalFiles(files: NameContent[]): Promise<void> {
	await browser.executeObsidian(async ({ app }, fs) => {
		const dirs = new Set<string>();
		for (const [p] of fs as NameContent[]) {
			const parts = p.split("/");
			for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
		}
		for (const dir of [...dirs].sort()) {
			if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
		}
		for (const [p, c] of fs as NameContent[]) {
			if (!app.vault.getFileByPath(p)) await app.vault.create(p, c);
		}
	}, files);
}

/** Upload files straight to Drive (bypasses sync), in small concurrent batches. */
async function createDriveFiles(files: NameContent[]): Promise<void> {
	await browser.executeObsidian(async ({ app }, fs) => {
		type Plugin = {
			driveFolderId: string;
			api: { writeFile: (parentId: string, name: string, content: string) => Promise<{ id: string }> };
		};
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"];
		if (!plugin) throw new Error("vault-share plugin not loaded");
		const folderId = plugin.driveFolderId;
		const list = fs as NameContent[];
		const BATCH = 10;
		for (let i = 0; i < list.length; i += BATCH) {
			await Promise.all(
				list.slice(i, i + BATCH).map(([name, content]) => plugin.api.writeFile(folderId, name, content)),
			);
		}
	}, files);
}

/**
 * Full reset between scenarios: delete every local file, clear the candidate
 * store (wipes all sync history → "no history"), un-pause, and empty Drive.
 */
async function resetAll(): Promise<void> {
	await browser.executeObsidian(async ({ app }) => {
		type Plugin = { candidateStore: { clear: () => Promise<void>; setPaused: (b: boolean) => Promise<void> } };
		for (const f of app.vault.getFiles()) await app.vault.delete(f);
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"];
		if (!plugin) throw new Error("vault-share plugin not loaded");
		await plugin.candidateStore.clear();
		await plugin.candidateStore.setPaused(false);
	});
	await cleanupTestDriveFolder(browser);
}

// ── Inspection (assert-phase) ───────────────────────────────────────────────

/** All candidates whose path starts with `prefix`, flattened to {path,state,actionType}. */
async function candidatesUnder(prefix: string): Promise<CandidateView[]> {
	return await browser.executeObsidian(({ app }, pfx) => {
		type Candidate = { path: string; state: string; actionType: string };
		type Plugin = { candidateStore: { getAll: () => Candidate[] } };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"];
		if (!plugin) throw new Error("vault-share plugin not loaded");
		return plugin.candidateStore.getAll()
			.filter(c => c.path.startsWith(pfx as string))
			.map(c => ({ path: c.path, state: c.state, actionType: c.actionType }));
	}, prefix) as unknown as CandidateView[];
}

/** Local vault paths under `prefix`. */
async function localFilesUnder(prefix: string): Promise<string[]> {
	return await browser.executeObsidian(({ app }, pfx) =>
		app.vault.getFiles().map(f => f.path).filter(p => p.startsWith(pfx as string)),
	prefix) as unknown as string[];
}

/** Drive paths under `prefix` (walks the whole test folder). */
async function driveFilesUnder(prefix: string): Promise<string[]> {
	return await browser.executeObsidian(async ({ app }, pfx) => {
		type Plugin = { driveFolderId: string; driveFs: DriveFsAdapter };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"];
		if (!plugin) throw new Error("vault-share plugin not loaded");
		const { files } = await plugin.driveFs.listAll(plugin.driveFolderId);
		return files.map(f => f.path).filter(p => p.startsWith(pfx as string));
	}, prefix) as unknown as string[];
}

/** Assert every candidate under `prefix` is the converged Synced/noOp resting state. */
function expectAllSynced(candidates: CandidateView[], expectedCount: number): void {
	expect(candidates).toHaveLength(expectedCount);
	// Any non-converged candidate is a failure; surface its path/state/actionType
	// in the message since expect-webdriverio's matchers take no message argument.
	const notConverged = candidates.filter(c => c.state !== "Synced" || c.actionType !== "noOp");
	if (notConverged.length > 0) {
		throw new Error(
			`expected all candidates Synced/noOp; ${notConverged.length} were not: ` +
			notConverged.slice(0, 10).map(c => `${c.path}=${c.state}/${c.actionType}`).join(", "),
		);
	}
}

// ── Scenarios ───────────────────────────────────────────────────────────────

describe("Initial no-history bulk sync", () => {
	// Scenario 1 — populated local, empty group, no history → push only.
	describe("Scenario 1: all files local, empty group vault", () => {
		const prefix = `s1-${Date.now()}`;
		const files = makeFiles(prefix, FILE_COUNT, i => `local-only note ${i}`);

		before(async () => {
			await resetAll();
			await createLocalFiles(files);
		});

		it("first pass pushes every file with zero deletes and zero pulls", async () => {
			const r = await runBulkSync(browser);
			expect(r.deferredByThreshold).toBe(false);
			expect(r.uploaded).toBe(FILE_COUNT);
			expect(r.deleted).toBe(0);
			expect(r.downloaded).toBe(0);
			expect(r.conflicts).toBe(0);
			expect(r.failed).toBe(0);

			// Group vault now mirrors local; candidate store is fully converged.
			expect(await driveFilesUnder(prefix)).toHaveLength(FILE_COUNT);
			expectAllSynced(await candidatesUnder(prefix), FILE_COUNT);
		});

		it("second pass is a no-op (no boomerang)", async () => {
			const r = await runBulkSync(browser);
			expect(r.uploaded).toBe(0);
			expect(r.downloaded).toBe(0);
			expect(r.deleted).toBe(0);
			expect(r.conflicts).toBe(0);
			expect(r.failed).toBe(0);
			expectAllSynced(await candidatesUnder(prefix), FILE_COUNT);
		});
	});

	// Scenario 2 — empty local, populated group, no history → pull only.
	describe("Scenario 2: all files in group vault, empty local vault", () => {
		const prefix = `s2-${Date.now()}`;
		const files = makeFiles(prefix, FILE_COUNT, i => `group-only note ${i}`);

		before(async () => {
			await resetAll();
			await createDriveFiles(files);
		});

		it("first pass pulls every file with zero deletes and zero pushes", async () => {
			const r = await runBulkSync(browser);
			expect(r.deferredByThreshold).toBe(false);
			expect(r.downloaded).toBe(FILE_COUNT);
			expect(r.deleted).toBe(0);
			expect(r.uploaded).toBe(0);
			expect(r.conflicts).toBe(0);
			expect(r.failed).toBe(0);

			// Local vault now mirrors the group; candidate store is fully converged.
			expect(await localFilesUnder(prefix)).toHaveLength(FILE_COUNT);
			expectAllSynced(await candidatesUnder(prefix), FILE_COUNT);
		});

		it("second pass is a no-op (no boomerang)", async () => {
			const r = await runBulkSync(browser);
			expect(r.uploaded).toBe(0);
			expect(r.downloaded).toBe(0);
			expect(r.deleted).toBe(0);
			expect(r.conflicts).toBe(0);
			expect(r.failed).toBe(0);
			expectAllSynced(await candidatesUnder(prefix), FILE_COUNT);
		});
	});

	// Scenario 3 — identical content both sides, no history → rebaseline only.
	describe("Scenario 3: identical files in local AND group vaults, no history", () => {
		const prefix = `s3-${Date.now()}`;
		// Identical content on both sides → equal byte sizes → size-equality
		// rebaseline records each path as Synced without moving any bytes.
		const files = makeFiles(prefix, FILE_COUNT, i => `identical note ${i}`);

		before(async () => {
			await resetAll();
			await createLocalFiles(files);
			await createDriveFiles(files);
		});

		it("first pass rebaselines everything — zero pushes, pulls, deletes, conflicts", async () => {
			const r = await runBulkSync(browser);
			expect(r.deferredByThreshold).toBe(false);
			expect(r.uploaded).toBe(0);
			expect(r.downloaded).toBe(0);
			expect(r.deleted).toBe(0);
			expect(r.conflicts).toBe(0);
			expect(r.merges).toBe(0);
			expect(r.failed).toBe(0);

			// Both sides untouched; every path recorded as Synced.
			expect(await localFilesUnder(prefix)).toHaveLength(FILE_COUNT);
			expect(await driveFilesUnder(prefix)).toHaveLength(FILE_COUNT);
			expectAllSynced(await candidatesUnder(prefix), FILE_COUNT);
		});

		it("second pass is a no-op (no boomerang)", async () => {
			const r = await runBulkSync(browser);
			expect(r.uploaded).toBe(0);
			expect(r.downloaded).toBe(0);
			expect(r.deleted).toBe(0);
			expect(r.conflicts).toBe(0);
			expect(r.failed).toBe(0);
			expectAllSynced(await candidatesUnder(prefix), FILE_COUNT);
		});
	});
});
