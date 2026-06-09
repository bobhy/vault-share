/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/types" />
/// <reference types="wdio-obsidian-service" />
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// UI / rendering e2e tests. Run with: npm run test:e2e:ui
//
// Unlike wdio.conf.mts these tests need NO Google Drive credentials: they
// exercise editor-side UI (the conflict-resolution panel) that operates purely
// on local editor content, so the before-hook only waits for the wdio bridge —
// it never injects a refresh token or touches Drive.
//
// `emulateMobile: true` boots Obsidian via app.emulateMobile() so Platform.isMobile
// is true and mobile CSS classes apply, letting desktop CI verify mobile-only
// layout (e.g. the panel docking at the bottom rather than under the status bar).
// Caveat: this is Electron emulation, not Capacitor — it reproduces the layout
// mechanism (bottom dock) but not device hardware like the real status bar.

const HEADLESS = process.env["WDIO_HEADLESS"] !== "false";

let xvfbProc: ChildProcess | null = null;
let wmProc: ChildProcess | null = null;

const obsidianCapability: WebdriverIO.Capabilities = {
	browserName: "obsidian",
	"wdio:obsidianOptions": {
		appVersion: "latest",
		vault: "tests/vaults/primary",
		plugins: ["."],
		emulateMobile: true,
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
	specs: ["./tests/wdio/ui/**/*.e2e.ts"],
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
		await new Promise<void>(r => setTimeout(r, 300));

		// A window manager is required for Obsidian to open windows on Xvfb.
		wmProc = spawn("herbstluftwm", [], { stdio: "ignore" });
		wmProc.on("error", () => { wmProc = null; });
	},

	onComplete: () => {
		wmProc?.kill();
		xvfbProc?.kill();
	},

	before: async (_caps, _specs, b) => {
		const br = b as WebdriverIO.Browser;
		await br.setTimeout({ script: 120_000 });

		// Wait for the wdio-obsidian-service bridge before any executeObsidian call.
		await br.waitUntil(
			() => br.execute(() =>
				typeof (window as unknown as { wdioObsidianService: unknown }).wdioObsidianService === "function",
			) as Promise<boolean>,
			{ timeout: 30_000, interval: 200, timeoutMsg: "wdioObsidianService not available after 30 s" },
		);

		// Silence the sync scheduler so no background pass interferes with the UI
		// under test. No Drive token is configured, so sync stays idle regardless;
		// stopping the scheduler just removes the heartbeat noise.
		await br.executeObsidian(async ({ app }) => {
			type Plugin = { scheduler?: { stop: () => Promise<void> } };
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, Plugin> };
			}).plugins.plugins["vault-share"] as Plugin | undefined;
			await plugin?.scheduler?.stop();
		});
	},
};
