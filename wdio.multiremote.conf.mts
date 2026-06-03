/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/types" />
/// <reference types="wdio-obsidian-service" />
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import ObsidianLauncher from "obsidian-launcher";

// Cross-vault (multiremote) e2e tests. Run with: npm run test:e2e:cross
// One-time token setup:  npm run setup:e2e:wdio

/**
 * When true (the default), the runner starts a virtual display and window manager
 * so Obsidian can run without a physical monitor — suitable for CI.
 * Set WDIO_HEADLESS=false to use the current $DISPLAY for interactive debugging.
 */
const HEADLESS = process.env["WDIO_HEADLESS"] !== "false";

/**
 * When true, run ONLY the large-scale cross specs (`*.scale.e2e.ts`); otherwise
 * run the default cross specs and exclude the scale ones. Opt-in via
 * `npm run test:e2e:scale:cross` (sets WDIO_SCALE=true).
 */
const SCALE = process.env["WDIO_SCALE"] === "true";

// Processes started for the virtual display; killed in onComplete.
let xvfbProc: ChildProcess | null = null;
let wmProc: ChildProcess | null = null;

// Collect tmp dirs created in beforeSession so onComplete can remove them.
const multiremoteTmpDirs: string[] = [];

export const config: WebdriverIO.MultiremoteConfig = {
	runner: "local",
	logLevel: "warn",
	framework: "mocha",
	specs: [SCALE ? "./tests/wdio/cross/**/*.scale.e2e.ts" : "./tests/wdio/cross/**/*.e2e.ts"],
	exclude: SCALE ? [] : ["./tests/wdio/cross/**/*.scale.e2e.ts"],
	maxInstances: 1,

	// Keep downloaded Obsidian binaries on local disk — avoids EBUSY on NFS.
	cacheDir: join(homedir(), ".obsidian-wdio-cache"),

	capabilities: {
		primaryVault: {
			capabilities: {
				browserName: "obsidian",
				"wdio:obsidianOptions": {
					appVersion: "latest",
					vault: "tests/vaults/primary",
					plugins: ["."],
				},
				...(HEADLESS && process.platform === "linux" ? {
					"goog:chromeOptions": { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
				} : {}),
			},
		},
		peerVault: {
			capabilities: {
				browserName: "obsidian",
				"wdio:obsidianOptions": {
					appVersion: "latest",
					vault: "tests/vaults/peer",
					plugins: ["."],
				},
				...(HEADLESS && process.platform === "linux" ? {
					"goog:chromeOptions": { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
				} : {}),
			},
		},
	},

	services: ["obsidian"],
	reporters: ["spec"],

	mochaOpts: {
		ui: "bdd",
		timeout: 300_000,
	},

	// wdio-obsidian-service's beforeSession skips multiremote caps because the combined
	// capabilities object lacks wdio:obsidianOptions at the top level. We replicate the
	// two steps it would have performed — setupVault (copy + install plugins) and
	// electronSetupConfigDir (write obsidian.json, set --user-data-dir) — for each
	// individual capability here.
	beforeSession: async (_config, cap) => {
		const OBSIDIAN_KEY = "wdio:obsidianOptions";
		// If the top-level cap already has wdio:obsidianOptions, the service will handle it.
		if ((cap as Record<string, unknown>)[OBSIDIAN_KEY]) return;

		type NormalizedObsidianOptions = {
			vault?: string;
			copy?: boolean;
			plugins?: unknown[];
			themes?: unknown[];
			appVersion: string;
			installerVersion: string;
			appPath?: string;
			emulateMobile?: boolean;
			openVault?: string;
		};
		type IndividualCap = {
			[key: string]: unknown;
			"goog:chromeOptions"?: { args?: string[] };
		};

		const entries = Object.values(
			cap as Record<string, { capabilities: IndividualCap }>
		);
		const obsidianEntries = entries
			.map(e => e.capabilities)
			.filter(c => c[OBSIDIAN_KEY]);

		if (obsidianEntries.length === 0) return;

		const launcher = new ObsidianLauncher({
			cacheDir: join(homedir(), ".obsidian-wdio-cache"),
		});

		await Promise.all(obsidianEntries.map(async (indCap) => {
			const opts = indCap[OBSIDIAN_KEY] as NormalizedObsidianOptions;

			// Copy vault to temp dir and install plugins (mirrors ObsidianWorkerService.setupVault).
			if (opts.vault) {
				const openVault = await launcher.setupVault({
					vault: opts.vault,
					copy: opts.copy ?? true,
					// plugins/themes are already downloaded DownloadedPluginEntry[] after onPrepare.
					plugins: opts.plugins as Parameters<typeof launcher.setupVault>[0]["plugins"],
					themes: opts.themes as Parameters<typeof launcher.setupVault>[0]["themes"],
				});
				if (opts.copy ?? true) multiremoteTmpDirs.push(openVault);
				opts.openVault = openVault;
			}

			// Write obsidian.json + chrome localStorage and get the --user-data-dir path
			// (mirrors ObsidianWorkerService.electronSetupConfigDir).
			const configDir = await launcher.setupConfigDir({
				appVersion: opts.appVersion,
				installerVersion: opts.installerVersion,
				appPath: opts.appPath,
				vault: opts.openVault,
				localStorage: opts.emulateMobile ? { EmulateMobile: "1" } : {},
			});
			multiremoteTmpDirs.push(configDir);

			const existing = indCap["goog:chromeOptions"] ?? {};
			indCap["goog:chromeOptions"] = {
				...existing,
				args: [`--user-data-dir=${configDir}`, ...(existing.args ?? [])],
			};
		}));
	},

	onPrepare: async () => {
		if (!HEADLESS || process.platform !== "linux") return;

		process.env["DISPLAY"] = ":99";
		xvfbProc = spawn("Xvfb", [":99", "-screen", "0", "1280x1024x24", "+extension", "GLX"], {
			stdio: "ignore",
		});
		await new Promise<void>(r => setTimeout(r, 300));

		wmProc = spawn("herbstluftwm", [], { stdio: "ignore" });
		wmProc.on("error", () => { wmProc = null; });
	},

	onComplete: async () => {
		wmProc?.kill();
		xvfbProc?.kill();
		await Promise.all(
			multiremoteTmpDirs.map(dir => rm(dir, { recursive: true, force: true }))
		);
	},

	before: async (caps, _specs, b) => {
		// wdio-obsidian-service skips its before() in multiremote because the top-level
		// capabilities lack wdio:obsidianOptions, so executeObsidian is never added to
		// sub-instances. Polyfill it on each instance using the same script the service uses.
		const mr = b as WebdriverIO.MultiRemoteBrowser;
		const instanceNames = Object.keys(caps as Record<string, unknown>);

		for (const name of instanceNames) {
			const instance = mr.getInstance(name) as WebdriverIO.Browser;
			(instance as unknown as Record<string, unknown>).executeObsidian =
				async (func: (...args: unknown[]) => unknown, ...params: unknown[]) =>
					instance.execute(
						`const require = window.wdioObsidianService().require;
						try {
							return await (${func.toString()}).call(null, window.wdioObsidianService(), ...arguments);
						} catch (e) {
							if ("code" in e && typeof e.code != "number") { delete e.code; }
							throw e;
						}`,
						...params,
					);
		}

		// Wait for the wdio-obsidian-service bridge to be ready on every instance.
		await Promise.all(instanceNames.map(name => {
			const instance = mr.getInstance(name) as WebdriverIO.Browser;
			return instance.waitUntil(
				() => instance.execute(() =>
					typeof (window as unknown as { wdioObsidianService: unknown }).wdioObsidianService === "function",
				) as Promise<boolean>,
				{ timeout: 30_000, interval: 200, timeoutMsg: `wdioObsidianService not available on ${name} after 30 s` },
			);
		}));

		// Bump WebDriver's async-script timeout on each instance so `runBulkSync`
		// can await `bulkSync.run()` inside executeObsidian without hitting the
		// 30 s default during slow Drive passes. Matches the single-vault config.
		await Promise.all(instanceNames.map(name => {
			const instance = mr.getInstance(name) as WebdriverIO.Browser;
			return instance.setTimeout({ script: 120_000 });
		}));

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
		process.env["VAULT_SHARE_REFRESH_TOKEN"] = refreshToken;
	},
};
