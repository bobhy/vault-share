/**
 * End-to-end test: Google Drive CRUD via the vault-share plugin.
 *
 * Prerequisites:
 *   npm run setup:e2e:wdio    (one-time, saves refresh token to .e2e-refresh-token)
 *   VAULT_SHARE_REFRESH_TOKEN env var, or .e2e-refresh-token file present
 *
 * The wdio.conf.mts before-hook injects the refresh token into Obsidian's
 * SecretStorage before the plugin loads, so no browser OAuth is needed.
 */

import { RELAY_BASE_URL, GOOGLE_CLIENT_ID } from "../../../src/gdrive/constants";
import type { GDriveApi } from "../../../src/gdrive/api";
import { SINGLE_VAULT_DRIVE_FOLDER } from "../../../wdio.conf.mts";

const TEST_FOLDER_PATH = `${SINGLE_VAULT_DRIVE_FOLDER}/vault-share-test-folder`;
const TEST_FILE_NAME = "vault-share-e2e-test.md";
const TEST_CONTENT = "A".repeat(1000); // ~1000 bytes of known content

describe("Plugin health", () => {
	it("loads without errors", async () => {
		const loaded = await browser.executeObsidian(async ({ app }) => {
			type Plugin = { auth: { isAuthenticated: boolean } };
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, Plugin> };
			}).plugins.plugins["vault-share"] as Plugin | undefined;
			return !!plugin;
		}) as unknown as boolean;

		expect(loaded).toBe(true);
	});

	it("relay and client ID are configured (not TODO placeholders)", () => {
		expect(GOOGLE_CLIENT_ID).not.toBe("TODO");
		expect(RELAY_BASE_URL).not.toContain("TODO");
	});
});

describe("Google Drive integration", () => {
	it("authenticates with the injected token", async () => {
		const ok = await browser.executeObsidian(async ({ app }) => {
			type Plugin = {
				auth: { getAccessToken: () => Promise<string>; isAuthenticated: boolean };
			};
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, Plugin> };
			}).plugins.plugins["vault-share"] as Plugin | undefined;
			if (!plugin) throw new Error("vault-share plugin not loaded");
			if (!plugin.auth.isAuthenticated) throw new Error("plugin is not authenticated");
			await plugin.auth.getAccessToken(); // throws if credentials are invalid
			return true;
		}) as unknown as boolean;

		expect(ok).toBe(true);
	});

	it("creates or reuses the test folder", async () => {
		const folderId = await browser.executeObsidian(async ({ app }, folderPath) => {
			type Plugin = { api: GDriveApi };
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, Plugin> };
			}).plugins.plugins["vault-share"] as Plugin | undefined;
			if (!plugin) throw new Error("vault-share plugin not loaded");
			return plugin.api.resolveFolder(folderPath);
		}, TEST_FOLDER_PATH) as unknown as string;

		expect(typeof folderId).toBe("string");
		expect(folderId.length).toBeGreaterThan(0);
	});

	it("writes a file and reads it back correctly", async () => {
		const result = await browser.executeObsidian(
			async ({ app }, folderPath, fileName, content) => {
				type Plugin = { api: GDriveApi };
				const plugin = (app as unknown as {
					plugins: { plugins: Record<string, Plugin> };
				}).plugins.plugins["vault-share"] as Plugin | undefined;
				if (!plugin) throw new Error("vault-share plugin not loaded");

				const folderId = await plugin.api.resolveFolder(folderPath);
				await plugin.api.writeFile(folderId, fileName, content);
				const file = await plugin.api.findFile(folderId, fileName);
				if (!file) throw new Error(`${fileName} not found after write`);
				return plugin.api.readFile(file.id);
			},
			TEST_FOLDER_PATH, TEST_FILE_NAME, TEST_CONTENT,
		) as unknown as string;

		expect(result).toBe(TEST_CONTENT);
	});
});
