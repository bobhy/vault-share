/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/types" />
/// <reference types="wdio-obsidian-service" />
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

// Single-vault e2e tests. Run with: npm run test:e2e:single
// One-time token setup:  npm run setup:e2e:wdio

/** Drive folder used by single-vault e2e tests (isolated from production vaults). */
export const SINGLE_VAULT_DRIVE_FOLDER = "/vault-share-e2e-single";

/** Drive folder used by cross-vault e2e tests. Both vaults must share this path. */
export const CROSS_VAULT_DRIVE_FOLDER = "/vault-share-e2e-cross";

export const config: WebdriverIO.Config = {
	runner: "local",
	logLevel: "warn",
	framework: "mocha",
	specs: ["./tests/wdio/single/**/*.e2e.ts"],
	maxInstances: 1,

	// Keep downloaded Obsidian binaries on local disk — avoids EBUSY on NFS.
	cacheDir: join(homedir(), ".obsidian-wdio-cache"),

	capabilities: [
		{
			browserName: "obsidian",
			"wdio:obsidianOptions": {
				appVersion: "latest",
				vault: "tests/vaults/primary",
				plugins: ["."],
			},
		},
	],

	services: ["obsidian"],
	reporters: ["spec"],

	mochaOpts: {
		ui: "bdd",
		timeout: 120_000,
	},

	before: async (_caps, _specs, b) => {
		const br = b as WebdriverIO.Browser;

		// wdio uses a fresh --user-data-dir so secretStorage is empty.
		// Read the saved refresh token and inject it before the plugin initialises.
		let refreshToken = process.env["VAULT_SHARE_REFRESH_TOKEN"];
		if (!refreshToken) {
			try {
				refreshToken = (await readFile(".e2e-refresh-token", "utf8")).trim();
			} catch {
				throw new Error(
					"No GDrive refresh token. Run: npm run setup:e2e:wdio\n" +
					"Or set the VAULT_SHARE_REFRESH_TOKEN environment variable.",
				);
			}
		}

		await injectAndConfigure(br, refreshToken, SINGLE_VAULT_DRIVE_FOLDER);

		// Cache the token so Drive API helpers in test files can access it.
		process.env["VAULT_SHARE_REFRESH_TOKEN"] = refreshToken;
	},
};

/**
 * Inject a GDrive refresh token and fully configure the vault-share plugin for
 * testing.  Because wdio uses a fresh --user-data-dir, secretStorage is empty
 * when onload() runs.  This function:
 *   1. Writes the token into secretStorage.
 *   2. Calls loadFromSecretStorage() so the already-loaded plugin picks it up.
 *   3. Sets the Drive folder path and resolves it so bulk-sync can run.
 */
export async function injectAndConfigure(
	br: WebdriverIO.Browser,
	refreshToken: string,
	driveFolderPath: string,
): Promise<void> {
	await br.executeObsidian(async ({ app }, token, folderPath) => {
		await app.secretStorage.setSecret("vault-share-googledrive-refresh-token", token);

		type Plugin = {
			auth: { loadFromSecretStorage: () => void };
			api: { resolveFolder: (path: string) => Promise<string> };
			settings: { driveFolderPath: string };
		};
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, Plugin> };
		}).plugins.plugins["vault-share"] as Plugin | undefined;
		if (!plugin) throw new Error("vault-share plugin not loaded");

		// Re-read secrets — loadFromSecretStorage() ran during onload() before
		// the token was available.
		plugin.auth.loadFromSecretStorage();
		plugin.settings.driveFolderPath = folderPath;
		const folderId = await plugin.api.resolveFolder(folderPath);
		(plugin as unknown as { driveFolderId: string }).driveFolderId = folderId;
	}, refreshToken, driveFolderPath);
}

/**
 * Run a bulk sync pass synchronously inside the given vault.
 * Bypasses the scheduler timer so tests can trigger sync on demand.
 */
interface SyncPassResult {
	downloaded: number;
	uploaded: number;
	deleted: number;
	conflicts: number;
	merges: number;
	abortedByUser: boolean;
	error?: unknown;
}

export async function runBulkSync(br: WebdriverIO.Browser): Promise<SyncPassResult> {
	const result = await br.executeObsidian(async ({ app }) => {
		type Plugin = { scheduler: unknown };
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, Plugin> };
		}).plugins.plugins["vault-share"] as Plugin | undefined;
		if (!plugin) throw new Error("vault-share plugin not loaded");

		// Access the BulkSync instance held inside the scheduler's private deps.
		const bulkSync = (plugin.scheduler as unknown as {
			deps: { bulkSync: { run: () => Promise<unknown> } };
		}).deps.bulkSync;
		return bulkSync.run() as Promise<unknown>;
	}) as unknown as SyncPassResult;

	if (result?.error) {
		const msg = result.error instanceof Error ? result.error.message : String(result.error);
		throw new Error(`Bulk sync failed: ${msg}`);
	}
	return result;
}
