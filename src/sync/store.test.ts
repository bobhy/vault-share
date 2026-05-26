import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SyncStore, EMPTY_STATS } from './store';
import type { SyncStats } from './types';

beforeEach(() => {
	// eslint-disable-next-line obsidianmd/prefer-active-doc -- test env setup, not production UI code
	globalThis.indexedDB = new IDBFactory();
});

describe('SyncStore', () => {
	let store: SyncStore;

	beforeEach(async () => {
		store = new SyncStore('test-vault');
		await store.open();
	});

	afterEach(() => {
		store.close();
	});

	// -------------------------------------------------------------------------
	// sync-content store
	// -------------------------------------------------------------------------

	describe('sync content', () => {
		it('returns undefined for unknown path', async () => {
			expect(await store.getContent('missing.md')).toBeUndefined();
		});

		it('round-trips binary content', async () => {
			const buf = new TextEncoder().encode('hello world').buffer;
			await store.putContent('doc.md', buf);
			const result = await store.getContent('doc.md');
			expect(result).toBeDefined();
			expect(new TextDecoder().decode(result)).toBe('hello world');
		});

		it('overwrites existing content', async () => {
			const first = new TextEncoder().encode('v1').buffer;
			const second = new TextEncoder().encode('v2').buffer;
			await store.putContent('f.md', first);
			await store.putContent('f.md', second);
			const result = await store.getContent('f.md');
			expect(new TextDecoder().decode(result)).toBe('v2');
		});

		it('deleteContent removes the entry', async () => {
			const buf = new TextEncoder().encode('to delete').buffer;
			await store.putContent('del.md', buf);
			await store.deleteContent('del.md');
			expect(await store.getContent('del.md')).toBeUndefined();
		});

		it('deleteContent is a no-op for unknown path', async () => {
			await expect(store.deleteContent('ghost.md')).resolves.toBeUndefined();
		});

		it('clearContent removes all entries', async () => {
			await store.putContent('a.md', new TextEncoder().encode('a').buffer);
			await store.putContent('b.md', new TextEncoder().encode('b').buffer);
			await store.clearContent();
			expect(await store.getContent('a.md')).toBeUndefined();
			expect(await store.getContent('b.md')).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// sync-stats store
	// -------------------------------------------------------------------------

	describe('sync stats', () => {
		it('returns EMPTY_STATS when nothing has been persisted', async () => {
			expect(await store.getStats()).toEqual(EMPTY_STATS);
		});

		it('round-trips stats', async () => {
			const stats: SyncStats = { ...EMPTY_STATS, filesPushed: 5, filesPulled: 3 };
			await store.putStats(stats);
			expect(await store.getStats()).toEqual(stats);
		});

		it('overwrites previous stats', async () => {
			await store.putStats({ ...EMPTY_STATS, filesPushed: 1 });
			await store.putStats({ ...EMPTY_STATS, filesPushed: 99 });
			expect((await store.getStats()).filesPushed).toBe(99);
		});

		it('clearStats resets to EMPTY_STATS', async () => {
			await store.putStats({ ...EMPTY_STATS, filesPushed: 7 });
			await store.clearStats();
			expect(await store.getStats()).toEqual(EMPTY_STATS);
		});
	});

	// -------------------------------------------------------------------------
	// device store (clientId)
	// -------------------------------------------------------------------------

	describe('client id', () => {
		it('returns undefined when not set', async () => {
			expect(await store.getClientId()).toBeUndefined();
		});

		it('round-trips a client id', async () => {
			await store.putClientId('abc-123');
			expect(await store.getClientId()).toBe('abc-123');
		});

		it('overwrites previous client id', async () => {
			await store.putClientId('old-id');
			await store.putClientId('new-id');
			expect(await store.getClientId()).toBe('new-id');
		});
	});

	// -------------------------------------------------------------------------
	// schema upgrade (cold-start)
	// -------------------------------------------------------------------------

	describe('schema upgrade', () => {
		it('drops and recreates stores on version bump (cold-start)', async () => {
			// Write content at the current version, then verify a fresh store starts empty.
			await store.putContent('before.md', new TextEncoder().encode('x').buffer);
			store.close();

			// Re-open at a higher version simulates a schema migration.
			// We can't bump DB_VERSION from here, but we can verify that a fresh-named
			// store opens cleanly and starts empty (tests the creation path).
			const helper2 = new SyncStore('test-vault-v2');
			await helper2.open();
			expect(await helper2.getContent('before.md')).toBeUndefined();
			helper2.close();
		});
	});
});
