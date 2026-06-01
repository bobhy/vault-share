/**
 * Per-vault client identity.
 *
 * Each Obsidian installation owns a stable UUID v4 persisted in IDB so that
 * conflict-copy filenames, deferral records, and sync metadata can attribute
 * actions to a specific device — even when two vaults run on the same machine.
 *
 * @packageDocumentation
 */
import type { SyncStore } from './store';

/**
 * Return the stable per-vault client ID.
 * Generated as a UUID v4 on first call and persisted in SyncStore,
 * so each vault installation gets a unique identity even when two vaults
 * run on the same device.
 */
export function shortClientId(id: string): string {
	// Use only the first UUID segment (8 hex chars) for human-readable labels.
	const hyphen = id.indexOf('-');
	return hyphen === -1 ? id.slice(0, 8) : id.slice(0, hyphen);
}


/**
 * Look up the persisted client ID; if none, generate a UUID v4, persist it,
 * and return it. Call once at plugin load and pass the result through the
 * `SyncContext`.
 */
export async function resolveClientId(store: SyncStore): Promise<string> {
	const stored = await store.getClientId();
	if (stored) return stored;

	const id = generateUUID();
	await store.putClientId(id);
	return id;
}

function generateUUID(): string {
	// crypto.randomUUID is available in all modern environments including mobile browsers.
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// Fallback: construct a UUID v4 from random bytes.
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant bits
	const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
