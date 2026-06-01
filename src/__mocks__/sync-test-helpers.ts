// Test helpers for domain types.

/** Create a vault file descriptor + ArrayBuffer pair from text content. */
export function makeFile(path: string, content: string, mtime = 1000): { entity: { path: string; isDirectory: boolean; size: number; mtime: number }; content: ArrayBuffer } {
	const buf = new TextEncoder().encode(content).buffer;
	return {
		entity: { path, isDirectory: false, size: buf.byteLength, mtime },
		content: buf,
	};
}

/** Decode an ArrayBuffer to a string (for use in test assertions). */
export function readBuffer(content: ArrayBuffer): string {
	return new TextDecoder().decode(content);
}

import { DEFAULT_SETTINGS, VaultShareSettings } from '../settings';

/** Return a complete VaultShareSettings object with optional overrides. */
export function mockSettings(overrides: Partial<VaultShareSettings> = {}): VaultShareSettings {
	return Object.assign({}, DEFAULT_SETTINGS, overrides);
}
