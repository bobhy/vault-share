/**
 * Shared setup for Google Drive playground tests.
 *
 * **Token source**
 *
 * The same credential used by the wdio e2e tests: a refresh token written to
 * `.e2e-refresh-token` by `npm run setup:e2e:wdio`, or supplied via the
 * `VAULT_SHARE_REFRESH_TOKEN` environment variable.  No separate auth ceremony
 * is needed for the playground.
 *
 * **Token caching across runs**
 *
 * The refresh token is primed into the shim's `FileSecretStorage` at startup.
 * After `GDriveAuth` uses it to obtain a fresh access token, it calls
 * `saveToSecretStorage()`, which writes the access token and its expiry back
 * to `persistentTestResources/playground-gdrive-secrets.json`.  On the next
 * run, the cached access token is read back and used directly until it expires,
 * avoiding a relay round-trip on every invocation.
 *
 * **Drive folder**
 *
 * Defaults to `/vault-share-playground`; override with the
 * `PLAYGROUND_DRIVE_FOLDER` environment variable.  The folder is created
 * automatically if it does not already exist (via `GDriveApi.resolveFolder`).
 *
 * **Why `GDriveAuth` and `GDriveApi` are unmodified**
 *
 * `vitest.playground.config.ts` aliases `'obsidian'` → `obsidian-shim.ts`.
 * Every `import … from 'obsidian'` inside `src/` resolves to the shim during
 * playground runs, so `requestUrl` and `App.secretStorage` behave correctly in
 * Node.js without any changes to the production modules.
 *
 * @module
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './obsidian-shim';
import { GDriveAuth } from '../../src/gdrive/auth';
import { GDriveApi } from '../../src/gdrive/api';
import type { App as ObsidianApp } from 'obsidian'; // aliased to shim at runtime by vitest.playground.config.ts

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PERSISTENT = join(ROOT, 'persistentTestResources');

export const PLAYGROUND_DIR = join(PERSISTENT, 'playground-googleDrive');
const SECRETS_FILE = join(PERSISTENT, 'playground-gdrive-secrets.json');
const REFRESH_TOKEN_KEY = 'vault-share-googledrive-refresh-token';

export const DRIVE_FOLDER_PATH =
	process.env['PLAYGROUND_DRIVE_FOLDER'] ?? '/vault-share-playground';

/** Live GDriveAuth, GDriveApi, and resolved folder ID for one playground run. */
export interface PlaygroundContext {
	/** Authenticated GDriveAuth instance backed by the file-based secret storage shim. */
	auth: GDriveAuth;
	/** GDriveApi instance wired to {@link auth}. */
	api: GDriveApi;
	/** Drive folder ID for {@link DRIVE_FOLDER_PATH}, created if absent. */
	folderId: string;
}

/**
 * Bootstrap a playground run.
 *
 * 1. Reads the refresh token from `.e2e-refresh-token` or `VAULT_SHARE_REFRESH_TOKEN`.
 * 2. Primes `FileSecretStorage` so `GDriveAuth.loadFromSecretStorage()` finds it.
 * 3. Constructs `GDriveAuth` and `GDriveApi` using the shim `App`.
 * 4. Resolves (and creates if absent) the playground Drive folder.
 *
 * @throws {Error} if no refresh token is available.
 */
export async function createPlaygroundContext(): Promise<PlaygroundContext> {
	mkdirSync(PLAYGROUND_DIR, { recursive: true });

	let refreshToken = process.env['VAULT_SHARE_REFRESH_TOKEN'];
	if (!refreshToken) {
		try {
			refreshToken = readFileSync(join(ROOT, '.e2e-refresh-token'), 'utf8').trim();
		} catch {
			throw new Error(
				'No GDrive refresh token found.\n' +
				'Run:  npm run setup:e2e:wdio\n' +
				'Or set VAULT_SHARE_REFRESH_TOKEN.',
			);
		}
	}

	const app = new App(SECRETS_FILE);
	// Prime the file-backed storage; GDriveAuth.loadFromSecretStorage() reads it back.
	app.secretStorage.setSecret(REFRESH_TOKEN_KEY, refreshToken);

	// vitest aliases 'obsidian' → our shim at runtime, satisfying GDriveAuth's
	// App parameter. The cast bridges the compile-time type gap.
	const auth = new GDriveAuth(app as unknown as ObsidianApp);
	auth.loadFromSecretStorage();

	const api = new GDriveApi(auth);
	const folderId = await api.resolveFolder(DRIVE_FOLDER_PATH);

	return { auth, api, folderId };
}
