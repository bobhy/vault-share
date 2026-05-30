/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/types" />
/// <reference types="wdio-obsidian-service" />
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Single-vault e2e tests. Run with: npm run test:e2e:single
// One-time token setup:  npm run setup:e2e:wdio

/** Drive folder used by single-vault e2e tests (isolated from production vaults). */
export const SINGLE_VAULT_DRIVE_FOLDER = "/vault-share-e2e-single";

/** Drive folder used by cross-vault e2e tests. Both vaults must share this path. */
export const CROSS_VAULT_DRIVE_FOLDER = "/vault-share-e2e-cross";

/**
 * When true (the default), the runner starts a virtual display and window manager
 * so Obsidian can run without a physical monitor — suitable for CI.
 * Set WDIO_HEADLESS=false to use the current $DISPLAY for interactive debugging.
 */
const HEADLESS = process.env["WDIO_HEADLESS"] !== "false";

// Processes started for the virtual display; killed in onComplete.
let xvfbProc: ChildProcess | null = null;
let wmProc: ChildProcess | null = null;

// Build the capability object; add Chrome/Electron flags for headless Linux.
const obsidianCapability: WebdriverIO.Capabilities = {
	browserName: "obsidian",
	"wdio:obsidianOptions": {
		appVersion: "latest",
		vault: "tests/vaults/primary",
		plugins: ["."],
	},
};
if (HEADLESS && process.platform === "linux") {
	(obsidianCapability as Record<string, unknown>)["goog:chromeOptions"] = {
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	};
}

export const config: WebdriverIO.Config = {
	runner: "local",
	logLevel: "warn",
	framework: "mocha",
	specs: ["./tests/wdio/single/**/*.e2e.ts"],
	maxInstances: 1,

	// Keep downloaded Obsidian binaries on local disk — avoids EBUSY on NFS.
	cacheDir: join(homedir(), ".obsidian-wdio-cache"),

	capabilities: [obsidianCapability],

	services: ["obsidian"],
	reporters: ["spec"],

	mochaOpts: {
		ui: "bdd",
		timeout: 120_000,
	},

	onPrepare: async () => {
		if (!HEADLESS || process.platform !== "linux") return;

		// Start a virtual framebuffer so Obsidian can open windows without a monitor.
		process.env["DISPLAY"] = ":99";
		xvfbProc = spawn("Xvfb", [":99", "-screen", "0", "1280x1024x24", "+extension", "GLX"], {
			stdio: "ignore",
		});
		// Give Xvfb ~300 ms to bind the display socket before Obsidian launches.
		await new Promise<void>(r => setTimeout(r, 300));

		// A window manager is required for Obsidian to open windows on Xvfb.
		// Silently ignore the error if herbstluftwm is not installed.
		wmProc = spawn("herbstluftwm", [], { stdio: "ignore" });
		wmProc.on("error", () => { wmProc = null; });
	},

	onComplete: () => {
		wmProc?.kill();
		xvfbProc?.kill();
	},

	before: async (_caps, _specs, b) => {
		const br = b as WebdriverIO.Browser;

		// Bump WebDriver's async-script timeout so `runBulkSync` can await
		// `bulkSync.run()` inside executeObsidian without hitting the 30 s
		// default during slow Drive passes. Matches mocha's per-test timeout.
		await br.setTimeout({ script: 120_000 });

		// Wait for the wdio-obsidian-service bridge to be ready before calling
		// executeObsidian — avoids the "not a function" retry warnings on startup.
		await br.waitUntil(
			() => br.execute(() =>
				typeof (window as unknown as { wdioObsidianService: unknown }).wdioObsidianService === "function",
			) as Promise<boolean>,
			{ timeout: 30_000, interval: 200, timeoutMsg: "wdioObsidianService not available after 30 s" },
		);

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

		// Drive accumulates leftover files across test runs (tests don't always
		// clean up their own Drive state on failure).  Strip the test folder
		// once per session so reconcile doesn't surface hundreds of spurious
		// pull candidates from prior runs.
		const { listed, deleted, failed } = await cleanupTestDriveFolder(br);
		if (listed > 0) {
			console.log(`wdio.before: cleaned Drive folder — listed=${listed} deleted=${deleted} failed=${failed}`);
		}

		// Cache the token so Drive API helpers in test files can access it.
		process.env["VAULT_SHARE_REFRESH_TOKEN"] = refreshToken;
	},
};

