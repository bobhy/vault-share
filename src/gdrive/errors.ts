/**
 * Typed error vocabulary for Drive API failures.
 *
 * All HTTP failures from `GDriveApi` surface as {@link GDriveError} with
 * a {@link GDriveErrorCode} discriminant, so callers branch on the meaning of
 * the failure rather than the raw HTTP status.
 *
 * @packageDocumentation
 */

/** Discriminant for {@link GDriveError}; surfaces the failure category. */
export type GDriveErrorCode =
	| 'not-found'
	| 'auth-expired'
	| 'quota-exceeded'
	| 'network'
	| 'unknown';

/** Error thrown by all GDrive operations. Callers must not assume plain Error instances. */
export class GDriveError extends Error {
	constructor(
		message: string,
		public readonly code: GDriveErrorCode,
		public readonly status?: number,
	) {
		super(message);
		this.name = 'GDriveError';
	}
}

/** Narrow an unknown caught value to a GDriveError code from an HTTP status. */
export function codeFromStatus(status: number): GDriveErrorCode {
	if (status === 401 || status === 403) return 'auth-expired';
	if (status === 404) return 'not-found';
	if (status === 429) return 'quota-exceeded';
	if (status >= 500) return 'network';
	return 'unknown';
}
