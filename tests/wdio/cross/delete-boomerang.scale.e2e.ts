/**
 * Multi-device delete / re-push boomerang (scale).
 *
 * Reproduction harness for the reported symptom: bulk sync deletes group-vault
 * files and then re-pushes them. The single-vault no-history scenarios proved
 * the no-history branch never deletes, so the boomerang must come from the
 * *interaction* of two devices whose sync history is out of alignment.
 *
 * Two cases, sharing one group vault:
 *
 *   A. Aligned history — both devices have a consistent sync record. A mass
 *      delete on one device must propagate to the other exactly once and stop,
 *      with NO re-push from the peer. (specs/sync-model.md inv. 5)
 *
 *   B. Misaligned history — one device's candidate store has been cleared
 *      (a fresh install / new local vault joining an established group). After
 *      a peer empties the group, the cleared device cannot tell "a peer deleted
 *      this" from "I have unique local files." By design it must FAIL SAFE:
 *      re-push its local files rather than honor a deletion it never recorded.
 *      The re-push ("boomerang") is the DESIRED outcome here — silently
 *      discarding the user's notes would be the real bug.
 *
 * Reliability: assertions are convergence-based. At scale Drive throttles, so
 * the request layer backs off/retries and a pass may need to run more than once
 * to finish. Each side is driven to a stable state with `syncUntilStable`, and
 * we assert on aggregate work + end state. The ordering is controlled (not
 * free-running) so each case exercises its specific divergence.
 *
 * Opt-in: runs only under `npm run test:e2e:scale:cross` (WDIO_SCALE=true).
 */

import { CROSS_VAULT_DRIVE_FOLDER, cleanupTestDriveFolder, injectAndConfigure, runBulkSync } from "../../../wdio.conf.mts";

/**
 * Files per case. Large enough to exercise throttling/backoff; kept moderate so
 * the live two-instance run stays tractable. Tunable toward the hundreds-of-files
 * field report at the cost of runtime.
 */
const COUNT = 50;

function vaults(): { primary: WebdriverIO.Browser; peer: WebdriverIO.Browser } {
	return {
		primary: browser.getInstance("primaryVault") as WebdriverIO.Browser,
		peer: browser.getInstance("peerVault") as WebdriverIO.Browser,
	};
}

interface PassTotals {
	uploaded: number;
	downloaded: number;
	deleted: number;
	conflicts: number;
	failed: number;
	passes: number;
}

function emptyTotals(): PassTotals {
	return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, failed: 0, passes: 0 };
}

/** Run bulk sync on one instance until a pass does no work, or `maxPasses`. Aggregates counters. */
async function syncUntilStable(vault: WebdriverIO.Browser, maxPasses = 6): Promise<PassTotals> {
	const t = emptyTotals();
	for (let i = 0; i < maxPasses; i++) {
		const r = await runBulkSync(vault);
		t.passes++;
		t.uploaded += r.uploaded;
		t.downloaded += r.downloaded;
		t.deleted += r.deleted;
		t.conflicts += r.conflicts;
		t.failed += r.failed;
		if (r.uploaded + r.downloaded + r.deleted + r.conflicts + r.failed === 0) break;
	}
	return t;
}

