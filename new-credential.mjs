#!/usr/bin/env node
/**
 * Install a new Google OAuth credential.
 *
 * Updates the client ID in wrangler.toml and src/gdrive/auth.ts,
 * uploads the client secret to Cloudflare Workers via `wrangler secret put`,
 * then deploys the worker with `wrangler deploy`.
 */

import { createInterface } from 'readline';
import { readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(ROOT, 'google-auth-relay/worker');
const WRANGLER_TOML = join(WORKER_DIR, 'wrangler.toml');
const AUTH_TS = join(ROOT, 'src/gdrive/auth.ts');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

const clientId = (await ask('New Google OAuth client ID: ')).trim();
const clientSecret = (await ask('New Google OAuth client secret (input visible): ')).trim();
rl.close();

if (!clientId || !clientSecret) {
	console.error('Error: client ID and client secret are required.');
	process.exit(1);
}

// Update GOOGLE_CLIENT_ID in wrangler.toml [vars]
let toml = readFileSync(WRANGLER_TOML, 'utf8');
const updatedToml = toml.replace(
	/^(GOOGLE_CLIENT_ID\s*=\s*)"[^"]*"/m,
	`$1"${clientId}"`,
);
if (updatedToml === toml) {
	console.error('Error: could not find GOOGLE_CLIENT_ID in wrangler.toml.');
	process.exit(1);
}
writeFileSync(WRANGLER_TOML, updatedToml);
console.log('Updated google-auth-relay/worker/wrangler.toml');

// Update GOOGLE_CLIENT_ID constant in auth.ts
let auth = readFileSync(AUTH_TS, 'utf8');
const updatedAuth = auth.replace(
	/^(export const GOOGLE_CLIENT_ID\s*=\s*)'[^']*';/m,
	`$1'${clientId}';`,
);
if (updatedAuth === auth) {
	console.error('Error: could not find GOOGLE_CLIENT_ID in src/gdrive/auth.ts.');
	process.exit(1);
}
writeFileSync(AUTH_TS, updatedAuth);
console.log('Updated src/gdrive/auth.ts');

// Upload client secret to Cloudflare Workers secret store
console.log('\nUploading GOOGLE_CLIENT_SECRET to Cloudflare...');
const secretResult = spawnSync(
	'npx', ['wrangler', 'secret', 'put', 'GOOGLE_CLIENT_SECRET'],
	{ cwd: WORKER_DIR, input: clientSecret + '\n', stdio: ['pipe', 'inherit', 'inherit'] },
);
if (secretResult.status !== 0) {
	console.error('Error: wrangler secret put failed.');
	process.exit(1);
}

// Deploy worker so the updated client ID var takes effect
console.log('\nDeploying worker...');
const deployResult = spawnSync(
	'npx', ['wrangler', 'deploy'],
	{ cwd: WORKER_DIR, stdio: 'inherit' },
);
if (deployResult.status !== 0) {
	console.error('Error: wrangler deploy failed.');
	process.exit(1);
}

console.log('\nDone. New credential installed.');
