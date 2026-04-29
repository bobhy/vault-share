// Test helpers for domain types. Implement as corresponding interfaces are defined.
// See obsidian-air-sync/src/__mocks__/sync-test-helpers.ts for the reference implementation.

/** Create a FileEntity + ArrayBuffer pair from text content */
export function makeFile(path: string, content: string, mtime = 1000): { entity: { path: string; isDirectory: boolean; size: number; mtime: number }; content: ArrayBuffer } {
	const buf = new TextEncoder().encode(content).buffer;
	return {
		entity: { path, isDirectory: false, size: buf.byteLength, mtime },
		content: buf,
	};
}

/** Decode an ArrayBuffer to a string (for use in test assertions) */
export function readBuffer(content: ArrayBuffer): string {
	return new TextDecoder().decode(content);
}

// TODO: implement createMockFs() when IFileSystem is defined in src/fs/interface.ts
// TODO: implement createMockStateStore() when SyncStateStore is defined in src/sync/state.ts
// TODO: implement addFile() when FileEntity is defined
// TODO: implement mockSettings() when VaultShareSettings is defined in src/settings.ts
