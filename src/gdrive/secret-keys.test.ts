import { describe, it, expect } from 'vitest';
import { secretKeys } from './secret-keys';

describe('secretKeys vault name sanitization', () => {
	it('lowercases and replaces spaces with dashes', () => {
		expect(secretKeys('My Vault').refreshToken).toBe('vault-share-my-vault-refresh-token');
	});

	it('replaces slashes and other special characters with dashes', () => {
		expect(secretKeys('vault/share').refreshToken).toBe('vault-share-vault-share-refresh-token');
	});

	it('strips leading and trailing special characters', () => {
		expect(secretKeys('!vault!').refreshToken).toBe('vault-share-vault-refresh-token');
	});

	it('collapses consecutive special characters into a single dash', () => {
		expect(secretKeys('vault---share').refreshToken).toBe('vault-share-vault-share-refresh-token');
	});

	it('falls back to "default" when the name is entirely special characters', () => {
		expect(secretKeys('!!!').refreshToken).toBe('vault-share-default-refresh-token');
	});

	it('leaves an already-clean name unchanged', () => {
		expect(secretKeys('myvault').refreshToken).toBe('vault-share-myvault-refresh-token');
	});
});