/**
 * Inject a GDrive refresh token and fully configure the vault-share plugin for
 * testing. Because wdio uses a fresh --user-data-dir, secretStorage is empty and
 * no keyring daemon is available in headless CI. This function:
 *   1. Stops the autonomous sync scheduler so tests are the sole driver of
 *      bulk sync — eliminates races between scheduler ticks and test setup
 *      (see runBulkSync below).
 *   2. Injects the token directly into the auth object's memory (bypasses keyring).
 *   3. Sets the Drive folder path and resolves it so bulk-sync can run.
 */
export async function injectAndConfigure(
	br: WebdriverIO.Browser,
	refreshToken: string,
	driveFolderPath: string,
): Promise<void> {
	await br.executeObsidian(async ({ app }, token, folderPath) => {
		type Plugin = {
			auth: { injectRefreshToken: (t: string) => void };
			api: { resolveFolder: (path: string) => Promise<string> };
			settings: { driveFolderPath: string };
			scheduler: { stop: () => Promise<void> };
		};
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, Plugin> };
		}).plugins.plugins["vault-share"] as Plugin | undefined;
		if (!plugin) throw new Error("vault-share plugin not loaded");

		// Silence the heartbeat before touching auth/folder so no scheduler tick
		// can fire a bulk sync against test files. Drains any in-flight pass
		// started by the startup triggerBulkSync().
		await plugin.scheduler.stop();

		// Inject token directly into memory — bypasses SecretStorage/keyring,
		// which is unavailable in headless CI. The wdio sandbox uses a fresh
		// --user-data-dir each run so keyring persistence is not needed.
		plugin.auth.injectRefreshToken(token as string);
		plugin.settings.driveFolderPath = folderPath as string;
		const folderId = await plugin.api.resolveFolder(folderPath as string);
		(plugin as unknown as { driveFolderId: string }).driveFolderId = folderId;
	}, refreshToken, driveFolderPath);
}

/**
 * Delete every file and folder directly under the configured test Drive
 * folder.  Drive's delete cascades, so subfolders (and their contents) go in
 * a single call.
 *
 * Run once per worker session in the `before` hook so each session starts
 * from a clean Drive — otherwise leftover files from prior runs reconcile as
 * spurious `pull` candidates, inflate threshold counts, and turn cheap
 * planning passes into multi-minute walks.
 *
 * Returns the number of items deleted (for logging / diagnostics).
 */
export async function cleanupTestDriveFolder(
	br: WebdriverIO.Browser,
): Promise<{ listed: number; deleted: number; failed: number }> {
	return await br.executeObsidian(async ({ app }) => {
		type DriveItem = { id: string; name: string };
		type Plugin = {
			driveFolderId: string;
			api: {
				listChildren: (folderId: string) => Promise<DriveItem[]>;
				deleteFile: (fileId: string) => Promise<void>;
			};
		};
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, Plugin> };
		}).plugins.plugins["vault-share"] as Plugin | undefined;
		if (!plugin) throw new Error("vault-share plugin not loaded");
		const folderId = plugin.driveFolderId;
		if (!folderId) throw new Error("cleanupTestDriveFolder: driveFolderId not set");

		const items = await plugin.api.listChildren(folderId);
		let deleted = 0;
		let failed = 0;
		for (const item of items) {
			try {
				await plugin.api.deleteFile(item.id);
				deleted++;
			} catch {
				// Best effort: a single failed delete should not abort cleanup.
				failed++;
			}
		}
		return { listed: items.length, deleted, failed };
	}) as unknown as { listed: number; deleted: number; failed: number };
}

/**
 * Preload sync history for the given files: writes each to both the vault and
 * Drive, then records it as a `Synced` candidate in IDB so the next planning
 * pass treats it as `noOp`.  After this returns, a subsequent local-side or
 * remote-side deletion will be correctly classified as deleteRemote /
 * deleteLocal (rather than the no-history-path "absent" case).
 *
 * Bypasses `bulkSync.run()` entirely — tests never need to drive the system
 * under test in order to construct initial conditions for the system under test.
 *
 * File paths must be flat (no parent folders); for nested paths the caller must
 * pre-create folders via `app.vault.createFolder()` before invoking this.
 */
