/**
 * Cross-vault end-to-end sync tests.
 *
 * Prerequisites:
 *   npm run setup:e2e:wdio    (one-time, saves refresh token to .e2e-refresh-token)
 *   VAULT_SHARE_REFRESH_TOKEN env var, or .e2e-refresh-token file present
 *
 * Both Obsidian instances share the same Drive folder so that files written
 * in one vault can be pulled by the other.
 */

import { createHash } from "node:crypto";
import { CROSS_VAULT_DRIVE_FOLDER, cleanupTestDriveFolder, injectAndConfigure, runBulkSync } from "../../../wdio.conf.mts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function vaults(): { primary: WebdriverIO.Browser; peer: WebdriverIO.Browser } {
	return {
		primary: browser.getInstance("primaryVault") as WebdriverIO.Browser,
		peer: browser.getInstance("peerVault") as WebdriverIO.Browser,
	};
}

async function create(vault: WebdriverIO.Browser, path: string, content: string): Promise<void> {
	await vault.executeObsidian(async ({ app }, p, c) => {
		await app.vault.create(p as string, c as string);
	}, path, content);
}

async function modify(vault: WebdriverIO.Browser, path: string, content: string): Promise<void> {
	await vault.executeObsidian(async ({ app }, p, c) => {
		const f = app.vault.getFileByPath(p as string);
		if (!f) throw new Error(`${p as string} not found`);
		await app.vault.modify(f, c as string);
	}, path, content);
}

async function deleteFile(vault: WebdriverIO.Browser, path: string): Promise<void> {
	await vault.executeObsidian(async ({ app }, p) => {
		const f = app.vault.getFileByPath(p as string);
		if (f) await app.vault.delete(f);
	}, path);
}

async function vaultHas(vault: WebdriverIO.Browser, path: string): Promise<boolean> {
	return await vault.executeObsidian(
		({ app }, p) => !!app.vault.getFileByPath(p as string),
		path,
	) as unknown as boolean;
}

async function readVault(vault: WebdriverIO.Browser, path: string): Promise<string> {
	return await vault.executeObsidian(async ({ app }, p) => {
		const f = app.vault.getFileByPath(p as string);
		if (!f) throw new Error(`${p as string} not found`);
		return await app.vault.read(f);
	}, path) as unknown as string;
}

async function readDrive(vault: WebdriverIO.Browser, path: string): Promise<string | null> {
	return await vault.executeObsidian(async ({ app }, p) => {
		type Plugin = {
			driveFolderId: string;
			api: {
				findFile: (folderId: string, name: string) => Promise<{ id: string } | null>;
				readFile: (id: string) => Promise<string>;
			};
		};
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"];
		if (!plugin) throw new Error("vault-share plugin not loaded");
		const f = await plugin.api.findFile(plugin.driveFolderId, p as string);
		return f ? await plugin.api.readFile(f.id) : null;
	}, path) as unknown as string | null;
}

async function listVaultFiles(vault: WebdriverIO.Browser): Promise<string[]> {
	return await vault.executeObsidian(({ app }) =>
		app.vault.getFiles().map(f => f.path),
	) as unknown as string[];
}

async function setPaused(vault: WebdriverIO.Browser, paused: boolean): Promise<void> {
	await vault.executeObsidian(async ({ app }, p) => {
		type Plugin = { candidateStore: { setPaused: (b: boolean) => Promise<void> } };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"]!;
		await plugin.candidateStore.setPaused(p as boolean);
	}, paused);
}

async function setThreshold(
	vault: WebdriverIO.Browser,
	min: number,
	threshold: number,
): Promise<void> {
	await vault.executeObsidian(({ app }, m, t) => {
		type Plugin = {
			settings: {
				globalChangeMin: number;
				globalChangeThreshold: number;
			};
		};
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"]!;
		plugin.settings.globalChangeMin = m as number;
		plugin.settings.globalChangeThreshold = t as number;
	}, min, threshold);
}

async function approveCandidates(vault: WebdriverIO.Browser, paths: string[]): Promise<void> {
	await vault.executeObsidian(async ({ app }, ps) => {
		type Plugin = { candidateStore: { approve: (paths: string[]) => Promise<void> } };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"]!;
		await plugin.candidateStore.approve(ps as string[]);
	}, paths);
}