function makePaths(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}/note-${i}.md`);
}

async function createMany(vault: WebdriverIO.Browser, prefix: string, paths: string[]): Promise<void> {
	await vault.executeObsidian(async ({ app }, pfx, ps) => {
		if (!app.vault.getAbstractFileByPath(pfx as string)) await app.vault.createFolder(pfx as string);
		for (const p of ps as string[]) {
			if (!app.vault.getFileByPath(p)) await app.vault.create(p, `boomerang ${p}`);
		}
	}, prefix, paths);
}

async function deleteAllUnder(vault: WebdriverIO.Browser, prefix: string): Promise<void> {
	await vault.executeObsidian(async ({ app }, pfx) => {
		for (const f of app.vault.getFiles()) {
			if (f.path.startsWith(pfx as string)) await app.vault.delete(f);
		}
	}, prefix);
}

async function localCountUnder(vault: WebdriverIO.Browser, prefix: string): Promise<number> {
	return await vault.executeObsidian(({ app }, pfx) =>
		app.vault.getFiles().filter(f => f.path.startsWith(pfx as string)).length,
	prefix) as unknown as number;
}

async function driveCountUnder(vault: WebdriverIO.Browser, prefix: string): Promise<number> {
	return await vault.executeObsidian(async ({ app }, pfx) => {
		type DriveFs = { listAll: (folderId: string) => Promise<{ files: Array<{ path: string }> }> };
		type Plugin = { driveFolderId: string; driveFs: DriveFs };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"];
		if (!plugin) throw new Error("vault-share plugin not loaded");
		const { files } = await plugin.driveFs.listAll(plugin.driveFolderId);
		return files.filter(f => f.path.startsWith(pfx as string)).length;
	}, prefix) as unknown as number;
}

async function clearCandidates(vault: WebdriverIO.Browser): Promise<void> {
	await vault.executeObsidian(async ({ app }) => {
		type Plugin = { candidateStore: { clear: () => Promise<void>; setPaused: (b: boolean) => Promise<void> } };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"];
		if (!plugin) throw new Error("vault-share plugin not loaded");
		await plugin.candidateStore.clear();
		await plugin.candidateStore.setPaused(false);
	});
}

async function setThreshold(vault: WebdriverIO.Browser, min: number, threshold: number): Promise<void> {
	await vault.executeObsidian(({ app }, m, t) => {
		type Plugin = { settings: { globalChangeMin: number; globalChangeThreshold: number } };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"]!;
		plugin.settings.globalChangeMin = m as number;
		plugin.settings.globalChangeThreshold = t as number;
	}, min, threshold);
}

/** Create on primary, push, pull to peer → both vaults aligned with sync history. */
async function establishAlignedBaseline(prefix: string, paths: string[]): Promise<void> {
	const { primary, peer } = vaults();
	await createMany(primary, prefix, paths);
	await syncUntilStable(primary); // push to group
	await syncUntilStable(peer);    // pull to peer
}

describe("Multi-device delete/re-push boomerang (scale)", () => {
	before(async () => {
		const refreshToken = process.env["VAULT_SHARE_REFRESH_TOKEN"];
		if (!refreshToken) throw new Error("No GDrive refresh token. Run: npm run setup:e2e:wdio");
		const { primary, peer } = vaults();
		await Promise.all([
			injectAndConfigure(primary, refreshToken, CROSS_VAULT_DRIVE_FOLDER),
			injectAndConfigure(peer, refreshToken, CROSS_VAULT_DRIVE_FOLDER),
		]);
		await cleanupTestDriveFolder(primary);
		// Disable the threshold guard so mass deletes execute instead of deferring.
		await Promise.all([setThreshold(primary, 10000, 100), setThreshold(peer, 10000, 100)]);
	});

	// ── Case A: aligned history — propagate once, no boomerang (control) ───────
	it("aligned history: a mass delete propagates once and does not boomerang", async () => {
		const { primary, peer } = vaults();
		const prefix = `boom-aligned-${Date.now()}`;
		const paths = makePaths(prefix, COUNT);

		await establishAlignedBaseline(prefix, paths);
		expect(await localCountUnder(peer, prefix)).toBe(COUNT);

		// Primary deletes everything; sync removes it from the group vault.
		await deleteAllUnder(primary, prefix);
		const pri = await syncUntilStable(primary);
		expect(pri.failed).toBe(0);
		expect(pri.uploaded).toBe(0);
		expect(await driveCountUnder(primary, prefix)).toBe(0);

		// Peer has aligned history → it deletes its local copies, never re-pushes.
		const peerT = await syncUntilStable(peer);
		expect(peerT.failed).toBe(0);
		expect(peerT.uploaded).toBe(0); // the no-boomerang assertion
		expect(await localCountUnder(peer, prefix)).toBe(0);

		// Stability: extra rounds on either device change nothing.
		const a = await syncUntilStable(primary);
		const b = await syncUntilStable(peer);
		expect(a.uploaded + a.downloaded + a.deleted).toBe(0);
		expect(b.uploaded + b.downloaded + b.deleted).toBe(0);
		expect(await driveCountUnder(primary, prefix)).toBe(0);
		expect(await localCountUnder(primary, prefix)).toBe(0);
		expect(await localCountUnder(peer, prefix)).toBe(0);
	});

	// ── Case B: misaligned history — fail-safe re-push (DESIRED behavior) ──────
	it("misaligned history: a fresh device re-pushes its unique local files (fail-safe)", async () => {
		const { primary, peer } = vaults();
		const prefix = `boom-misaligned-${Date.now()}`;
		const paths = makePaths(prefix, COUNT);

		await establishAlignedBaseline(prefix, paths);
		expect(await localCountUnder(peer, prefix)).toBe(COUNT);

		// Primary deletes everything and propagates the delete to the group vault.
		// Drive everything BEFORE peer syncs, so peer faces an empty group.
		await deleteAllUnder(primary, prefix);
		const pri = await syncUntilStable(primary);
		expect(pri.failed).toBe(0);
		expect(await driveCountUnder(primary, prefix)).toBe(0);

		// Peer becomes a "fresh / misaligned" device: history wiped, local files remain.
		await clearCandidates(peer);

		// Fail-safe: with no history, peer re-pushes every unique local file
		// (no-history path → push), repopulating the group vault rather than
		// discarding the notes. This is the intended, data-preserving outcome.
		const peerT = await syncUntilStable(peer);
		expect(peerT.failed).toBe(0);
		expect(peerT.deleted).toBe(0);
		expect(peerT.uploaded).toBe(COUNT);
		expect(await driveCountUnder(peer, prefix)).toBe(COUNT);

		// The resurrected files propagate back to primary on its next sync(s).
		const back = await syncUntilStable(primary);
		expect(back.failed).toBe(0);
		expect(await localCountUnder(primary, prefix)).toBe(COUNT);
	});
});
