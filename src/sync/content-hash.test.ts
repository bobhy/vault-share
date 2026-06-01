import { describe, it, expect } from 'vitest';
import { sha256Hex } from './content-hash';

describe('sha256Hex', () => {
	it('returns the correct 64-character hex digest for known input', async () => {
		// echo -n 'hello' | sha256sum → 2cf24dba…
		const input = new TextEncoder().encode('hello').buffer;
		const digest = await sha256Hex(input);
		expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
	});

	it('returns a 64-character hex string for any non-empty input', async () => {
		const input = new TextEncoder().encode('Hello World').buffer;
		const digest = await sha256Hex(input);
		expect(digest).toHaveLength(64);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(digest).toBe('a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e');
	});

	it('returns the SHA-256 of an empty buffer', async () => {
		// echo -n '' | sha256sum → e3b0c44298fc1c149afbf4c8996fb924…
		const input = new ArrayBuffer(0);
		const digest = await sha256Hex(input);
		expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('produces different digests for different inputs', async () => {
		const a = new TextEncoder().encode('foo').buffer;
		const b = new TextEncoder().encode('bar').buffer;
		const [hashA, hashB] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
		expect(hashA).not.toBe(hashB);
	});

	it('produces identical digests for identical inputs', async () => {
		const a = new TextEncoder().encode('vault-share').buffer;
		const b = new TextEncoder().encode('vault-share').buffer;
		const [hashA, hashB] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
		expect(hashA).toBe(hashB);
	});
});
