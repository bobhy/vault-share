/**
 * Drive API throttling → backoff recovery (end-to-end).
 *
 * Proves the production retry/backoff in `GDriveApi` actually recovers a real
 * operation when Drive throttles, exercising the *built* plugin's code path —
 * not a unit mock.
 *
 * Genuinely provoking Drive's rate limiter on demand is non-deterministic, so
 * instead we inject the exact response Drive sends when throttling (`429` with
 * a `Retry-After` header) at the plugin's single network seam: `GDriveApi`'s
 * private `httpRequest`. (Obsidian freezes the `requestUrl` module export, so it
 * cannot be stubbed directly — `httpRequest` exists precisely as the one
 * overridable round-trip point.) The injected `429`s are returned for the first
 * N Drive requests; the production `requestWithRetry` loop must back off and
 * retry, and the retry falls through to the *real* `httpRequest` → real Drive,
 * so the operation succeeds.
 *
 * If backoff were absent, the first `429` would throw and `listChildren` would
 * reject — the assertions below would fail.
 */

interface ThrottleProbe {
	ok: boolean;
	throttledInjected: number;
	driveCallsObserved: number;
	error?: string;
}

describe("Drive API throttling backoff (e2e)", () => {
	it("recovers a real listChildren after injected 429 throttling", async () => {
		const probe = await browser.executeObsidian(async ({ app }) => {
			type RequestUrlOptions = { url?: string };
			type RequestUrlResponse = {
				status: number; json: unknown; text: string; arrayBuffer: ArrayBuffer; headers: Record<string, string>;
			};
			type HttpRequest = (opts: RequestUrlOptions) => Promise<RequestUrlResponse>;
			type Plugin = {
				driveFolderId: string;
				api: { listChildren: (folderId: string) => Promise<unknown[]>; httpRequest: HttpRequest };
			};

			const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } })
				.plugins.plugins["vault-share"];
			if (!plugin) throw new Error("vault-share plugin not loaded");

			// Override the live api's single network seam to inject throttling.
			const api = plugin.api as unknown as { httpRequest: HttpRequest };
			const original = api.httpRequest.bind(plugin.api);

			const INJECT = 2; // throttle the first 2 Drive requests, then let them through
			let throttledInjected = 0;
			let driveCallsObserved = 0;

			api.httpRequest = (opts: RequestUrlOptions): Promise<RequestUrlResponse> => {
				const url = typeof opts.url === "string" ? opts.url : "";
				if (url.includes("googleapis.com/drive")) {
					driveCallsObserved++;
					if (throttledInjected < INJECT) {
						throttledInjected++;
						// Mimic Drive's throttle response: 429 + Retry-After.
						return Promise.resolve({
							status: 429, json: {}, text: "", arrayBuffer: new ArrayBuffer(0),
							headers: { "Retry-After": "0" },
						});
					}
				}
				return original(opts);
			};

			try {
				const files = await plugin.api.listChildren(plugin.driveFolderId);
				return { ok: Array.isArray(files), throttledInjected, driveCallsObserved } as ThrottleProbe;
			} catch (e) {
				return {
					ok: false, throttledInjected, driveCallsObserved,
					error: e instanceof Error ? e.message : String(e),
				} as ThrottleProbe;
			} finally {
				api.httpRequest = original;
			}
		}) as unknown as ThrottleProbe;

		// The operation succeeded despite the throttling…
		expect(probe.error).toBeUndefined();
		expect(probe.ok).toBe(true);
		// …because both injected 429s were consumed…
		expect(probe.throttledInjected).toBe(2);
		// …and the request layer retried past them to a real, successful call.
		expect(probe.driveCallsObserved).toBeGreaterThanOrEqual(3);
	});
});
