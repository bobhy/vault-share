/**
 * Playground: download files from Google Drive to the local playground directory.
 *
 * Lists every non-folder file in the configured Drive folder, downloads each
 * one as text, and writes it to persistentTestResources/playground-googleDrive/.
 * Files already present locally are overwritten.
 *
 * Prerequisites:
 *   .e2e-refresh-token file  OR  VAULT_SHARE_REFRESH_TOKEN env var
 *
 * Run:
 *   npm run playground:googleDrive:read
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, beforeAll, expect } from 'vitest';
import {
	createPlaygroundContext,
	PLAYGROUND_DIR,
	DRIVE_FOLDER_PATH,
	type PlaygroundContext,
} from './playground-setup';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

describe(`GDrive playground — read from "${DRIVE_FOLDER_PATH}"`, () => {
	let ctx: PlaygroundContext;

	beforeAll(async () => {
		ctx = await createPlaygroundContext();
	}, 30_000);

	it('connects and lists Drive folder contents', async () => {
		const files = await ctx.api.listChildren(ctx.folderId);
		const names = files.filter(f => f.mimeType !== FOLDER_MIME).map(f => f.name);

		console.log(`\nDrive folder "${DRIVE_FOLDER_PATH}" — ${names.length} file(s):`);
		names.forEach(n => console.log(`  ${n}`));

		expect(Array.isArray(files)).toBe(true);
	}, 30_000);

	it('downloads all Drive files to local playground dir', async () => {
		const files = await ctx.api.listChildren(ctx.folderId);
		const textFiles = files.filter(f => f.mimeType !== FOLDER_MIME);

		for (const file of textFiles) {
			const content = await ctx.api.readFile(file.id);
			const dest = join(PLAYGROUND_DIR, file.name);
			writeFileSync(dest, content);
			console.log(`  ↓ ${file.name}  (${content.length} chars)  →  ${dest}`);
		}

		console.log(`\nDownloaded ${textFiles.length} file(s) to ${PLAYGROUND_DIR}`);
		expect(textFiles.length).toBeGreaterThanOrEqual(0);
	}, 60_000);
});
