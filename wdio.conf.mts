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

		// Cache the token so Drive API helpers in test files can access it.
		process.env["VAULT_SHARE_REFRESH_TOKEN"] = refreshToken;
	},
};

/**
 * Inject a GDrive refresh token and fully configure the vault-share plugin for
 * testing. Because wdio uses a fresh --user-data-dir, secretStorage is empty and
 * no keyring daemon is available in headless CI. This function:
 *   1. Injects the token directly into the auth object's memory (bypasses keyring).
 *   2. Sets the Drive folder path and resolves it so bulk-sync can run.
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
		};
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, Plugin> };
		}).plugins.plugins["vault-share"] as Plugin | undefined;
		if (!plugin) throw new Error("vault-share plugin not loaded");

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
 * Shape of a completed bulk sync pass, mirroring the production SyncPassResult.
 * Defined here so wdio.conf.mts has no import dependency on production source.
 */
interface SyncPassResult {
	downloaded: number;
	uploaded: number;
	deleted: number;
	conflicts: number;
	merges: number;
	deferredByThreshold: boolean;
	error?: unknown;
}

/**
 * Trigger a bulk sync pass and wait for it to complete.
 *
 * Fires the sync without awaiting inside `executeObsidian` to avoid hitting
 * WebDriver's async-script timeout on slow Drive API responses.  Completion
 * is detected by polling {@link BulkSync.lastPassCompletedAt} from the Node
 * side; the test waits up to two minutes before failing.
 *
 * If a pass is already running when called, this function waits for that
 * in-flight pass to finish — the new {@link BulkSync.run} call is a no-op
 * but the running pass will still update `lastPassCompletedAt` on completion.
 *
 * Note: executeObsidian serialises its callback via `func.toString()`, so no
 * module-level helpers are available inside the callbacks — all plugin access
 * must be inlined.
 */
export async function runBulkSync(br: WebdriverIO.Browser): Promise<SyncPassResult> {
	// Fire the sync without awaiting, record the wall-clock start time.
	const startedAt = await br.executeObsidian(({ app }) => {
		type Plugin = { scheduler: unknown };
		type BulkSyncHandle = { run(): Promise<unknown> };
		const plugin = (app as unknown as {
			plugins: { plugins: Record<string, Plugin> };
		}).plugins.plugins['vault-share'] as Plugin | undefined;
		if (!plugin) throw new Error('vault-share plugin not loaded');
		const bulkSync = (plugin.scheduler as unknown as {
			deps: { bulkSync: BulkSyncHandle };
		}).deps.bulkSync;
		void bulkSync.run();   // completion signalled via lastPassCompletedAt
		return Date.now();
	}) as unknown as number;

	// Poll until the in-flight pass reports completion, capturing the result in
	// the same check to avoid a separate round-trip after the condition fires.
	let result: SyncPassResult | null = null;
	await br.waitUntil(
		async () => {
			const { completedAt, passResult } = await br.executeObsidian(({ app }) => {
				type Plugin = { scheduler: unknown };
				type BulkSyncHandle = { lastPassCompletedAt: number; lastPassResult: unknown };
				const plugin = (app as unknown as {
					plugins: { plugins: Record<string, Plugin> };
				}).plugins.plugins['vault-share'] as Plugin | undefined;
				const bulkSync = (plugin?.scheduler as unknown as {
					deps: { bulkSync: BulkSyncHandle };
				} | undefined)?.deps.bulkSync;
				return {
					completedAt: bulkSync?.lastPassCompletedAt ?? 0,
					passResult:  bulkSync?.lastPassResult ?? null,
				};
			}) as unknown as { completedAt: number; passResult: SyncPassResult | null };
			if (completedAt > startedAt) {
				result = passResult;
				return true;
			}
			return false;
		},
		{ timeout: 120_000, interval: 100, timeoutMsg: 'Bulk sync did not complete within 2 minutes' },
	);

	if (!result) throw new Error('Bulk sync completed but lastPassResult is null');
	if (result.error) {
		const msg = result.error instanceof Error ? result.error.message : String(result.error);
		throw new Error(`Bulk sync failed: ${msg}`);
	}
	return result;
}
