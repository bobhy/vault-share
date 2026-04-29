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

const execAsync = promisify(exec);

const { stdout } = await execAsync(
	`obsidian eval 'code=app.secretStorage.getSecret("vault-share-googledrive-refresh-token")'`,
	{ timeout: 10_000 },
);

// obsidian eval prints log lines before the "=> <value>" result line.
// String values are printed raw (not JSON-encoded), so slice off the "=> " prefix directly.
const resultLine = stdout.split("\n").map(l => l.trim()).find(l => l.startsWith("=> "));
if (!resultLine) throw new Error(`No result line in obsidian eval output:\n${stdout}`);
const rawValue = resultLine.slice(3);
const token = rawValue === "null" ? null : rawValue;

if (!token) {
	console.error("No refresh token in SecretStorage.");
	console.error("Make sure a vault is open in Obsidian and authenticated with Google Drive.");
	process.exit(1);
}

await writeFile(".e2e-refresh-token", token, "utf8");
console.log("Refresh token saved to .e2e-refresh-token (gitignored).");
console.log("You can now run: npm run test:e2e:single  or  npm run test:e2e:cross");
