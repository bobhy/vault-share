#!/usr/bin/env node
/**
 * Build the plugin and install it into one or more Obsidian vaults.
 *
 * Usage: npm run deploy -- <vault-path> [<vault-path> ...]
 *
 * Creates <vault>/.obsidian/plugins/vault-share/ if absent, then copies
 * main.js, manifest.json, and styles.css into it.
 */

import { copyFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = 'vault-share';
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];

const vaults = process.argv.slice(2);
if (vaults.length === 0) {
	console.error('Usage: npm run deploy -- <vault-path> [<vault-path> ...]');
	process.exit(1);
}

console.log('Building...');
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
if (build.status !== 0) {
	console.error('Build failed.');
	process.exit(1);
}

for (const vault of vaults) {
	const pluginDir = join(vault, '.obsidian', 'plugins', PLUGIN_ID);
	mkdirSync(pluginDir, { recursive: true });
	for (const file of PLUGIN_FILES) {
		copyFileSync(join(ROOT, file), join(pluginDir, file));
	}
	console.log(`Deployed to ${pluginDir}`);
}
