import { describe, it, expect } from 'vitest';
import { errorMessage } from './errors';

describe('errorMessage', () => {
	it.each([
		{ name: 'Error uses its message', err: new Error('boom'), expected: 'boom' },
		{ name: 'string is returned as-is', err: 'plain', expected: 'plain' },
		{ name: 'other values are stringified', err: 42, expected: '42' },
	])('$name', ({ err, expected }) => {
		expect(errorMessage(err)).toBe(expected);
	});
});