export async function seedSyncedFiles(
	br: WebdriverIO.Browser,
	files: Array<{ path: string; content: string }>,
): Promise<void> {
	await br.executeObsidian(async ({ app }, fileList) => {
		type DriveFile = { id: string; modifiedTime?: string };
		type Plugin = {
			api: { writeFile: (parentId: string, name: string, content: string) => Promise<DriveFile> };
			driveFolderId: string;
			candidateStore: {
				insertSynced: (path: string, state: {
					driveFileId: string;
					localMtime: number;
					remoteMtime: number;
					localSize: number;
					remoteSize: number;
					syncedAt: number;
				}) => Promise<void>;
			};
		};
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, Plugin> };
		}).plugins.plugins["vault-share"] as Plugin | undefined;
		if (!plugin) throw new Error("vault-share plugin not loaded");
		const folderId = plugin.driveFolderId;
		if (!folderId) throw new Error("seedSyncedFiles: driveFolderId not set");

		for (const { path, content } of fileList as Array<{ path: string; content: string }>) {
			// 1. Local: create the file if it does not already exist.
			if (!app.vault.getAbstractFileByPath(path)) {
				await app.vault.create(path, content);
			}
			// 2. Drive: upload (or overwrite) the file with the same content.
			const driveFile = await plugin.api.writeFile(folderId, path, content);
			// 3. Read back local stat to record the exact mtime/size reconcile will see.
			const local = app.vault.getFileByPath(path);
			if (!local) throw new Error(`seedSyncedFiles: ${path} not found after create`);
			const remoteMtime = driveFile.modifiedTime
				? new Date(driveFile.modifiedTime).getTime()
				: Date.now();
			// Drive returns the content unchanged; size matches what we wrote.
			const size = new TextEncoder().encode(content).length;
			// 4. Persist as Synced so the next reconcile sees state = noOp.
			await plugin.candidateStore.insertSynced(path, {
				driveFileId: driveFile.id,
				localMtime: local.stat.mtime,
				localSize: local.stat.size,
				remoteMtime,
				remoteSize: size,
				syncedAt: Date.now(),
			});
		}
	}, files);
}

/**
 * Shape of a completed bulk sync pass, mirroring the production SyncPassResult.
 * Defined here so wdio.conf.mts has no import dependency on production source.
 */
interface SyncPassResult {
	downloaded: number;
	uploaded: number;
	deleted: number;
	conflicts: number;
	merges: number;
	failed: number;
	deferredByThreshold: boolean;
	error?: unknown;
}

/**
 * Trigger a bulk sync pass and wait for it to complete.
 *
 * `BulkSync.run` coalesces concurrent callers onto a single in-flight pass,
 * so awaiting it inside `executeObsidian` returns the actual pass result
 * (whether we triggered it or one was already running). The WebDriver
 * async-script timeout is bumped to 120 s in the `before:` hook, matching
 * mocha's per-test timeout.
 *
 * Note: executeObsidian serialises its callback via `func.toString()`, so no
 * module-level helpers are available inside the callback — all plugin access
 * must be inlined.
 */
export async function runBulkSync(br: WebdriverIO.Browser): Promise<SyncPassResult> {
	// Convert any thrown error inside the callback to a string before returning,
	// because WebDriver's JSON serialization on the way back to Node drops
	// Error's non-enumerable `message` / `stack`. Without this, every internal
	// failure surfaces as the opaque message `[object Object]`.
	const result = await br.executeObsidian(async ({ app }) => {
		type Plugin = { scheduler: unknown };
		type BulkSyncHandle = { run(): Promise<SyncPassResult> };
		try {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, Plugin> };
			}).plugins.plugins['vault-share'] as Plugin | undefined;
			if (!plugin) throw new Error('vault-share plugin not loaded');
			const bulkSync = (plugin.scheduler as unknown as {
				deps: { bulkSync: BulkSyncHandle };
			}).deps.bulkSync;
			const r = await bulkSync.run();
			// Same Error-stripping problem can happen for the `error` field
			// that doRun sets internally — flatten it to a string now so the
			// caller's diagnostic is useful instead of `[object Object]`.
			if (r.error) {
				const errMsg = r.error instanceof Error
					? `${r.error.message}\n${r.error.stack ?? ''}`
					: String(r.error);
				return { ...r, error: errMsg };
			}
			return r;
		} catch (err) {
			const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
			// Surface the synchronous throw the same way `r.error` would.
			return {
				downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, merges: 0,
				failed: 0, deferredByThreshold: false, error: msg,
			};
		}
	}) as unknown as SyncPassResult;

	if (result.error) {
		const msg = typeof result.error === 'string' ? result.error : String(result.error);
		throw new Error(`Bulk sync failed: ${msg}`);
	}
	return result;
}
