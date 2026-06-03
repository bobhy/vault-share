/**
 * Thin TypeScript wrapper over the Google Drive v3 REST API.
 *
 * Limited to the operations this plugin actually performs (list, read, write,
 * delete, find, resolve folder). Every request goes through {@link GDriveAuth}
 * for token acquisition and converts non-2xx responses into typed
 * {@link GDriveError} instances so callers can branch on `code` rather than
 * HTTP status. The wrapper handles the multipart upload protocol so callers
 * can pass plain strings or Uint8Arrays as content.
 * 
 * @packageDocumentation
 */
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { GDriveAuth } from './auth';
import { GDriveError, codeFromStatus } from './errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Tunable retry/backoff policy for transient Drive failures.
 *
 * Drive throttles bursty clients with `429` and rate-limit `403`s, and
 * occasionally returns `5xx`s under load. Without backoff a large-vault sync
 * (100s of files) would see `listChildren` abort the whole pass, or pushes /
 * deletes fail every pass and never converge. The wrapper retries transient
 * failures with exponential backoff + jitter, honouring a `Retry-After` header
 * when present, so operation is reliable (if slower) at scale.
 */
export interface RetryOptions {
	/** Total attempts including the first try. */
	maxAttempts: number;
	/** First backoff delay in ms; doubles each retry. */
	baseDelayMs: number;
	/** Upper bound on any single backoff delay in ms. */
	maxDelayMs: number;
}

/** Production retry policy: ~0.5s, 1s, 2s, 4s, 8s between 6 attempts, capped at 30s. */
export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 30_000 };

/** HTTP statuses that are always safe to retry (transient throttling / server faults). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Subset of the Google Drive v3 file resource the plugin reads. */
export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	/** Decimal string of byte count for binary files. Omitted by Drive for Google-native docs (Doc/Sheet/Slide). */
	size?: string;
	/**
	 * SHA-256 hex digest of the file's content, computed by Drive.
	 * Available for all binary files uploaded after August 2022.
	 * Absent for Google-native docs (Docs/Sheets/Slides) and occasionally for
	 * older files awaiting lazy population. Never an error — treat absence as
	 * "hash unavailable, fall back to mtime/size comparison."
	 */
	sha256Checksum?: string;
}

/** Page of Drive metadata as returned by the v3 files.list endpoint. */
interface DriveFileList {
	files: DriveFile[];
	nextPageToken?: string;
}

function assertDriveFile(v: unknown): asserts v is DriveFile {
	const o = v as Record<string, unknown>;
	if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.mimeType !== 'string') {
		throw new GDriveError('Unexpected Drive file shape', 'unknown');
	}
}

function assertDriveFileList(v: unknown): asserts v is DriveFileList {
	const o = v as Record<string, unknown>;
	if (!Array.isArray(o.files)) {
		throw new GDriveError('Unexpected Drive file list shape', 'unknown');
	}
}

/**
 * Thin wrapper around the Google Drive v3 REST API.
 * All methods obtain a fresh access token via GDriveAuth before each request.
 */
export class GDriveApi {
	constructor(
		private readonly auth: GDriveAuth,
		private readonly retry: RetryOptions = DEFAULT_RETRY,
	) {}

	/**
	 * Issue a Drive request with retry/backoff for transient failures.
	 *
	 * All HTTP methods route through here. Always sets `throw: false` so HTTP
	 * error *statuses* are inspected (not thrown) — a retryable status (`429`,
	 * `5xx`, or a rate-limit `403`) triggers an exponential backoff and another
	 * attempt; any other status is returned for the caller's `throwOnError` to
	 * surface as before. Genuine transport failures (the request promise itself
	 * rejecting — DNS, timeout, connection reset) are also retried. When retries
	 * are exhausted the last response (or transport error) is returned/rethrown,
	 * so behaviour degrades to the pre-retry contract rather than masking faults.
	 *
	 * A `Retry-After` response header, when present, overrides the computed
	 * backoff (Drive sends it on some throttle responses).
	 */
	private async requestWithRetry(options: RequestUrlParam): Promise<RequestUrlResponse> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
			let response: RequestUrlResponse | null = null;
			try {
				response = await this.httpRequest(options);
			} catch (err) {
				// Transport-level failure (no HTTP response at all). Retry it.
				lastError = err;
			}

