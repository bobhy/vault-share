/**
 * One-time setup: reads the GDrive refresh token from the running Obsidian and saves
 * it to .e2e-refresh-token so wdio tests can inject it into sandboxed vault instances.
 *
 * Run with: npm run setup:e2e:wdio
 * Requires any vault open in Obsidian that is already authenticated with Google Drive.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { secretKeys } from "../../src/gdrive/secret-keys.js";

const execAsync = promisify(exec);

/**
 * Parse the result line from `obsidian-cli eval` output.
 * The CLI prints `=> <value>` for non-null results and bare `=>` for null/undefined.
 * Returns null when the result is absent or empty.
 */
function parseEvalResult(stdout: string): string | null {
	const line = stdout.split("\n").map(l => l.trim()).find(l => l.startsWith("=>"));
	if (!line) return undefined as unknown as null; // no result line at all
	const value = line.slice(2).trim(); // strip `=>` and any surrounding whitespace
	return (value === "" || value === "null" || value === "undefined") ? null : value;
}

// Get the vault name from the running Obsidian instance so we can derive the
// correct vault-scoped secret key.
const { stdout: vaultStdout } = await execAsync(
	`obsidian-cli eval 'code=app.vault.getName()'`,
	{ timeout: 10_000 },
);
const vaultName = parseEvalResult(vaultStdout);
if (!vaultName) throw new Error(`Could not read vault name from Obsidian:\n${vaultStdout}`);

const refreshKey = secretKeys(vaultName).refreshToken;

const { stdout } = await execAsync(
	`obsidian-cli eval 'code=app.secretStorage.getSecret("${refreshKey}")'`,
	{ timeout: 10_000 },
);

// obsidian-cli eval prints log lines before the `=> <value>` result line.
// String values are printed raw (not JSON-encoded).
const token = parseEvalResult(stdout);
if (token === null || token === undefined) {
	const isStartingUp = stdout.includes("Loaded main app package");
	if (isStartingUp) {
		console.error("Obsidian is still starting up. Wait for it to finish loading, then re-run this command.");
	} else {
		console.error("No refresh token in SecretStorage.");
		console.error("Make sure a vault is open in Obsidian and authenticated with Google Drive.");
	}
	process.exit(1);
}

await writeFile(".e2e-refresh-token", token, "utf8");
console.log("Refresh token saved to .e2e-refresh-token (gitignored).");
console.log("You can now run: npm run test:e2e:single  or  npm run test:e2e:cross");
