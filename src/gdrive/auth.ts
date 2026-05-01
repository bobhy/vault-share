import { App, requestUrl } from 'obsidian';
import { GDriveError } from './errors';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const GOOGLE_CLIENT_ID = '535881224719-5qvscbujq78mpvne1rp3im0cg5cdcu4c.apps.googleusercontent.com';
export const RELAY_BASE_URL = 'https://vault-share-auth.bob-hyman.workers.dev';

const REDIRECT_URI = `${RELAY_BASE_URL}/google/callback`;

const SECRET_REFRESH_TOKEN = 'vault-share-googledrive-refresh-token';
const SECRET_ACCESS_TOKEN = 'vault-share-googledrive-access-token';
const SECRET_TOKEN_EXPIRY = 'vault-share-googledrive-token-expiry';

/** Millis before expiry at which the plugin proactively refreshes the access token. */
const PROACTIVE_REFRESH_MS = 60_000;
/** Cooldown after a failed refresh before retrying, to avoid hammering the relay. */
const AUTH_FAILED_COOLDOWN_MS = 60_000;

interface TokenRefreshResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
}

function assertTokenRefreshResponse(v: unknown): asserts v is TokenRefreshResponse {
	if (
		typeof v !== 'object' || v === null ||
		typeof (v as Record<string, unknown>).access_token !== 'string' ||
		typeof (v as Record<string, unknown>).expires_in !== 'number'
	) {
		throw new GDriveError('Unexpected token refresh response shape', 'auth-expired');
	}
}

/**
 * Manages OAuth 2.0 authentication for Google Drive via the vault-share relay.
 * Tokens are persisted in Obsidian's SecretStorage (OS keychain on desktop).
 */
export class GDriveAuth {
	private accessToken = '';
	private accessTokenExpiry = 0; // ms timestamp
	private refreshToken = '';
	private authState: string | null = null;
	private refreshPromise: Promise<string> | null = null;
	private authFailedAt = 0;

	constructor(private readonly app: App) {}

	get isAuthenticated(): boolean {
		return this.refreshToken.length > 0;
	}

	/** Load persisted tokens from SecretStorage into memory. Called at plugin load. */
	loadFromSecretStorage(): void {
		this.refreshToken = this.app.secretStorage.getSecret(SECRET_REFRESH_TOKEN) ?? '';
		this.accessToken = this.app.secretStorage.getSecret(SECRET_ACCESS_TOKEN) ?? '';
		const expiryStr = this.app.secretStorage.getSecret(SECRET_TOKEN_EXPIRY);
		this.accessTokenExpiry = expiryStr ? parseInt(expiryStr, 10) : 0;
	}

	/** Persist in-memory tokens to SecretStorage. Called after auth callback and refresh. */
	saveToSecretStorage(): void {
		this.app.secretStorage.setSecret(SECRET_REFRESH_TOKEN, this.refreshToken);
		this.app.secretStorage.setSecret(SECRET_ACCESS_TOKEN, this.accessToken);
		this.app.secretStorage.setSecret(SECRET_TOKEN_EXPIRY, String(this.accessTokenExpiry));
	}

	/** Clear all stored tokens from SecretStorage and memory. Called on disconnect. */
	clearSecretStorage(): void {
		this.refreshToken = '';
		this.accessToken = '';
		this.accessTokenExpiry = 0;
		this.authFailedAt = 0;
		this.app.secretStorage.setSecret(SECRET_REFRESH_TOKEN, '');
		this.app.secretStorage.setSecret(SECRET_ACCESS_TOKEN, '');
		this.app.secretStorage.setSecret(SECRET_TOKEN_EXPIRY, '');
	}

