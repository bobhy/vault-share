import { describe, it, expect, vi } from 'vitest';
import type { SyncStore } from './store';
import { shortClientId, resolveClientId } from './client-id';

describe('shortClientId', () => {
	it('returns the first hyphen-delimited segment of a UUID', () => {
		expect(shortClientId('abc12345-def4-5678-9abc-def012345678')).toBe('abc12345');
	});

	it('falls back to the first 8 characters when there are no hyphens', () => {
		expect(shortClientId('abcdefghijklmnop')).toBe('abcdefgh');
	});
});

describe('resolveClientId', () => {
	it('returns the stored client ID without generating a new one', async () => {
		const putClientId = vi.fn();
		const store = {
			getClientId: vi.fn().mockResolvedValue('stored-uuid'),
			putClientId,
		} as unknown as SyncStore;

		const id = await resolveClientId(store);
		expect(id).toBe('stored-uuid');
		expect(putClientId).not.toHaveBeenCalled();
	});

	it('generates, stores, and returns a new UUID when none is stored', async () => {
		const putClientId = vi.fn().mockResolvedValue(undefined);
		const store = {
			getClientId: vi.fn().mockResolvedValue(null),
			putClientId,
		} as unknown as SyncStore;

		const id = await resolveClientId(store);
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(putClientId).toHaveBeenCalledWith(id);
	});

	it('generates a unique ID on each call to a fresh store', async () => {
		const makeStore = () => ({
			getClientId: vi.fn().mockResolvedValue(null),
			putClientId: vi.fn().mockResolvedValue(undefined),
		} as unknown as SyncStore);

		const id1 = await resolveClientId(makeStore());
		const id2 = await resolveClientId(makeStore());
		expect(id1).not.toBe(id2);
	});
});
