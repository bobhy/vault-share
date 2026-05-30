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
				fileModificationConfirmationMin: number;
				fileModificationConfirmationThreshold: number;
			};
		};
		const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
			.plugins.plugins["vault-share"]!;
		plugin.settings.fileModificationConfirmationMin = m as number;
		plugin.settings.fileModificationConfirmationThreshold = t as number;
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

	it("merges conflicting edits to the same line with diff3 markers", async () => {
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

		const expectedMerged = [
			"line 1",
			"`<<<<< local`",
			"peer edit",
			"`||||| base`",
			"shared line",
			"`=====`",
			"primary edit",
			"`>>>>> group`",
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

	// ── Modify/delete conflict — see specs/sync-review-followups.md item (6) ─

	/**
	 * The delete-conflict resolver is known to be incomplete: it creates a
	 * placeholder but does not sync the surviving side, which leads to the
	 * deletion being effectively reverted on the next pass (item 6 in the
	 * sync-review-followups checklist). The two tests below **pin the current
	 * behaviour** so a future fix to `resolveDeleteConflict` produces an
	 * intentional, reviewed assertion change rather than a silent regression.
	 */

	function placeholderPattern(originalPath: string, sideTag: "group" | "client"): RegExp {
		// buildConflictFilename: <stem>-conflict-<id>-<timestamp>.<ext>
		// `group` for "remote was deleted" branch; `client` (short id) otherwise.
		const dot = originalPath.lastIndexOf(".");
		const base = dot > originalPath.lastIndexOf("/") ? originalPath.slice(0, dot) : originalPath;
		const ext  = dot > originalPath.lastIndexOf("/") ? originalPath.slice(dot)    : "";
		const tag  = sideTag === "group" ? "group" : "[a-f0-9]+";
		const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const escapedExt  = ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`^${escapedBase}-conflict-${tag}-[\\d\\-T:.]+${escapedExt}$`);
	}

	it("primary deletes / peer modifies — peer creates a placeholder, original is not lost (pinned behaviour)", async () => {
		const { primary, peer } = vaults();
		const path = `mod-del-a-${Date.now()}.md`;

		await create(primary, path, "baseline");
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Primary deletes first, syncs → Drive copy gone. Peer then modifies
		// before pulling. Peer's next sync sees local=modified, remote=absent.
		await deleteFile(primary, path);
		await runBulkSync(primary);

		await modify(peer, path, "peer modification");
		await runBulkSync(peer);

		// Expected current behaviour from resolveDeleteConflict's else-branch
		// ("remote deleted, local modified"): a placeholder is created tagged
		// with "group", and peer's local copy of the original IS NOT removed.
		const peerFiles = await listVaultFiles(peer);
		const placeholder = peerFiles.find(p => placeholderPattern(path, "group").test(p));
		if (!placeholder) {
			throw new Error(`peer should have created a "-conflict-group-" placeholder; saw: ${peerFiles.join(", ")}`);
		}

		// Original modified file still present locally (item 6 partial-resolution).
		expect(await vaultHas(peer, path)).toBe(true);
		expect(await readVault(peer, path)).toBe("peer modification");

		// Drive has the placeholder but not the original at this point.
		expect(await readDrive(primary, path)).toBeNull();
	});

	it("peer deletes / primary modifies — primary creates a client-tagged placeholder (pinned behaviour)", async () => {
		const { primary, peer } = vaults();
		const path = `mod-del-b-${Date.now()}.md`;

		await create(primary, path, "baseline");
		await runBulkSync(primary);
		await runBulkSync(peer);

		// Peer modifies and syncs → Drive has the modified version. Primary
		// then deletes locally. Primary's sync sees local=absent, remote=modified.
		await modify(peer, path, "peer modification");
		await runBulkSync(peer);

		await deleteFile(primary, path);
		await runBulkSync(primary);

		// resolveDeleteConflict's if-branch ("local deleted, remote modified"):
		// placeholder is tagged with the short client id, not "group".
		const primaryFiles = await listVaultFiles(primary);
		const placeholder = primaryFiles.find(p => placeholderPattern(path, "client").test(p));
		if (!placeholder) {
			throw new Error(`primary should have created a "-conflict-<clientid>-" placeholder; saw: ${primaryFiles.join(", ")}`);
		}

		// Current behaviour: primary's local does NOT have the original file
		// (it was deleted before the conflict was discovered). The placeholder
		// is the only artifact at the original stem.
		expect(await vaultHas(primary, path)).toBe(false);
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
