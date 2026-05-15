import { describe, it, expect } from 'vitest';
import { GDriveError, codeFromStatus } from './errors';

describe('GDriveError', () => {
	it('preserves message, code, and optional HTTP status', () => {
		const e = new GDriveError('Request failed', 'not-found', 404);
		expect(e.message).toBe('Request failed');
		expect(e.code).toBe('not-found');
		expect(e.status).toBe(404);
		expect(e.name).toBe('GDriveError');
	});

	it('works without an HTTP status', () => {
		const e = new GDriveError('Unknown error', 'unknown');
		expect(e.status).toBeUndefined();
	});
});

describe('codeFromStatus', () => {
	it.each([
		[401, 'auth-expired'],
		[403, 'auth-expired'],
		[404, 'not-found'],
		[429, 'quota-exceeded'],
		[500, 'network'],
		[503, 'network'],
		[599, 'network'],
		[400, 'unknown'],
		[422, 'unknown'],
	])('maps HTTP %i → %s', (status, expected) => {
		expect(codeFromStatus(status)).toBe(expected);
	});
});