	/**
	 * Build the Google authorization URL and store the generated state for later
	 * verification. Open the returned URL in the system browser to begin the flow.
	 */
	getAuthorizationUrl(): string {
		const nonce = generateRandomString(32);
		this.authState = btoa(JSON.stringify({ app: 'vault-share', nonce }));

		const params = new URLSearchParams({
			client_id: GOOGLE_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: 'code',
			scope: SCOPE,
			access_type: 'offline',
			prompt: 'consent',
			state: this.authState,
		});
		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	/**
	 * Handle the obsidian://vault-share-auth callback.
	 * Verifies the echoed state matches what was generated, then stores tokens.
	 * Callers must call saveToSecretStorage() after this succeeds.
	 */
	async handleAuthCallback(params: Record<string, string | undefined>): Promise<void> {
		if (!this.authState) {
			throw new GDriveError('No pending auth flow. Start by clicking Connect.', 'unknown');
		}
		if (!params.state || params.state !== this.authState) {
			throw new GDriveError('State mismatch — possible CSRF. Please try connecting again.', 'unknown');
		}
		this.authState = null;

		if (!params.access_token) {
			throw new GDriveError('Access token missing from auth callback.', 'auth-expired');
		}

		const expiresIn = parseInt(params.expires_in ?? '3600', 10);
		if (isNaN(expiresIn) || expiresIn <= 0) {
			throw new GDriveError('Invalid expires_in in auth callback.', 'auth-expired');
		}

		this.accessToken = params.access_token;
		this.accessTokenExpiry = Date.now() + expiresIn * 1000;
		if (params.refresh_token) {
			this.refreshToken = params.refresh_token;
		}
		this.authFailedAt = 0;
	}

	/**
	 * Return a valid access token, refreshing proactively if within the expiry window.
	 * Deduplicates concurrent refresh calls.
	 */
	async getAccessToken(): Promise<string> {
		if (!this.refreshToken) {
			throw new GDriveError('Not authenticated. Connect to Google Drive in settings.', 'auth-expired');
		}
		if (this.authFailedAt > 0 && Date.now() - this.authFailedAt < AUTH_FAILED_COOLDOWN_MS) {
			throw new GDriveError('Authentication failed. Reconnect in settings.', 'auth-expired');
		}
		if (this.accessToken && Date.now() < this.accessTokenExpiry - PROACTIVE_REFRESH_MS) {
			return this.accessToken;
		}

		// Deduplicate concurrent refresh calls.
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.performRefresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private async performRefresh(): Promise<string> {
		try {
			const response = await requestUrl({
				url: `${RELAY_BASE_URL}/google/token/refresh`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: this.refreshToken }),
				throw: false,
			});

			if (response.status >= 400) {
				const code = response.status === 401 || response.status === 400 ? 'auth-expired' : 'network';
				if (code === 'auth-expired') this.authFailedAt = Date.now();
				throw new GDriveError(`Token refresh failed (${response.status})`, code, response.status);
			}

			const json: unknown = response.json;
			assertTokenRefreshResponse(json);
			this.accessToken = json.access_token;
			this.accessTokenExpiry = Date.now() + json.expires_in * 1000;
			if (json.refresh_token) {
				this.refreshToken = json.refresh_token;
			}
			this.saveToSecretStorage();
			return this.accessToken;
		} catch (err) {
			if (err instanceof GDriveError) throw err;
			throw new GDriveError(`Token refresh network error: ${String(err)}`, 'network');
		}
	}

	/**
	 * Revoke the stored token at Google's revocation endpoint (best-effort).
	 * Always clears local state even if the network call fails.
	 */
	async revokeToken(): Promise<void> {
		const token = this.refreshToken || this.accessToken;
		if (token) {
			try {
				await requestUrl({
					url: `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`,
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					throw: false,
				});
			} catch {
				// Non-fatal: local state is cleared regardless.
			}
		}
		this.clearSecretStorage();
	}
}

const RANDOM_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateRandomString(length: number): string {
	const limit = 256 - (256 % RANDOM_CHARSET.length);
	const result: string[] = [];
	while (result.length < length) {
		const array = new Uint8Array(length - result.length);
		crypto.getRandomValues(array);
		for (const b of array) {
			if (b < limit && result.length < length) {
				result.push(RANDOM_CHARSET[b % RANDOM_CHARSET.length]!);
			}
		}
	}
	return result.join('');
}