async function clearCandidates(vault: WebdriverIO.Browser): Promise<void> {
	await vault.executeObsidian(async ({ app }) => {
		type Plugin = { candidateStore: { clear: () => Promise<void>; setPaused: (b: boolean) => Promise<void> } };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"]!;
		await plugin.candidateStore.clear();
		await plugin.candidateStore.setPaused(false);
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Cross-vault sync", () => {
	before(async () => {
		const refreshToken = process.env["VAULT_SHARE_REFRESH_TOKEN"];
		if (!refreshToken) throw new Error(
			"No GDrive refresh token. Run: npm run setup:e2e:wdio\n" +
			"Or set the VAULT_SHARE_REFRESH_TOKEN environment variable.",
		);

		const { primary, peer } = vaults();

		// Configure both vaults to share the same Drive folder.
		await Promise.all([
			injectAndConfigure(primary, refreshToken, CROSS_VAULT_DRIVE_FOLDER),
			injectAndConfigure(peer, refreshToken, CROSS_VAULT_DRIVE_FOLDER),
		]);

		// Strip leftover state from prior runs so reconcile doesn't surface
		// phantom pull candidates. Both vaults point at the same Drive folder,
		// so cleaning from one instance suffices.
		const { listed, deleted, failed } = await cleanupTestDriveFolder(primary);
		if (listed > 0) {
			console.log(`cross.before: cleaned Drive folder — listed=${listed} deleted=${deleted} failed=${failed}`);
		}

		// Disable the threshold guard for the whole suite. Cross tests accumulate
		// files in each vault across cases (e.g. a test that pulls from peer
		// leaves the file in primary's vault for later tests to trip over) and
		// the default threshold would defer halfway through and corrupt later
		// cases' state. The manual-sharing test sets its own threshold and
		// restores it; everything else needs the guard out of the way.
		await Promise.all([
			setThreshold(primary, 10000, 100),
			setThreshold(peer,    10000, 100),
		]);
	});

	// ── Basic push / pull through Drive ──────────────────────────────────────

	it("pushes a new file from primary vault to peer vault via Drive", async () => {
		const { primary, peer } = vaults();
		const testPath = `cross-sync-${Date.now()}.md`;
		const testContent = `Cross-vault sync test at ${new Date().toISOString()}`;

		await create(primary, testPath, testContent);
		await runBulkSync(primary);
		await runBulkSync(peer);

		expect(await vaultHas(peer, testPath)).toBe(true);
	});

	it("pushes a file from peer vault back to primary vault via Drive", async () => {
		const { primary, peer } = vaults();
		const testPath = `peer-to-primary-${Date.now()}.md`;
		const testContent = `Peer-to-primary sync test at ${new Date().toISOString()}`;

		await create(peer, testPath, testContent);
		await runBulkSync(peer);
		await runBulkSync(primary);

		expect(await vaultHas(primary, testPath)).toBe(true);
	});

	it("reconciles independent creates on both vaults — both end up with both files", async () => {
		const { primary, peer } = vaults();
		const stem = Date.now();
		const primaryPath = `concurrent-pri-${stem}.md`;
		const peerPath = `concurrent-peer-${stem}.md`;

		await create(primary, primaryPath, "primary content");
		await create(peer, peerPath, "peer content");

		// Three passes: primary pushes A → peer pushes B + pulls A → primary pulls B.
		await runBulkSync(primary);
		await runBulkSync(peer);
		await runBulkSync(primary);

		expect(await vaultHas(primary, peerPath)).toBe(true);
		expect(await vaultHas(peer, primaryPath)).toBe(true);
	});

	// ── Folder hierarchy across vaults ───────────────────────────────────────

	it("replicates a subfolder hierarchy from primary to peer", async () => {
		const { primary, peer } = vaults();
		const stem = `cross-hier-${Date.now()}`;
		const files: Array<[string, string]> = [
			[`${stem}/a.md`,              "root a"],
			[`${stem}/sub1/b.md`,         "sub1 b"],
			[`${stem}/sub1/c.md`,         "sub1 c"],
			[`${stem}/sub2/deep/d.md`,    "sub2/deep d"],
		];

		await primary.executeObsidian(async ({ app }, fs) => {
			const dirs = new Set<string>();
			for (const [p] of fs as Array<[string, string]>) {
				const parts = p.split("/");
				for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
			}
			for (const dir of [...dirs].sort()) {
				if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
			}
			for (const [p, c] of fs as Array<[string, string]>) {
				if (!app.vault.getAbstractFileByPath(p)) await app.vault.create(p, c);
			}
		}, files);

		await runBulkSync(primary);
		await runBulkSync(peer);

		for (const [path, expectedContent] of files) {
			expect(await vaultHas(peer, path)).toBe(true);
			expect(await readVault(peer, path)).toBe(expectedContent);
		}
	});

	// ── Diff3 merge ──────────────────────────────────────────────────────────

	it("merges conflicting edits to the same line with N-way conflict markers", async () => {
		const { primary, peer } = vaults();
		const testPath     = `merge-test-${Date.now()}.md`;
		const baseContent  = "line 1\nshared line\nline 3";
		const primaryEdit  = "line 1\nprimary edit\nline 3";
		const peerEdit     = "line 1\npeer edit\nline 3";

		// Phase 1: establish identical base in both vaults so each has a sync record.
		await create(primary, testPath, baseContent);
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Phase 2: conflicting edits in each vault without syncing.
		await modify(primary, testPath, primaryEdit);
		await modify(peer,    testPath, peerEdit);

		// Phase 3: primary pushes; peer merges; primary pulls merged result.
		await runBulkSync(primary);
		await runBulkSync(peer);
		await runBulkSync(primary);

		// N-way format: base + alternatives A1 (local = peer) and A2 (remote = primary),
		// each introduced by a labelled separator. See specs/nway-conflict.md.
		const expectedMerged = [
			"line 1",
			"`<<<<< conflict`",
			"`===== base`",
			"shared line",
			"`===== A1`",
			"peer edit",
			"`===== A2`",
			"primary edit",
			"`>>>>> conflict`",
			"line 3",
		].join("\n");

		expect(await readVault(peer, testPath)).toBe(expectedMerged);
		expect(await readVault(primary, testPath)).toBe(expectedMerged);
		expect(await readDrive(primary, testPath)).toBe(expectedMerged);
	});

	it("merges non-overlapping edits cleanly without conflict markers", async () => {
		// Regression: diff3 should produce a clean merge when each side edits
		// a different line. A naïve implementation could mark the whole file
		// as conflicted.
		const { primary, peer } = vaults();
		const testPath  = `non-overlap-${Date.now()}.md`;
		const base      = "line 1\nline 2\nline 3\nline 4\nline 5";
		const priEdit   = "line 1 (primary)\nline 2\nline 3\nline 4\nline 5";
		const peerEdit2 = "line 1\nline 2\nline 3\nline 4\nline 5 (peer)";
		const expected  = "line 1 (primary)\nline 2\nline 3\nline 4\nline 5 (peer)";

		await create(primary, testPath, base);
		await runBulkSync(primary);
		await runBulkSync(peer);

		await modify(primary, testPath, priEdit);
		await modify(peer,    testPath, peerEdit2);

		await runBulkSync(primary);
		await runBulkSync(peer);
		await runBulkSync(primary);

		// Both vaults should converge on the cleanly merged content.
		expect(await readVault(peer, testPath)).toBe(expected);
		expect(await readVault(primary, testPath)).toBe(expected);
		expect(await readDrive(primary, testPath)).toBe(expected);
	});

	// ── Delete propagation ───────────────────────────────────────────────────

	it("propagates a deletion from primary to peer", async () => {
		const { primary, peer } = vaults();
		const path = `delete-pri-${Date.now()}.md`;

		// Establish synced baseline on both vaults.
		await create(primary, path, "baseline");
		await runBulkSync(primary);
		await runBulkSync(peer);
		expect(await vaultHas(peer, path)).toBe(true);

		// Primary deletes locally; sync propagates the delete to Drive, then to peer.
		await deleteFile(primary, path);
		await runBulkSync(primary);
		await runBulkSync(peer);

		expect(await vaultHas(primary, path)).toBe(false);
		expect(await vaultHas(peer,    path)).toBe(false);
		expect(await readDrive(primary, path)).toBeNull();
	});

	it("propagates a deletion from peer to primary", async () => {
		const { primary, peer } = vaults();
		const path = `delete-peer-${Date.now()}.md`;

		await create(primary, path, "baseline");
		await runBulkSync(primary);
		await runBulkSync(peer);
		expect(await vaultHas(peer, path)).toBe(true);

		await deleteFile(peer, path);
		await runBulkSync(peer);
		await runBulkSync(primary);

		expect(await vaultHas(peer,    path)).toBe(false);
		expect(await vaultHas(primary, path)).toBe(false);
		expect(await readDrive(primary, path)).toBeNull();
	});

	// ── Modify/delete conflict — see specs/sync-review-followups.md item (14) ─

	/**
	 * Modify-delete conflict is resolved under **modifier-wins** semantics
	 * (item 14): whichever side still has the file becomes canonical at the
	 * original path, and a placeholder at a sibling `*-conflict-*` path marks
	 * the deletion intent. Both tests verify the end state is *stable* — a
	 * follow-up sync round on either vault is a no-op (no boomerang).
	 *
	 * Tag conventions in the placeholder filename:
	 *   - The side whose local copy was deleted tags with `shortClientId`,
	 *     since the placeholder records *that device's* deletion intent.
	 *   - The side whose remote copy was deleted (i.e. the deletion came from
	 *     the group) tags with the literal `'group'`.
	 */

	function placeholderPattern(originalPath: string, sideTag: "group" | "client"): RegExp {
		// buildConflictFilename: <stem>-conflict-<id>-<timestamp>.<ext>
		const dot = originalPath.lastIndexOf(".");
		const base = dot > originalPath.lastIndexOf("/") ? originalPath.slice(0, dot) : originalPath;
		const ext  = dot > originalPath.lastIndexOf("/") ? originalPath.slice(dot)    : "";
		const tag  = sideTag === "group" ? "group" : "[a-f0-9]+";
		const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const escapedExt  = ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`^${escapedBase}-conflict-${tag}-[\\d\\-T:.]+${escapedExt}$`);
	}

	it("primary deletes / peer modifies — modifier wins, peer's content propagates back, no boomerang", async () => {
		const { primary, peer } = vaults();
		const path = `mod-del-a-${Date.now()}.md`;

		await create(primary, path, "baseline");
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Primary deletes first, syncs → Drive copy gone. Peer then modifies
		// before pulling. Peer's next sync sees local=modified, remote=absent
		// → resolveDeleteConflict's "remote was deleted" branch.
		await deleteFile(primary, path);
		await runBulkSync(primary);

		await modify(peer, path, "peer modification");
		await runBulkSync(peer);

		// Modifier-wins outcome on peer's side: the modified content stays at
		// the original path on local AND is pushed back up to Drive, and a
		// `-conflict-group-` placeholder records the deletion intent.
		const peerFiles = await listVaultFiles(peer);
		const placeholder = peerFiles.find(p => placeholderPattern(path, "group").test(p));
		if (!placeholder) {
			throw new Error(`peer should have created a "-conflict-group-" placeholder; saw: ${peerFiles.join(", ")}`);
		}
		expect(await readVault(peer, path)).toBe("peer modification");
		expect(await readDrive(peer, path)).toBe("peer modification");

		// Primary's next sync pulls the restored content back + the placeholder,
		// so both vaults converge on the same end state.
		await runBulkSync(primary);
		expect(await readVault(primary, path)).toBe("peer modification");
		expect(await vaultHas(primary, placeholder)).toBe(true);

		// Stability: another round on either side is a no-op — no new
		// placeholders, no flipping content, no re-push of anything.
		await runBulkSync(peer);
		await runBulkSync(primary);
		expect(await readVault(peer, path)).toBe("peer modification");
		expect(await readVault(primary, path)).toBe("peer modification");
		// Exactly one placeholder per side — no duplicates, no fresh ones from the no-op rounds above.
		expect((await listVaultFiles(peer)).filter(p => placeholderPattern(path, "group").test(p))).toHaveLength(1);
		expect((await listVaultFiles(primary)).filter(p => placeholderPattern(path, "group").test(p))).toHaveLength(1);
	});

	it("peer deletes / primary modifies — modifier wins, primary pulls back, no boomerang", async () => {
		const { primary, peer } = vaults();
		const path = `mod-del-b-${Date.now()}.md`;

		await create(primary, path, "baseline");
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Peer modifies and syncs → Drive has the modified version. Primary
		// then deletes locally. Primary's sync sees local=absent, remote=modified
		// → resolveDeleteConflict's "local was deleted" branch.
		await modify(peer, path, "peer modification");
		await runBulkSync(peer);

		await deleteFile(primary, path);
		await runBulkSync(primary);

		// Modifier-wins outcome on primary's side: the modified content is
		// pulled back to primary's local at the original path, and a
		// `-conflict-<shortClientId>-` placeholder records the deletion intent
		// (tagged with this device's id since *this* device wanted to delete).
		const primaryFiles = await listVaultFiles(primary);
		const placeholder = primaryFiles.find(p => placeholderPattern(path, "client").test(p));
		if (!placeholder) {
			throw new Error(`primary should have created a "-conflict-<clientid>-" placeholder; saw: ${primaryFiles.join(", ")}`);
		}
		expect(await readVault(primary, path)).toBe("peer modification");
		expect(await readDrive(primary, path)).toBe("peer modification");

		// Peer's next sync pulls the placeholder; the file content was already
		// peer's own, so no other change happens on peer.
		await runBulkSync(peer);
		expect(await readVault(peer, path)).toBe("peer modification");
		expect(await vaultHas(peer, placeholder)).toBe(true);

		// Stability: another round on either side is a no-op.
		await runBulkSync(primary);
		await runBulkSync(peer);
		expect(await readVault(primary, path)).toBe("peer modification");
		expect(await readVault(peer, path)).toBe("peer modification");
		// Exactly one placeholder per side — no duplicates, no fresh ones from the no-op rounds above.
		expect((await listVaultFiles(primary)).filter(p => placeholderPattern(path, "client").test(p))).toHaveLength(1);
		expect((await listVaultFiles(peer)).filter(p => placeholderPattern(path, "client").test(p))).toHaveLength(1);
	});
});