			if (response) {
				if (!isRetryableResponse(response)) return response;
				lastError = new GDriveError(
					`Drive API transient error (${response.status})`,
					codeFromStatus(response.status),
					response.status,
				);
				// Exhausted: hand the response back so throwOnError surfaces the status.
				if (attempt >= this.retry.maxAttempts) return response;
				await sleep(backoffMs(this.retry, attempt, response));
			} else {
				if (attempt >= this.retry.maxAttempts) break;
				await sleep(backoffMs(this.retry, attempt, null));
			}
		}
		throw lastError instanceof Error
			? lastError
			: new GDriveError('Drive request failed after retries', 'network');
	}

	/**
	 * Perform the actual HTTP round-trip. Always non-throwing (`throw: false`) so
	 * {@link requestWithRetry} can inspect error statuses rather than catch them.
	 *
	 * Isolated as the single network seam: retry/backoff wraps exactly this call,
	 * and resilience tests can override it on a live instance to inject transient
	 * faults (Obsidian freezes the `requestUrl` export, so it cannot be stubbed
	 * directly).
	 */
	private httpRequest(options: RequestUrlParam): Promise<RequestUrlResponse> {
		return requestUrl({ ...options, throw: false });
	}

	/** List files (and folders) that are direct children of parentId, handling pagination. */
	async listChildren(parentId: string): Promise<DriveFile[]> {
		const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
		const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,size,sha256Checksum)');
		const order = encodeURIComponent('modifiedTime desc');
		const base = `${DRIVE_API}/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=${order}`;

		const all: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			const token = await this.auth.getAccessToken();
			const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
			const response = await this.requestWithRetry({
				url,
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});
			this.throwOnError(response.status);
			const json: unknown = response.json;
			assertDriveFileList(json);
			all.push(...json.files);
			pageToken = json.nextPageToken;
		} while (pageToken);

		return all;
	}

	/** Return a single file's metadata. */
	async getFile(fileId: string): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const fields = encodeURIComponent('id,name,mimeType,modifiedTime,size,sha256Checksum');
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files/${fileId}?fields=${fields}`,
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		this.throwOnError(response.status);
		const json: unknown = response.json;
		assertDriveFile(json);
		return json;
	}

	/**
	 * Read the custom `appProperties` map attached to a file or folder.
	 * Returns an empty object when none are set. Used to read the Drive-folder
	 * schema version (see `specs/upgrade-path.md`).
	 */
	async getAppProperties(fileId: string): Promise<Record<string, string>> {
		const token = await this.auth.getAccessToken();
		const fields = encodeURIComponent('appProperties');
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files/${fileId}?fields=${fields}`,
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		this.throwOnError(response.status);
		const json = response.json as { appProperties?: Record<string, string> } | null;
		return json?.appProperties ?? {};
	}

	/**
	 * Merge the given keys into a file or folder's `appProperties`.
	 * Drive merges these into any existing properties (setting a value to an
	 * empty string does not delete the key — pass `null` via the REST API for
	 * that, which this plugin does not need). Used to stamp the Drive-folder
	 * schema version (see `specs/upgrade-path.md`).
	 */
	async setAppProperties(fileId: string, props: Record<string, string>): Promise<void> {
		const token = await this.auth.getAccessToken();
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files/${fileId}?fields=id`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ appProperties: props }),
			throw: false,
		});
		this.throwOnError(response.status);
	}

	/** Read a file's raw content. Returns string for text, Uint8Array for binary. */
	async readFile(fileId: string): Promise<string> {
		const token = await this.auth.getAccessToken();
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files/${fileId}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		this.throwOnError(response.status);
		return response.text;
	}

	/** Read a file's raw content as binary. */
	async readFileBinary(fileId: string): Promise<Uint8Array> {
		const token = await this.auth.getAccessToken();
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files/${fileId}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		this.throwOnError(response.status);
		return new Uint8Array(response.arrayBuffer);
	}

	/**
	 * Create or overwrite a file in parentFolderId.
	 * If a file with name already exists in that folder, it is overwritten.
	 */
	async writeFile(parentFolderId: string, name: string, content: string | Uint8Array): Promise<DriveFile> {
		const existing = await this.findFile(parentFolderId, name);
		const mimeType = typeof content === 'string' ? 'text/plain' : 'application/octet-stream';

		if (existing) {
			return this.updateFileContent(existing.id, content, mimeType);
		}
		return this.createFileWithContent(parentFolderId, name, content, mimeType);
	}

	/** Delete a file or folder by ID. */
	async deleteFile(fileId: string): Promise<void> {
		const token = await this.auth.getAccessToken();
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files/${fileId}`,
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		if (response.status !== 204 && response.status !== 200) {
			this.throwOnError(response.status);
		}
	}

	/** Create a folder under parentId. */
	async createFolder(parentId: string, name: string): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
			throw: false,
		});
		this.throwOnError(response.status);
		const json: unknown = response.json;
		assertDriveFile(json);
		return json;
	}

	/**
	 * Resolve a slash-separated path to a Drive folder ID, creating any missing
	 * segments. Path must begin with a separator; root is the user's My Drive.
	 * Example: '/vault-share/shared' → Drive file ID of 'shared'.
	 */
	async resolveFolder(path: string): Promise<string> {
		const segments = path.split(/[/\\]/).filter(s => s.length > 0);
		if (segments.length === 0) return 'root';

		let parentId = 'root';
		for (const name of segments) {
			const existing = await this.findFolder(parentId, name);
			parentId = existing ? existing.id : (await this.createFolder(parentId, name)).id;
		}
		return parentId;
	}

	/** Find a folder by name under parentId. Returns null if not found. */
	async findFolder(parentId: string, name: string): Promise<DriveFile | null> {
		return this.findChild(parentId, name, FOLDER_MIME);
	}

	/** Find a non-folder file by name under parentId. Returns null if not found. */
	async findFile(parentId: string, name: string): Promise<DriveFile | null> {
		return this.findChild(parentId, name, null);
	}

	private async findChild(parentId: string, name: string, mimeType: string | null): Promise<DriveFile | null> {
		const token = await this.auth.getAccessToken();
		const mimeClause = mimeType ? ` and mimeType='${mimeType}'` : ` and mimeType!='${FOLDER_MIME}'`;
		const q = encodeURIComponent(
			`'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}'${mimeClause} and trashed=false`,
		);
		const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,size,sha256Checksum)');
		const order = encodeURIComponent('modifiedTime desc');
		const response = await this.requestWithRetry({
			url: `${DRIVE_API}/files?q=${q}&fields=${fields}&pageSize=2&orderBy=${order}`,
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		this.throwOnError(response.status);
		const json: unknown = response.json;
		assertDriveFileList(json);
		return json.files[0] ?? null;
	}

	private async createFileWithContent(
		parentId: string,
		name: string,
		content: string | Uint8Array,
		mimeType: string,
	): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const { body, boundary } = buildMultipartBody({ name, parents: [parentId] }, content, mimeType);
		const response = await this.requestWithRetry({
			url: `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,sha256Checksum`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': `multipart/related; boundary=${boundary}`,
			},
			body: body.buffer as ArrayBuffer,
			throw: false,
		});
		this.throwOnError(response.status);
		const json: unknown = response.json;
		assertDriveFile(json);
		return json;
	}

	private async updateFileContent(
		fileId: string,
		content: string | Uint8Array,
		mimeType: string,
	): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const { body, boundary } = buildMultipartBody({}, content, mimeType);
		const response = await this.requestWithRetry({
			url: `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': `multipart/related; boundary=${boundary}`,
			},
			body: body.buffer as ArrayBuffer,
			throw: false,
		});
		this.throwOnError(response.status);
		const json: unknown = response.json;
		assertDriveFile(json);
		return json;
	}

	private throwOnError(status: number): void {
		if (status >= 200 && status < 300) return;
		// A 401 means the access token is invalid despite appearing locally valid.
		// Clear the cached token so the next getAccessToken() forces a refresh
		// rather than reusing the same stale token on every subsequent request.
		if (status === 401) this.auth.invalidateAccessToken();
		throw new GDriveError(`Drive API error (${status})`, codeFromStatus(status), status);
	}
}

/** Resolve after `ms` milliseconds. Uses `activeWindow.setTimeout` for popout-window compatibility (no Node timers). */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => activeWindow.setTimeout(resolve, ms));
}

/** True when an HTTP response should be retried: transient status, or a rate-limit `403`. */
function isRetryableResponse(r: RequestUrlResponse): boolean {
	if (RETRYABLE_STATUS.has(r.status)) return true;
	if (r.status === 403) return is403RateLimit(r);
	return false;
}

/**
 * Distinguish a *throttling* `403` (retryable) from an *authorization* `403`
 * (not retryable) by inspecting the Drive error body's reason codes.
 */
function is403RateLimit(r: RequestUrlResponse): boolean {
	let body: unknown;
	try {
		body = r.json;
	} catch {
		// Non-JSON body — cannot confirm a rate-limit reason; treat as non-retryable.
		return false;
	}
	return extractErrorReasons(body).some(
		reason => reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded',
	);
}

/** Pull `error.errors[].reason` strings out of a Drive error JSON body. */
function extractErrorReasons(body: unknown): string[] {
	const errs = (body as { error?: { errors?: Array<{ reason?: unknown }> } } | null | undefined)
		?.error?.errors;
	if (!Array.isArray(errs)) return [];
	return errs
		.map(e => (typeof e.reason === 'string' ? e.reason : ''))
		.filter(reason => reason.length > 0);
}

/** Backoff delay for the given attempt: `Retry-After` header if present, else exponential + jitter, capped. */
function backoffMs(retry: RetryOptions, attempt: number, response: RequestUrlResponse | null): number {
	const retryAfter = response ? parseRetryAfter(response.headers) : null;
	if (retryAfter !== null) return Math.min(retryAfter, retry.maxDelayMs);
	const exp = retry.baseDelayMs * 2 ** (attempt - 1);
	const jitter = Math.random() * retry.baseDelayMs;
	return Math.min(exp + jitter, retry.maxDelayMs);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or null if absent/unparseable. */
function parseRetryAfter(headers: Record<string, string>): number | null {
	let raw: string | undefined;
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === 'retry-after') { raw = headers[key]; break; }
	}
	if (!raw) return null;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const when = Date.parse(raw);
	if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
	return null;
}

/** Build a multipart/related body safe for both text and binary content. */
function buildMultipartBody(
	metadata: Record<string, unknown>,
	content: string | Uint8Array,
	mimeType: string,
): { body: Uint8Array; boundary: string } {
	const boundary = `DriveUpload${Date.now()}`;
	const enc = new TextEncoder();

	const metaPart = enc.encode(
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
	);
	const contentHeader = enc.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
	const contentBytes = typeof content === 'string' ? enc.encode(content) : content;
	const footer = enc.encode(`\r\n--${boundary}--`);

	const total = metaPart.length + contentHeader.length + contentBytes.length + footer.length;
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of [metaPart, contentHeader, contentBytes, footer]) {
		result.set(part, offset);
		offset += part.length;
	}
	return { body: result, boundary };
}
