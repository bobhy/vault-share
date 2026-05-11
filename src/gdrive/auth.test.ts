import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from 'obsidian';
import { GDriveAuth } from './auth';
import { GDriveError } from './errors';
import { spyRequestUrl, makeMockResponse } from './test-helpers';

function makeAuth() {
	const app = new App();
	return { auth: new GDriveAuth(app), app };
}

describe('GDriveAuth', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('getAuthorizationUrl', () => {
		it('returns a Google auth URL containing client_id and state', () => {
			const { auth } = makeAuth();
			const url = auth.getAuthorizationUrl();
			expect(url).toContain('accounts.google.com');
			expect(url).toContain('client_id=');
			expect(url).toContain('state=');
			expect(url).toContain('drive.file');
		});

		it('generates a different state on each call', () => {
			const { auth } = makeAuth();
			const url1 = auth.getAuthorizationUrl();
			const url2 = auth.getAuthorizationUrl();
			const state1 = new URL(url1).searchParams.get('state');
			const state2 = new URL(url2).searchParams.get('state');
			expect(state1).not.toBe(state2);
		});
	});

	describe('handleAuthCallback', () => {
		it('stores tokens when state matches', async () => {
			const { auth } = makeAuth();
			const url = auth.getAuthorizationUrl();
			const state = new URL(url).searchParams.get('state')!;

			await auth.handleAuthCallback({
				state,
				access_token: 'acc123',
				refresh_token: 'ref456',
				expires_in: '3600',
			});

			expect(auth.isAuthenticated).toBe(true);
		});

		it('throws GDriveError when state does not match', async () => {
			const { auth } = makeAuth();
			auth.getAuthorizationUrl(); // sets authState

			await expect(auth.handleAuthCallback({
				state: 'wrong-state',
				access_token: 'acc',
				expires_in: '3600',
			})).rejects.toBeInstanceOf(GDriveError);
		});

		it('throws when no auth flow was started', async () => {
			const { auth } = makeAuth();
			await expect(auth.handleAuthCallback({ state: 'x', access_token: 'y', expires_in: '3600' }))
				.rejects.toBeInstanceOf(GDriveError);
		});

		it('throws when access_token is missing', async () => {
			const { auth } = makeAuth();
			const url = auth.getAuthorizationUrl();
			const state = new URL(url).searchParams.get('state')!;
			await expect(auth.handleAuthCallback({ state })).rejects.toBeInstanceOf(GDriveError);
		});
	});

	describe('getAccessToken', () => {
		it('throws when not authenticated', async () => {
			const { auth } = makeAuth();
			await expect(auth.getAccessToken()).rejects.toBeInstanceOf(GDriveError);
		});

		it('returns cached token when not near expiry', async () => {
			const { auth } = makeAuth();
			const url = auth.getAuthorizationUrl();
			const state = new URL(url).searchParams.get('state')!;
			await auth.handleAuthCallback({
				state,
				access_token: 'cached-token',
				refresh_token: 'ref',
				expires_in: '3600',
			});

			const spy = spyRequestUrl();
			const token = await auth.getAccessToken();
			expect(token).toBe('cached-token');
			expect(spy).not.toHaveBeenCalled();
		});

		it('proactively refreshes when token is within 60s of expiry', async () => {
			const { auth } = makeAuth();
			// Manually set a token that expires in 30s (within the 60s window).
			const internal = auth as unknown as {
				accessToken: string;
				accessTokenExpiry: number;
				refreshToken: string;
			};
			internal.accessToken = 'old-token';
			internal.accessTokenExpiry = Date.now() + 30_000;
			internal.refreshToken = 'ref';

			const spy = spyRequestUrl().mockResolvedValue(
				makeMockResponse({ json: { access_token: 'new-token', expires_in: 3600 } }),
			);

			const token = await auth.getAccessToken();
			expect(spy).toHaveBeenCalledOnce();
			expect(token).toBe('new-token');
		});

		it('deduplicates concurrent refresh calls', async () => {
			const { auth } = makeAuth();
			const internal = auth as unknown as {
				accessToken: string;
				accessTokenExpiry: number;
				refreshToken: string;
			};
			internal.accessToken = 'old';
			internal.accessTokenExpiry = Date.now() + 30_000;
			internal.refreshToken = 'ref';

			const spy = spyRequestUrl().mockResolvedValue(
				makeMockResponse({ json: { access_token: 'fresh', expires_in: 3600 } }),
			);

			const [t1, t2] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
			expect(spy).toHaveBeenCalledOnce();
			expect(t1).toBe('fresh');
			expect(t2).toBe('fresh');
		});
	});

	describe('revokeToken', () => {
		it('calls the revoke endpoint and clears state', async () => {
			const { auth } = makeAuth();
			const internal = auth as unknown as { refreshToken: string };
			internal.refreshToken = 'to-revoke';

			const spy = spyRequestUrl().mockResolvedValue(makeMockResponse({ status: 200 }));
			await auth.revokeToken();

			expect(spy).toHaveBeenCalledOnce();
			expect(auth.isAuthenticated).toBe(false);
		});

		it('clears state even if revoke network call fails', async () => {
			const { auth } = makeAuth();
			const internal = auth as unknown as { refreshToken: string };
			internal.refreshToken = 'to-revoke';

			spyRequestUrl().mockRejectedValue(new Error('network error'));
			await auth.revokeToken(); // must not throw
			expect(auth.isAuthenticated).toBe(false);
		});
	});

	describe('SecretStorage persistence', () => {
		it('round-trips tokens through SecretStorage', async () => {
			const { auth } = makeAuth();
			const url = auth.getAuthorizationUrl();
			const state = new URL(url).searchParams.get('state')!;
			await auth.handleAuthCallback({
				state,
				access_token: 'acc',
				refresh_token: 'ref',
				expires_in: '3600',
			});
			auth.saveToSecretStorage();

			const auth2 = new GDriveAuth((auth as unknown as { app: App }).app);
			auth2.loadFromSecretStorage();
			expect(auth2.isAuthenticated).toBe(true);
		});

		it('tokens are namespaced per vault — two vaults on the same machine do not share tokens', async () => {
			// Simulate two separate Obsidian vaults ('v3' and 'v4') with their own App
			// instances but sharing the same underlying SecretStorage store (as the OS
			// keychain would do if keys were not namespaced).
			const appV3 = new App();
			const appV4 = new App();

			// Point both apps at the same in-memory SecretStorage so we can prove isolation.
			appV4.secretStorage = appV3.secretStorage;

			appV3.vault.getName = vi.fn().mockReturnValue('v3');
			appV4.vault.getName = vi.fn().mockReturnValue('v4');

			const authV3 = new GDriveAuth(appV3);
			const authV4 = new GDriveAuth(appV4);

			// v3 authenticates and saves tokens.
			const urlV3 = authV3.getAuthorizationUrl();
			const stateV3 = new URL(urlV3).searchParams.get('state')!;
			await authV3.handleAuthCallback({ state: stateV3, access_token: 'acc-v3', refresh_token: 'ref-v3', expires_in: '3600' });
			authV3.saveToSecretStorage();

			// v4 authenticates independently and saves its own tokens.
			const urlV4 = authV4.getAuthorizationUrl();
			const stateV4 = new URL(urlV4).searchParams.get('state')!;
			await authV4.handleAuthCallback({ state: stateV4, access_token: 'acc-v4', refresh_token: 'ref-v4', expires_in: '3600' });
			authV4.saveToSecretStorage();

			// Reload v3 from storage — its tokens must be unaffected by v4's save.
			const authV3Reload = new GDriveAuth(appV3);
			authV3Reload.loadFromSecretStorage();
			const internalV3 = authV3Reload as unknown as { refreshToken: string; accessToken: string };
			expect(internalV3.refreshToken).toBe('ref-v3');
			expect(internalV3.accessToken).toBe('acc-v3');

			// Reload v4 from storage — it has its own tokens.
			const authV4Reload = new GDriveAuth(appV4);
			authV4Reload.loadFromSecretStorage();
			const internalV4 = authV4Reload as unknown as { refreshToken: string; accessToken: string };
			expect(internalV4.refreshToken).toBe('ref-v4');
			expect(internalV4.accessToken).toBe('acc-v4');
		});
	});
});