// ── SHA-256 identity comparison ──────────────────────────────────────────────

describe("Cross-vault SHA-256 identity", () => {
	/**
	 * Two complementary tests for the sha256Checksum fast-path:
	 *
	 * (a) Drive returns a sha256Checksum on every pushed file — verify the field
	 *     is a 64-char hex string in the candidate's remote side after a push.
	 *
	 * (b) Both vaults independently edit a file to the same content — the next
	 *     bulk sync should reconcile as identicalTimestamps (not a conflict) and
	 *     leave neither vault with conflict markers.
	 */

	it("Drive returns a sha256Checksum on pushed files", async () => {
		const { primary } = vaults();
		const path = `sha256-push-${Date.now()}.md`;
		const content = `sha256 test content ${new Date().toISOString()}`;

		// Compute the expected hash from the raw UTF-8 bytes that will be uploaded.
		const expectedHash = createHash("sha256").update(content, "utf8").digest("hex");

		await create(primary, path, content);
		await runBulkSync(primary);

		// Query the file's metadata directly from Drive — findFile includes
		// sha256Checksum in its fields= parameter.
		const remoteHash = await primary.executeObsidian(async ({ app }, p) => {
			type DriveFileMeta = { id: string; sha256Checksum?: string };
			type Plugin = {
				driveFolderId: string;
				api: { findFile: (folderId: string, name: string) => Promise<DriveFileMeta | null> };
			};
			const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
				.plugins.plugins["vault-share"]!;
			const meta = await plugin.api.findFile(plugin.driveFolderId, p as string);
			return meta?.sha256Checksum ?? null;
		}, path) as unknown as string | null;

		expect(remoteHash).not.toBeNull();
		expect(remoteHash).toBe(expectedHash);
	});

	it("identical independent edits resolve as identicalTimestamps, not conflicts", async () => {
		const { primary, peer } = vaults();
		const path = `sha256-identical-${Date.now()}.md`;
		const baseContent = `base content ${Date.now()}`;
		const identicalEdit = `identical edit ${Date.now()}`;

		// Phase 1: establish synced baseline in both vaults.
		await create(primary, path, baseContent);
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Phase 2: both vaults independently edit to the exact same new content
		// without syncing — simulates two users typing the same change.
		await modify(primary, path, identicalEdit);
		await modify(peer,    path, identicalEdit);

		// Phase 3: sync primary first (its version lands on Drive), then sync peer.
		// Peer will see local=identicalEdit, remote=identicalEdit → same sha256 →
		// identicalTimestamps path, not a conflict write.
		await runBulkSync(primary);
		const peerResult = await runBulkSync(peer);

		expect(peerResult.identicalTimestamps).toBeGreaterThan(0);
		expect(peerResult.conflicts).toBe(0);

		// Both vaults should still have the identical edit — no conflict markers.
		expect(await readVault(primary, path)).toBe(identicalEdit);
		expect(await readVault(peer,    path)).toBe(identicalEdit);
	});
});

