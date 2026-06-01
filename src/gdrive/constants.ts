/**
 * Compile-time constants for the Google OAuth flow.
 *
 * Separated from `GDriveAuth` so the values can be imported by tooling
 * (the setup-wdio-token script, the OAuth relay worker) without dragging in
 * the Obsidian-dependent auth module.
 *
 * @packageDocumentation
 */

/** OAuth 2.0 client ID registered for the vault-share Google Cloud project. */
export const GOOGLE_CLIENT_ID = '535881224719-5qvscbujq78mpvne1rp3im0cg5cdcu4c.apps.googleusercontent.com';

/**
 * Cloudflare Worker that exchanges authorization codes for tokens and proxies
 * the obsidian:// redirect. The plugin never embeds the OAuth client secret.
 */
export const RELAY_BASE_URL = 'https://vault-share-auth.bob-hyman.workers.dev';
