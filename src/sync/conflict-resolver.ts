import type { SyncAction, SyncContext, SyncRecord } from './types';
import type { FileConflictStrategy } from '../settings';
import { isMergeEligible, threeWayMerge } from './merge';
import { shortClientId } from './client-id';

const PLACEHOLDER_TEXT = 'Placeholder for deleted file';

export interface ConflictResult {
	localConflictPath?: string;
	remoteConflictPath?: string;
	merged: boolean;
	hadConflictMarkers: boolean;
}

/**
 * Build a conflict filename: <name>-conflict-<clientId>-<timestamp>.<ext>
 * Timestamp uses hyphens in place of colons so it is valid on all OS file systems.
 */
export function buildConflictFilename(
	originalPath: string,
	clientId: string,
	now: Date,
): string {
	const timestamp = formatTimestampForFilename(now);
	const lastDot = originalPath.lastIndexOf('.');
	const lastSlash = originalPath.lastIndexOf('/');
	const dotInName = lastDot > lastSlash;

	if (dotInName) {
		const base = originalPath.slice(0, lastDot);
		const ext = originalPath.slice(lastDot);
		return `${base}-conflict-${clientId}-${timestamp}${ext}`;
	}
	return `${originalPath}-conflict-${clientId}-${timestamp}`;
}

/** Format a Date as ISO 8601 local time with hyphens replacing colons. */
function formatTimestampForFilename(d: Date): string {
	const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
	);
}

/**
 * Resolve a conflict between local and remote versions of a file.
 * Handles all three strategies: Use Newer, Keep Both, Merge.
 * Also handles modify-delete conflicts by creating a placeholder file.
 */
export async function resolveConflict(
	action: SyncAction,
	strategy: FileConflictStrategy,
	ctx: SyncContext,
): Promise<ConflictResult> {
	const { path, local, remote, record } = action;
	const isDeleteConflict = !local || !remote;

	if (isDeleteConflict) {
		return resolveDeleteConflict(path, action, ctx);
	}

	if (strategy === 'Use Newer') {
		return resolveUseNewer(path, local.mtime, remote.mtime, ctx);
	}

	if (strategy === 'Merge' && isMergeEligible(path)) {
		return resolveMerge(path, record, ctx);
	}

	// Keep Both — also the fallback for Merge on non-eligible files.
	return resolveKeepBoth(path, ctx);
}

/** Use Newer: overwrite the older side with the newer side. */
async function resolveUseNewer(
	path: string,
	localMtime: number,
	remoteMtime: number,
	ctx: SyncContext,
): Promise<ConflictResult> {
	const { localFs, driveFs } = ctx;
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };

	if (localMtime >= remoteMtime) {
		// Local is newer — push to Drive.
		const content = await localFs.read(path);
		await driveFs.write(rootFolderId, path, content, ctx.statsTracker, sampler);
		ctx.statsTracker.recordPush();
	} else {
		// Remote is newer — pull to local.
		const remoteId = (action: SyncAction) => action.remote!.driveFileId;
		const driveFileId = ctx.driveFs === driveFs
			? (await driveFs.stat(rootFolderId, path))?.driveFileId ?? ''
			: '';
		if (driveFileId) {
			const content = await driveFs.readBinary(driveFileId);
			await localFs.write(path, content);
			ctx.statsTracker.recordPull();
		}
		void remoteId; // not needed here
	}

	return { merged: false, hadConflictMarkers: false };
}

/** Keep Both: rename both sides to conflict filenames and propagate. */
async function resolveKeepBoth(
	path: string,
	ctx: SyncContext,
): Promise<ConflictResult> {
	const now = new Date();
	const localConflictPath = buildConflictFilename(path, shortClientId(ctx.clientId), now);
	const remoteConflictPath = buildConflictFilename(path, 'group', now);
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };

	// Read both sides before renaming.
	const [localContent, remoteFileId] = await Promise.all([
		ctx.localFs.read(path),
		Promise.resolve(ctx.driveFs).then(async driveFs => {
			const s = await driveFs.stat(rootFolderId, path);
			return s?.driveFileId ?? null;
		}),
	]);

	let remoteContent: ArrayBuffer | null = null;
	if (remoteFileId) {
		remoteContent = await ctx.driveFs.readBinary(remoteFileId);
	}

	// Rename local copy.
	await ctx.localFs.rename(path, localConflictPath);

	// Write remote copy locally under its conflict name.
	if (remoteContent) {
		await ctx.localFs.write(remoteConflictPath, remoteContent);
	}

	// Push both conflict files to Drive and store sync records so the next pass
	// sees them as already-synced (absent records would re-trigger a conflict loop).
	const syncedAt = Date.now();
	const localDriveSide = await ctx.driveFs.write(rootFolderId, localConflictPath, localContent, ctx.statsTracker, sampler);
	const localLocalSide = ctx.localFs.stat(localConflictPath);
	await ctx.store.putRecord({
		path: localConflictPath,
		driveFileId: localDriveSide.driveFileId,
		localMtime: localLocalSide?.mtime ?? 0,
		remoteMtime: localDriveSide.mtime,
		localSize: localLocalSide?.size ?? 0,
		remoteSize: localDriveSide.size,
		syncedAt,
	});

	if (remoteContent) {
		const remoteDriveSide = await ctx.driveFs.write(rootFolderId, remoteConflictPath, remoteContent, ctx.statsTracker, sampler);
		const remoteLocalSide = ctx.localFs.stat(remoteConflictPath);
		await ctx.store.putRecord({
			path: remoteConflictPath,
			driveFileId: remoteDriveSide.driveFileId,
			localMtime: remoteLocalSide?.mtime ?? 0,
			remoteMtime: remoteDriveSide.mtime,
			localSize: remoteLocalSide?.size ?? 0,
			remoteSize: remoteDriveSide.size,
			syncedAt,
		});
	}

	// Delete the original from Drive.
	if (remoteFileId) {
		await ctx.driveFs.delete(remoteFileId);
	}

	ctx.statsTracker.recordContentConflict();

	return { localConflictPath, remoteConflictPath, merged: false, hadConflictMarkers: false };
}

