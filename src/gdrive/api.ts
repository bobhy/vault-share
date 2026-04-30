import { requestUrl } from 'obsidian';
import { GDriveAuth } from './auth';
import { GDriveError, codeFromStatus } from './errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
}

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
	constructor(private readonly auth: GDriveAuth) {}

	/** List files (and folders) that are direct children of parentId. */
	async listChildren(parentId: string): Promise<DriveFile[]> {
		const token = await this.auth.getAccessToken();
		const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
		const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime)');
		const response = await requestUrl({
			url: `${DRIVE_API}/files?q=${q}&fields=${fields}&pageSize=1000`,
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		this.throwOnError(response.status);
		const json: unknown = response.json;
		assertDriveFileList(json);
		return json.files;
	}

	/** Return a single file's metadata. */
	async getFile(fileId: string): Promise<DriveFile> {
		const token = await this.auth.getAccessToken();
		const fields = encodeURIComponent('id,name,mimeType,modifiedTime');
		const response = await requestUrl({
			url: `${DRIVE_API}/files/${fileId}?fields=${fields}`,
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		this.throwOnError(response.status);
		const json: unknown = response.json;
		assertDriveFile(json);
		return json;
	}

	/** Read a file's raw content. Returns string for text, Uint8Array for binary. */
	async readFile(fileId: string): Promise<string> {
		const token = await this.auth.getAccessToken();
		const response = await requestUrl({
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
		const response = await requestUrl({
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
		const response = await requestUrl({
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
		const response = await requestUrl({
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
		const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime)');
		const response = await requestUrl({
			url: `${DRIVE_API}/files?q=${q}&fields=${fields}&pageSize=2`,
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
		const response = await requestUrl({
			url: `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime`,
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
		const response = await requestUrl({
			url: `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime`,
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
		throw new GDriveError(`Drive API error (${status})`, codeFromStatus(status), status);
	}
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
