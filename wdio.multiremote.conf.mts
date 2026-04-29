/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/types" />
/// <reference types="wdio-obsidian-service" />
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import ObsidianLauncher from "obsidian-launcher";

// Cross-vault (multiremote) e2e tests. Run with: npm run test:e2e:cross
// One-time token setup:  npm run setup:e2e:wdio

// Collect tmp dirs created in beforeSession so onComplete can remove them.
const multiremoteTmpDirs: string[] = [];

export const config: WebdriverIO.MultiremoteConfig = {
	runner: "local",
	logLevel: "warn",
	framework: "mocha",
	specs: ["./tests/wdio/cross/**/*.e2e.ts"],
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

	onComplete: async () => {
		await Promise.all(
			multiremoteTmpDirs.map(dir => rm(dir, { recursive: true, force: true }))
		);
	},

	before: async (_caps, _specs, _b) => {
		// In multiremote mode, executeObsidian is not available on instances from
		// getInstance() at this lifecycle stage. Vault initialization (token injection)
		// is handled in the test file's own before() hook instead.
		// Here we only ensure the token is in env so both the test's before() and
		// the Drive API helpers can access it.
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
