import type { GDriveApi, DriveFile } from '../gdrive/api';
import type { FileSide } from './types';
import type { StatsTracker } from './stats-tracker';
import type { Logger } from '../logger';

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
	 *
	 * When multiple Drive files share the same vault-relative path (Google Drive does not
	 * enforce unique names within a folder), only the most-recently-modified entry is
	 * returned; the extras are silently discarded.  The returned `duplicatePathsFound`
	 * count tells callers how many paths had at least one discarded duplicate so they can
	 * warn the user and/or increment a stats counter.
	 *
	 * Run the **Repair Drive duplicates** command ({@link repairDuplicates}) to actually
	 * delete the stale duplicates from Drive.
	 *
	 * TODO: Consider automating Drive duplicate cleanup — e.g. deleting the older
	 * duplicate in the background during each listAll pass — so users don't need to
	 * run an explicit repair command.  Needs rate-limit handling and a confirmation /
	 * logging strategy before enabling.
	 */
	async listAll(rootFolderId: string): Promise<{ files: DriveFileSide[]; duplicatePathsFound: number }> {
		const raw: DriveFileSide[] = [];
		await this.walkFolder(rootFolderId, '', raw);

		// Deduplicate by path, keeping the entry with the highest mtime.
		// listChildren is ordered modifiedTime desc, so `existing` is typically already
		// the newest, but we compare explicitly to guard against ordering inconsistencies.
		const byPath = new Map<string, DriveFileSide>();
		const pathsWithDuplicates = new Set<string>();
		for (const file of raw) {
			const existing = byPath.get(file.path);
			if (!existing) {
				byPath.set(file.path, file);
			} else {
				pathsWithDuplicates.add(file.path);
				if (file.mtime > existing.mtime) {
					byPath.set(file.path, file);
				}
			}
		}

		return { files: Array.from(byPath.values()), duplicatePathsFound: pathsWithDuplicates.size };
	}

	/**
	 * Scan Drive for duplicate files (multiple Drive objects sharing the same
	 * vault-relative path) and delete all but the most-recently-modified copy.
	 *
	 * Returns a summary of how many paths had duplicates and how many files were deleted.
	 * Call {@link StatsTracker.resetDuplicateCounter} after a successful run.
	 */
	async repairDuplicates(
		rootFolderId: string,
		logger: Logger,
	): Promise<{ pathsWithDuplicates: number; filesDeleted: number }> {
		const raw: DriveFileSide[] = [];
		await this.walkFolder(rootFolderId, '', raw);

		// Group all Drive files by vault-relative path.
		const byPath = new Map<string, DriveFileSide[]>();
		for (const file of raw) {
			const group = byPath.get(file.path) ?? [];
			group.push(file);
			byPath.set(file.path, group);
		}

		let pathsWithDuplicates = 0;
		let filesDeleted = 0;

		for (const [path, group] of byPath) {
			if (group.length <= 1) continue;

			// Sort newest first; keep [0], delete [1..n].
			group.sort((a, b) => b.mtime - a.mtime);
			pathsWithDuplicates++;

			for (const stale of group.slice(1)) {
				logger.info(`Drive repair: deleting duplicate ${path} (id=${stale.driveFileId}, mtime=${stale.mtime})`);
				await this.api.deleteFile(stale.driveFileId);
				filesDeleted++;
			}
		}

		return { pathsWithDuplicates, filesDeleted };
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
		// Google Docs / Sheets / Slides have no byte size; treat as 0.
		size: file.size ? Number(file.size) : 0,
	};
}
