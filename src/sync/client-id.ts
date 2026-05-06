import type { SyncStore } from './store';

/**
 * Return the stable per-device client ID.
 * Prefers a sanitized OS hostname; falls back to a stored UUID.
 * The UUID is generated on first call and persisted in SyncStore.
 * Survives plugin uninstall/reinstall because the IDB database persists.
 */
export async function resolveClientId(store: SyncStore): Promise<string> {
	const stored = await store.getClientId();
	if (stored) return stored;

	const id = deriveClientId();
	await store.putClientId(id);
	return id;
}

function deriveClientId(): string {
	return generateUUID();
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
