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

import { CROSS_VAULT_DRIVE_FOLDER, injectAndConfigure, runBulkSync } from "../../../wdio.conf.mts";

describe("Cross-vault sync", () => {
	before(async () => {
		const refreshToken = process.env["VAULT_SHARE_REFRESH_TOKEN"];
		if (!refreshToken) throw new Error(
			"No GDrive refresh token. Run: npm run setup:e2e:wdio\n" +
			"Or set the VAULT_SHARE_REFRESH_TOKEN environment variable.",
		);

		const primary = browser.getInstance("primaryVault") as WebdriverIO.Browser;
		const peer = browser.getInstance("peerVault") as WebdriverIO.Browser;

		// Configure both vaults to share the same Drive folder.
		await Promise.all([
			injectAndConfigure(primary, refreshToken, CROSS_VAULT_DRIVE_FOLDER),
			injectAndConfigure(peer, refreshToken, CROSS_VAULT_DRIVE_FOLDER),
		]);
	});

	it("pushes a new file from primary vault to peer vault via Drive", async () => {
		const primary = browser.getInstance("primaryVault") as WebdriverIO.Browser;
		const peer = browser.getInstance("peerVault") as WebdriverIO.Browser;

		const testPath = `cross-sync-${Date.now()}.md`;
		const testContent = `Cross-vault sync test at ${new Date().toISOString()}`;

		// Write file in primary vault.
		await primary.executeObsidian(async ({ app }, path, content) => {
			await app.vault.create(path, content);
		}, testPath, testContent);

		// Push primary → Drive, then pull Drive → peer.
		await runBulkSync(primary);
		await runBulkSync(peer);

		// File should now exist in peer vault with the original content.
		const found = await peer.executeObsidian(async ({ app }, path) => {
			return !!app.vault.getFileByPath(path);
		}, testPath) as unknown as boolean;

		expect(found).toBe(true);
	});

	it("pushes a file from peer vault back to primary vault via Drive", async () => {
		const primary = browser.getInstance("primaryVault") as WebdriverIO.Browser;
		const peer = browser.getInstance("peerVault") as WebdriverIO.Browser;

		const testPath = `peer-to-primary-${Date.now()}.md`;
		const testContent = `Peer-to-primary sync test at ${new Date().toISOString()}`;

		// Write file in peer vault.
		await peer.executeObsidian(async ({ app }, path, content) => {
			await app.vault.create(path, content);
		}, testPath, testContent);

		// Push peer → Drive, then pull Drive → primary.
		await runBulkSync(peer);
		await runBulkSync(primary);

		const found = await primary.executeObsidian(async ({ app }, path) => {
			return !!app.vault.getFileByPath(path);
		}, testPath) as unknown as boolean;

		expect(found).toBe(true);
	});

	it("merges conflicting edits to the same line with diff3 markers", async () => {
		const primary = browser.getInstance("primaryVault") as WebdriverIO.Browser;
		const peer = browser.getInstance("peerVault") as WebdriverIO.Browser;

		const testPath = `merge-test-${Date.now()}.md`;
		const baseContent   = "line 1\nshared line\nline 3";
		const primaryEdit   = "line 1\nprimary edit\nline 3";
		const peerEdit      = "line 1\npeer edit\nline 3";

		// Phase 1: establish identical base in both vaults so each has a sync record.
		await primary.executeObsidian(async ({ app }, path, content) => {
			await app.vault.create(path, content);
		}, testPath, baseContent);
		await runBulkSync(primary); // push base to Drive
		await runBulkSync(peer);    // pull base into peer; both vaults now have sync records

		// Fetch peer's client ID now — needed to predict the conflict marker label.
		const peerClientId = await peer.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, object> };
			}).plugins.plugins["vault-share"];
			if (!plugin) throw new Error("vault-share plugin not loaded");
			return (plugin as unknown as { clientId: string }).clientId;
		}) as unknown as string;

		// Phase 2: apply conflicting edits in each vault without syncing.
		await primary.executeObsidian(async ({ app }, path, content) => {
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error(`${path} not found in primary`);
			await app.vault.modify(file, content);
		}, testPath, primaryEdit);

		await peer.executeObsidian(async ({ app }, path, content) => {
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error(`${path} not found in peer`);
			await app.vault.modify(file, content);
		}, testPath, peerEdit);

		// Phase 3: primary pushes its edit; peer detects conflict and merges;
		// primary then pulls the merged result.
		await runBulkSync(primary); // primary's edit lands on Drive
		await runBulkSync(peer);    // peer sees conflict → diff3 merge → writes merged to Drive
		await runBulkSync(primary); // Drive mtime changed → primary pulls merged content

		// Expected diff3 output: peer is local, primary became remote after its push.
		const expectedMerged = [
			"line 1",
			`x<<<<< ${peerClientId}`,
			"peer edit",
			"x||||| base",
			"shared line",
			"x=====",
			"primary edit",
			"x>>>>> group",
			"line 3",
		].join("\n");

		// Verify peer vault content.
		const peerContent = await peer.executeObsidian(async ({ app }, path) => {
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error(`${path} not found in peer after merge`);
			return app.vault.read(file);
		}, testPath) as unknown as string;
		expect(peerContent).toBe(expectedMerged);

		// Verify primary vault content (pulled merged result).
		const primaryContent = await primary.executeObsidian(async ({ app }, path) => {
			const file = app.vault.getFileByPath(path);
			if (!file) throw new Error(`${path} not found in primary after pull`);
			return app.vault.read(file);
		}, testPath) as unknown as string;
		expect(primaryContent).toBe(expectedMerged);

		// Verify Drive content matches as well.
		const driveContent = await primary.executeObsidian(async ({ app }, path) => {
			type Plugin = {
				api: { findFile: (fId: string, n: string) => Promise<{ id: string } | null>; readFile: (id: string) => Promise<string> };
			};
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, Plugin> };
			}).plugins.plugins["vault-share"] as Plugin | undefined;
			if (!plugin) throw new Error("vault-share plugin not loaded");
			const folderId = (plugin as unknown as { driveFolderId: string }).driveFolderId;
			const file = await plugin.api.findFile(folderId, path);
			if (!file) throw new Error(`${path} not found in Drive after merge`);
			return plugin.api.readFile(file.id);
		}, testPath) as unknown as string;
		expect(driveContent).toBe(expectedMerged);
	});
});