// ── Pause behaviour ──────────────────────────────────────────────────────────

describe("Cross-vault pause behaviour", () => {
	after(async () => {
		// Make sure paused state never leaks into the next describe block.
		const { primary, peer } = vaults();
		await setPaused(primary, false);
		await setPaused(peer,    false);
	});

	it("paused primary stops pushing its edits but still pulls peer edits on resume", async () => {
		const { primary, peer } = vaults();
		const primaryPath = `pause-pri-${Date.now()}.md`;
		const peerPath    = `pause-peer-${Date.now()}.md`;

		// Establish synced baseline of primaryPath on both vaults so the edit
		// we make under pause is a real modification, not a brand-new file.
		await create(primary, primaryPath, "initial");
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Pause primary, then edit. The edit must not propagate.
		await setPaused(primary, true);
		await modify(primary, primaryPath, "paused edit");

		// Peer creates a file (peer is not paused).
		await create(peer, peerPath, "peer file");

		// Run both sides' syncs. Primary's bails (paused).
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Drive should NOT have primary's "paused edit" yet. Verified via the
		// non-paused peer instance so we don't accidentally trigger primary's
		// sync as a side effect of the readDrive lookup.
		expect(await readDrive(peer, primaryPath)).toBe("initial");

		// Drive SHOULD have peer's new file.
		expect(await readDrive(peer, peerPath)).toBe("peer file");

		// Resume primary and sync. Primary should now push its edit AND pull
		// peer's new file in the same pass.
		await setPaused(primary, false);
		await runBulkSync(primary);

		expect(await vaultHas(primary, peerPath)).toBe(true);
		expect(await readDrive(peer, primaryPath)).toBe("paused edit");
	});
});

