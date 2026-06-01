/**
 * Test-only helpers for stubbing the Drive HTTP layer.
 *
 * Exported separately from production code; excluded from generated TypeDoc.
 * Provides a typed factory for fake responses and a typed spy on Obsidian's
 * `requestUrl` so tests avoid `as any` casts when intercepting Drive traffic.
 *
 * @packageDocumentation
 */
import { vi } from 'vitest';
import * as obsidian from 'obsidian';

/** Shape returned by requestUrl (subset used in tests). */
export interface MockRequestUrlResponse {
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

/** Build a fully-populated {@link MockRequestUrlResponse} with the given overrides. */
export function makeMockResponse(overrides: Partial<MockRequestUrlResponse> = {}): MockRequestUrlResponse {
	return {
		status: 200,
		text: '',
		json: {},
		arrayBuffer: new ArrayBuffer(0),
		headers: {},
		...overrides,
	};
}

type RequestUrlFn = (opts: unknown) => Promise<MockRequestUrlResponse>;

/** Type-safe spy on obsidian's requestUrl for unit tests. */
export function spyRequestUrl() {
	return vi.spyOn(obsidian as unknown as { requestUrl: RequestUrlFn }, 'requestUrl');
}
