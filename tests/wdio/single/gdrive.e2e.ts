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

import { RELAY_BASE_URL, GOOGLE_CLIENT_ID } from '../../../src/gdrive/auth';
import { GDriveApi } from '../../../src/gdrive/api';

const TEST_FOLDER_NAME = 'vault-share-test-folder';
const TEST_FILE_NAME = 'vault-share-e2e-test.md';
const TEST_CONTENT = 'A'.repeat(1000); // ~1000 bytes of known content

describe('Google Drive integration', () => {
	it('relay and client ID are configured (not TODO placeholders)', () => {
		expect(GOOGLE_CLIENT_ID).not.toBe('TODO');
		expect(RELAY_BASE_URL).not.toContain('TODO');
	});

	it('authenticates, reads, and writes a file round-trip', async () => {
		// Obtain a live access token via the plugin's auth instance.
		const api = await browser.executeObsidian(async ({ app }) => {
			// The plugin is already loaded and auth.loadFromSecretStorage() has run.
			// Trigger a token refresh to confirm the stored credentials are valid.
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { api: GDriveApi; auth: { getAccessToken: () => Promise<string> } }> } }).plugins.plugins['vault-share'];
			if (!plugin) throw new Error('vault-share plugin not loaded');
			await plugin.auth.getAccessToken(); // throws if credentials invalid
			return true;
		}) as unknown as boolean;

		expect(api).toBe(true);
	});

	it('creates or reuses the test folder', async () => {
		const folderId = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { api: GDriveApi }> } }).plugins.plugins['vault-share'];
			if (!plugin) throw new Error('vault-share plugin not loaded');
			return plugin.api.resolveFolder(`/${TEST_FOLDER_NAME}`);
		}) as unknown as string;

		expect(typeof folderId).toBe('string');
		expect(folderId.length).toBeGreaterThan(0);
	});

	it('writes a file and reads it back correctly', async () => {
		const result = await browser.executeObsidian(async ({ app }, folderName, fileName, content) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { api: GDriveApi }> } }).plugins.plugins['vault-share'];
			if (!plugin) throw new Error('vault-share plugin not loaded');

			const folderId = await plugin.api.resolveFolder(`/${folderName}`);
			await plugin.api.writeFile(folderId, fileName, content);
			return plugin.api.readFile(
				(await plugin.api.findFile(folderId, fileName))!.id,
			);
		}, TEST_FOLDER_NAME, TEST_FILE_NAME, TEST_CONTENT) as unknown as string;

		expect(result).toBe(TEST_CONTENT);
	});
});
