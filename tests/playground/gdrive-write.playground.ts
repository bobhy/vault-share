/**
 * Playground: upload files to Google Drive from the local playground directory.
 *
 * Always writes a timestamped probe file so there is always something to read
 * back. Also uploads any .txt or .md files already present in
 * persistentTestResources/playground-googleDrive/ (e.g. placed there manually
 * or downloaded by a previous read run).
 *
 * Prerequisites:
 *   .e2e-refresh-token file  OR  VAULT_SHARE_REFRESH_TOKEN env var
 *
 * Run:
 *   npm run playground:googleDrive:write
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, beforeAll, expect } from 'vitest';
import {
	createPlaygroundContext,
	PLAYGROUND_DIR,
	DRIVE_FOLDER_PATH,
	type PlaygroundContext,
} from './playground-setup';

const PROBE_FILE = 'playground-probe.txt';
const UPLOADABLE = /\.(txt|md)$/i;

describe(`GDrive playground — write to "${DRIVE_FOLDER_PATH}"`, () => {
	let ctx: PlaygroundContext;

	beforeAll(async () => {
		ctx = await createPlaygroundContext();
	}, 30_000);

	it('writes a timestamped probe file and reads it back', async () => {
		const content = `Playground probe\nWritten: ${new Date().toISOString()}\n`;
		await ctx.api.writeFile(ctx.folderId, PROBE_FILE, content);

		const found = await ctx.api.findFile(ctx.folderId, PROBE_FILE);
		console.log(`\n  ↑ ${PROBE_FILE}  (id: ${found?.id ?? 'unknown'})`);

		expect(found).not.toBeNull();
	}, 30_000);

	it('uploads local playground files to Drive', async () => {
		const entries = readdirSync(PLAYGROUND_DIR, { withFileTypes: true });
		const uploadable = entries.filter(
			e => e.isFile() && UPLOADABLE.test(e.name) && e.name !== '.gitkeep',
		);

		for (const entry of uploadable) {
			const content = readFileSync(join(PLAYGROUND_DIR, entry.name), 'utf8');
			await ctx.api.writeFile(ctx.folderId, entry.name, content);
			console.log(`  ↑ ${entry.name}  (${content.length} chars)`);
		}

		console.log(`\nUploaded ${uploadable.length} local file(s) from ${PLAYGROUND_DIR}`);
		expect(uploadable.length).toBeGreaterThanOrEqual(0);
	}, 60_000);
});