/** Merge: diff3 on text files; fall back to Keep Both for non-eligible files. */
async function resolveMerge(
	path: string,
	record: SyncRecord | undefined,
	ctx: SyncContext,
): Promise<ConflictResult> {
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	const dec = new TextDecoder();

	const [localBytes, remoteFileSide] = await Promise.all([
		ctx.localFs.read(path),
		ctx.driveFs.stat(rootFolderId, path),
	]);

	if (!remoteFileSide) {
		// Remote disappeared between planning and execution — treat as push.
		await ctx.driveFs.write(rootFolderId, path, localBytes, ctx.statsTracker, sampler);
		ctx.statsTracker.recordPush();
		return { merged: false, hadConflictMarkers: false };
	}

	const remoteBytes = await ctx.driveFs.readBinary(remoteFileSide.driveFileId);

	let baseText = '';
	if (record) {
		const baseBytes = await ctx.store.getContent(path);
		if (baseBytes) baseText = dec.decode(baseBytes);
	}

	const localText = dec.decode(localBytes);
	const remoteText = dec.decode(remoteBytes);

	const result = threeWayMerge(baseText, localText, remoteText);
	const mergedBytes = new TextEncoder().encode(result.content).buffer;

	// Write merged content to both sides.
	await ctx.localFs.write(path, mergedBytes);
	await ctx.driveFs.write(rootFolderId, path, mergedBytes, ctx.statsTracker, sampler);

	ctx.statsTracker.recordMerge();
	if (result.hasConflicts) ctx.statsTracker.recordContentConflict();

	return { merged: true, hadConflictMarkers: result.hasConflicts };
}

/** Modify-delete conflict: create a placeholder on the deleted side. */
async function resolveDeleteConflict(
	path: string,
	action: SyncAction,
	ctx: SyncContext,
): Promise<ConflictResult> {
	const now = new Date();
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	const placeholderBytes = new TextEncoder().encode(PLACEHOLDER_TEXT).buffer;

	const syncedAt = Date.now();

	if (!action.local) {
		// Local was deleted; remote was modified. Create placeholder locally.
		const placeholderPath = buildConflictFilename(path, shortClientId(ctx.clientId), now);
		await ctx.localFs.write(placeholderPath, placeholderBytes);
		// Push placeholder to Drive so all vaults see it.
		const driveSide = await ctx.driveFs.write(rootFolderId, placeholderPath, placeholderBytes, ctx.statsTracker, sampler);
		const localSide = ctx.localFs.stat(placeholderPath);
		await ctx.store.putRecord({
			path: placeholderPath,
			driveFileId: driveSide.driveFileId,
			localMtime: localSide?.mtime ?? 0,
			remoteMtime: driveSide.mtime,
			localSize: localSide?.size ?? 0,
			remoteSize: driveSide.size,
			syncedAt,
		});
	} else {
		// Remote was deleted; local was modified. Create placeholder on Drive.
		const placeholderPath = buildConflictFilename(path, 'group', now);
		await ctx.localFs.write(placeholderPath, placeholderBytes);
		const driveSide = await ctx.driveFs.write(rootFolderId, placeholderPath, placeholderBytes, ctx.statsTracker, sampler);
		const localSide = ctx.localFs.stat(placeholderPath);
		await ctx.store.putRecord({
			path: placeholderPath,
			driveFileId: driveSide.driveFileId,
			localMtime: localSide?.mtime ?? 0,
			remoteMtime: driveSide.mtime,
			localSize: localSide?.size ?? 0,
			remoteSize: driveSide.size,
			syncedAt,
		});
	}

	ctx.statsTracker.recordDeleteConflict();

	return { merged: false, hadConflictMarkers: false };
}
