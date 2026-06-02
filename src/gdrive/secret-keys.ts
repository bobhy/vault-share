/**
 * Derives the SecretStorage key names for a given vault.
 *
 * Keys are vault-name-scoped so multiple Obsidian instances on the same machine
 * never overwrite each other's tokens. IDs must be lowercase alphanumeric with
 * dashes only, so the vault name is sanitized before embedding it.
 *
 * Exported separately from auth.ts so test tooling (setup-wdio-token.ts,
 * wdio.conf.mts) can derive the correct key names without importing the
 * Obsidian-dependent auth module.
 *
 * Versioning: these three flat string keys are stable enough not to carry a
 * dedicated schema version. If the key-naming scheme or token shape ever
 * changes, handle the re-mint/rename as a step in the settings migration ladder
 * (gated on `schemaVersion`) rather than introducing a separate token version.
 * See `specs/upgrade-path.md`.
 *
 * @packageDocumentation
 */
export function secretKeys(vaultName: string) {
	const safe = vaultName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
	return {
		refreshToken: `vault-share-${safe}-refresh-token`,
		accessToken:  `vault-share-${safe}-access-token`,
		tokenExpiry:  `vault-share-${safe}-token-expiry`,
	};
}