// ── Manual sharing control across vaults ─────────────────────────────────────

describe("Cross-vault manual sharing control", () => {
	after(async () => {
		// Restore the suite-level "threshold off" setting so anything that
		// runs after us doesn't accidentally trip the guard.
		const { primary, peer } = vaults();
		await setThreshold(primary, 10000, 100);
		await setThreshold(peer,    10000, 100);
		await setPaused(primary, false);
		await setPaused(peer,    false);
		await clearCandidates(primary);
		await clearCandidates(peer);
	});

	it("user-approved candidates propagate to peer; deferred ones do not", async () => {
		const { primary, peer } = vaults();
		const stem = Date.now();
		const approvedPath = `manual-approve-${stem}.md`;
		const deferredPath = `manual-defer-${stem}.md`;

		// Arm the threshold so any planned action defers everything.
		await setThreshold(primary, 1, 0);

		// Create both files locally. Bulk sync will defer both and pause.
		await create(primary, approvedPath, "approved content");
		await create(primary, deferredPath, "deferred content");

		const result = await runBulkSync(primary);
		expect(result.deferredByThreshold).toBe(true);

		// User approves only one of them and unpauses. Approved-state candidates
		// bypass the threshold guard on the next run.
		await approveCandidates(primary, [approvedPath]);
		await setPaused(primary, false);

		await runBulkSync(primary);
		await runBulkSync(peer);

		// Peer should have the approved file but not the deferred one.
		expect(await vaultHas(peer, approvedPath)).toBe(true);
		expect(await vaultHas(peer, deferredPath)).toBe(false);

		// Drive should mirror the same state.
		expect(await readDrive(peer, approvedPath)).toBe("approved content");
		expect(await readDrive(peer, deferredPath)).toBeNull();
	});
});
