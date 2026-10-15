/**
 * Small helpers for turning thrown values into user- and log-facing text.
 *
 * @packageDocumentation
 */

/**
 * The message of a thrown value: `err.message` for an `Error`, otherwise
 * its string form. For catch clauses, whose binding is typed `unknown`.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
