import type { GDriveApi, DriveFile } from '../gdrive/api';
import type { FileSide } from './types';
import type { StatsTracker } from './stats-tracker';

export interface DriveFileSide extends FileSide {
	driveFileId: string;
}

/**
 * Adapts GDriveApi into the shape the sync engine expects.
 * All paths are vault-relative (forward slashes, no leading slash).
 */
export class DriveFsAdapter {
	constructor(private readonly api: GDriveApi) {}

	/**
	 * Recursively list all files under rootFolderId, mirroring the local vault hierarchy.
	 * Handles Drive API pagination internally.
	 */
	async listAll(rootFolderId: string): Promise<DriveFileSide[]> {
		const results: DriveFileSide[] = [];
		await this.walkFolder(rootFolderId, '', results);
		return results;
	}

	/** Return metadata for one file by vault-relative path, or null if not found. */
	async stat(rootFolderId: string, path: string): Promise<DriveFileSide | null> {
		const segments = path.split('/');
		const fileName = segments.pop()!;
		let parentId = rootFolderId;

		for (const segment of segments) {
			const folder = await this.api.findFolder(parentId, segment);
			if (!folder) return null;
			parentId = folder.id;
		}

		const file = await this.api.findFile(parentId, fileName);
		if (!file) return null;
		return driveFileToSide(path, file);
	}

	/** Read a file's raw bytes. */
	async read(fileId: string): Promise<ArrayBuffer> {
		const text = await this.api.readFile(fileId);
		return toArrayBuffer(new TextEncoder().encode(text));
	}

	/** Read a file's raw binary content. */
	async readBinary(fileId: string): Promise<ArrayBuffer> {
		return toArrayBuffer(await this.api.readFileBinary(fileId));
	}

	/**
	 * Write content to Drive at the given vault-relative path under rootFolderId.
	 * Creates intermediate folder hierarchy as needed.
	 * Samples API response time and records first-write clock skew per pass
	 * via the statsTracker (pass null to skip sampling).
	 */
	async write(
		rootFolderId: string,
		path: string,
		content: ArrayBuffer,
		statsTracker: StatsTracker | null,
		clockSkewSampled: { value: boolean },
	): Promise<DriveFileSide> {
		const segments = path.split('/');
		const fileName = segments.pop()!;
		let parentId = rootFolderId;

		for (const segment of segments) {
			const existing = await this.api.findFolder(parentId, segment);
			parentId = existing ? existing.id : (await this.api.createFolder(parentId, segment)).id;
		}

		const start = Date.now();
		const result = await this.api.writeFile(parentId, fileName, new Uint8Array(content));
		const elapsed = Date.now() - start;

		if (statsTracker) {
			statsTracker.recordAPIResponseTime(elapsed);
			if (!clockSkewSampled.value && result.modifiedTime) {
				const serverMtime = new Date(result.modifiedTime).getTime();
				const skew = Math.abs(serverMtime - start - elapsed / 2);
				statsTracker.recordClockSkew(skew);
				clockSkewSampled.value = true;
			}
		}

		return driveFileToSide(path, result);
	}

	/** Delete a Drive file by ID. */
	async delete(fileId: string): Promise<void> {
		await this.api.deleteFile(fileId);
	}

	private async walkFolder(
		folderId: string,
		prefix: string,
		results: DriveFileSide[],
	): Promise<void> {
		const children = await this.api.listChildren(folderId);
		for (const child of children) {
			const childPath = prefix ? `${prefix}/${child.name}` : child.name;
			if (child.mimeType === 'application/vnd.google-apps.folder') {
				await this.walkFolder(child.id, childPath, results);
			} else {
				results.push(driveFileToSide(childPath, child));
			}
		}
	}
}

/** Copy a Uint8Array into a fresh ArrayBuffer to avoid the ArrayBufferLike vs ArrayBuffer type mismatch. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buf).set(bytes);
	return buf;
}

function driveFileToSide(path: string, file: DriveFile): DriveFileSide {
	return {
		path,
		driveFileId: file.id,
		mtime: file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0,
		size: 0, // Drive API v3 doesn't return size in standard list fields; set to 0
	};
}
