/**
 * Playground shim for the `obsidian` package.
 *
 * **Why this exists**
 *
 * {@link GDriveAuth} and {@link GDriveApi} depend on two Obsidian APIs that
 * only exist inside the Obsidian Electron process:
 * - `requestUrl` — Obsidian's HTTP client
 * - `App.secretStorage` — OS keychain wrapper
 *
 * Running those modules in plain Node.js (e.g. via vitest) therefore requires
 * compatible replacements.  This file provides them without touching any
 * production code: `vitest.playground.config.ts` aliases `'obsidian'` →
 * this module so that every `import … from 'obsidian'` inside `src/` resolves
 * here during playground runs.
 *
 * **requestUrl shim**
 *
 * Wraps the Node.js native `fetch` (available since Node 18) and mirrors the
 * Obsidian `RequestUrlResponse` shape — `.status`, `.json`, `.text`,
 * `.arrayBuffer` — so callers need no changes.  The `throw: false` option is
 * honoured identically to the real implementation.
 *
 * **App.secretStorage shim**
 *
 * Backed by a JSON file at
 * `persistentTestResources/playground-gdrive-secrets.json`.  All writes are
 * synchronous (`writeFileSync`) so callers that do not `await setSecret` still
 * see consistent in-memory state, matching production behaviour.  The file
 * persists the access token and its expiry across playground runs, meaning
 * repeated runs reuse a cached token rather than triggering a full refresh
 * every time.
 *
 * @module
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── requestUrl shim ────────────────────────────────────────────────────────

interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

interface RequestUrlResponse {
	status: number;
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
}

/**
 * Node.js shim for Obsidian's `requestUrl`.
 *
 * Delegates to `fetch` and normalises the response into the same shape
 * (`status`, `json`, `text`, `arrayBuffer`) that production code expects.
 * The `throw` option defaults to `true` (throws on non-2xx), matching the
 * Obsidian behaviour; pass `throw: false` to suppress automatic throwing.
 */
export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
	const res = await fetch(param.url, {
		method: param.method ?? 'GET',
		headers: param.headers as HeadersInit,
		body: param.body !== undefined ? (param.body as BodyInit) : undefined,
	});

	const arrayBuffer = await res.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);

	let json: unknown = null;
	if (text) {
		try { json = JSON.parse(text); } catch { /* not JSON */ }
	}

	if (param.throw !== false && !res.ok) {
		throw new Error(`HTTP ${res.status}: ${text}`);
	}

	return { status: res.status, json, text, arrayBuffer };
}

// ── SecretStorage shim (file-backed) ──────────────────────────────────────

class FileSecretStorage {
	private readonly data: Record<string, string>;

	constructor(private readonly filePath: string) {
		try {
			this.data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
		} catch {
			this.data = {};
		}
	}

	getSecret(key: string): string | null {
		return this.data[key] ?? null;
	}

	// Matches the Obsidian SecretStorage signature (Promise<void>) but writes
	// synchronously so callers that don't await still see consistent state.
	setSecret(key: string, value: string): void {
		this.data[key] = value;
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
	}
}

// ── App shim ──────────────────────────────────────────────────────────────

/**
 * Minimal `App` shim for the playground.
 *
 * Exposes only the `secretStorage` surface that {@link GDriveAuth} reads and
 * writes.  The `secretsFilePath` constructor argument replaces Obsidian's
 * OS-keychain backend with a plain JSON file, making tokens available across
 * Node.js process restarts.
 *
 * After a successful token refresh, `GDriveAuth.saveToSecretStorage()` writes
 * the new access token and expiry back through this shim, so the next
 * playground run reuses the cached token instead of hitting the relay
 * immediately.
 */
export class App {
	readonly secretStorage: FileSecretStorage;

	constructor(secretsFilePath: string) {
		this.secretStorage = new FileSecretStorage(secretsFilePath);
	}
}
