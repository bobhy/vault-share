/**
 * Conflict-resolution strategies executed by `file-syncer.ts`.
 *
 * Routes each conflict candidate to the appropriate resolver based on the
 * candidate's shape (delete-conflict vs content-conflict) and the user's
 * configured strategy (Use Newer, Merge, Keep Both). Owns the conflict-copy
 * filename convention and the modifier-wins semantics for modify/delete
 * conflicts.
 *
 * @packageDocumentation
 */
import type { Candidate, SyncContext, SyncedFileState } from './types';
import type { FileConflictStrategy, TextFileConflictStrategy } from '../settings';
import { isMergeEligible, reconcileText } from './nway-merge';
import { shortClientId } from './client-id';

const PLACEHOLDER_TEXT = 'Placeholder for deleted file';

/** Outcome reported by every conflict-resolver branch back to `syncOneFile`. */
export interface ConflictResult {
	localConflictPath?: string;
	remoteConflictPath?: string;
	merged: boolean;
	hadConflictMarkers: boolean;
	/**
	 * Newly created vault paths (conflict copies, placeholders) that should be
	 * inserted into `CandidateStore` as `Synced` candidates.
	 */
	newSyncedFiles?: Array<{ path: string } & SyncedFileState>;
	/**
	 * True when the resolver re-established coherent content at the *original*
	 * `candidate.path` on both sides — and the caller should therefore treat
	 * the result as "in place" (read the original, build a syncedState for it)
	 * even when `merged` is false.
	 *
	 * Set by `resolveDeleteConflict` under modifier-wins semantics:
	 * the surviving (modified) side is propagated to the side that had the
	 * file deleted, and a placeholder is created at a side path to mark the
	 * deletion intent. `resolveMerge` / `resolveUseNewer` already
	 * signal in-place via `merged: true` or by producing no `newSyncedFiles`,
	 * so they leave this field unset.
	 */
	restoredOriginal?: boolean;
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
 * Text files (.md, .txt) use textStrategy; all other files use fileStrategy.
 * Also handles modify-delete conflicts by creating a placeholder file.
 */
export async function resolveConflict(
	candidate: Candidate,
	fileStrategy: FileConflictStrategy,
	textStrategy: TextFileConflictStrategy,
	ctx: SyncContext,
	prereadLocalContent?: ArrayBuffer,
): Promise<ConflictResult> {
	const { local, remote } = candidate;
	const isDeleteConflict = !local || !remote;

	if (isDeleteConflict) {
		return resolveDeleteConflict(candidate, ctx);
	}

	const strategy = isMergeEligible(candidate.path) ? textStrategy : fileStrategy;

	if (strategy === 'Use Newer') {
		return resolveUseNewer(candidate.path, local.mtime, remote.mtime, ctx, prereadLocalContent);
	}
	if (strategy === 'Merge') {
		return resolveMerge(candidate, ctx, prereadLocalContent);
	}
	return resolveKeepBoth(candidate, ctx, prereadLocalContent);
}

/** Use Newer: overwrite the older side with the newer side. */
async function resolveUseNewer(
	path: string,
	localMtime: number,
	remoteMtime: number,
	ctx: SyncContext,
	prereadLocalContent?: ArrayBuffer,
): Promise<ConflictResult> {
	const { localFs, driveFs } = ctx;
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };

	if (localMtime >= remoteMtime) {
		// Local is newer — push to Drive.
		const content = prereadLocalContent ?? await localFs.read(path);
		await driveFs.write(rootFolderId, path, content, ctx.statsTracker, sampler);
		ctx.statsTracker.recordPush();
	} else {
		// Remote is newer — pull to local.
		const remoteSide = await driveFs.stat(rootFolderId, path);
		if (remoteSide) {
			const content = await driveFs.readBinary(remoteSide.driveFileId);
			await localFs.write(path, content);
			ctx.statsTracker.recordPull();
		}
	}

	return { merged: false, hadConflictMarkers: false };
}

/** Keep Both: rename both sides to conflict filenames and propagate. */
async function resolveKeepBoth(
	candidate: Candidate,
	ctx: SyncContext,
	prereadLocalContent?: ArrayBuffer,
): Promise<ConflictResult> {
	const { path } = candidate;
	const now = new Date();
	const localConflictPath = buildConflictFilename(path, shortClientId(ctx.clientId), now);
	const remoteConflictPath = buildConflictFilename(path, 'group', now);
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };

	// Read both sides before renaming.
	const [localContent, remoteFileId] = await Promise.all([
		prereadLocalContent ? Promise.resolve(prereadLocalContent) : ctx.localFs.read(path),
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

	// Push both conflict files to Drive and collect their sync metadata.
	const syncedAt = Date.now();
	const newSyncedFiles: Array<{ path: string } & SyncedFileState> = [];

	const localDriveSide = await ctx.driveFs.write(rootFolderId, localConflictPath, localContent, ctx.statsTracker, sampler);
	const localLocalSide = ctx.localFs.stat(localConflictPath);
	newSyncedFiles.push({
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
		newSyncedFiles.push({
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

	return { localConflictPath, remoteConflictPath, merged: false, hadConflictMarkers: false, newSyncedFiles };
}

/**
 * Merge: N-way reconcile for text files ({@link reconcileText}).
 *
 * Three outcomes:
 * - **clean** — the sides reduce to one marker-free version; written to local,
 *   and pushed to Drive only when it differs from the current remote (a drained
 *   resolution pushes; an adopted remote does not).
 * - **folded** — a (possibly grown) N-way file; pushed to Drive only when
 *   `changed` (we contributed a new alternative), otherwise we adopt Drive's bytes.
 * - **keepBoth** — base mismatch / malformed / out-of-span; delegate to
 *   {@link resolveKeepBoth}, never garbling.
 *
 * The caller (`file-syncer`) records the written content as the new base, which
 * is the provenance the next reconcile relies on (see specs/nway-conflict.md).
 */
async function resolveMerge(
	candidate: Candidate,
	ctx: SyncContext,
	prereadLocalContent?: ArrayBuffer,
): Promise<ConflictResult> {
	const { path } = candidate;
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	const dec = new TextDecoder();

	const [localBytes, remoteFileSide] = await Promise.all([
		prereadLocalContent ? Promise.resolve(prereadLocalContent) : ctx.localFs.read(path),
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
	if (candidate.syncedAt > 0) {
		const baseBytes = await ctx.store.getContent(path);
		if (baseBytes) baseText = dec.decode(baseBytes);
	}

	const localText = dec.decode(localBytes);
	const remoteText = dec.decode(remoteBytes);

	const result = reconcileText(baseText, localText, remoteText);
	if (result.kind === 'keepBoth') {
		return resolveKeepBoth(candidate, ctx, prereadLocalContent);
	}

	const mergedBytes = new TextEncoder().encode(result.content).buffer;
	const pushDrive = result.kind === 'folded' ? result.changed : result.content !== remoteText;

	if (result.content !== localText) await ctx.localFs.write(path, mergedBytes);
	if (pushDrive) await ctx.driveFs.write(rootFolderId, path, mergedBytes, ctx.statsTracker, sampler);

	ctx.statsTracker.recordMerge();
	const hadConflictMarkers = result.kind === 'folded';
	if (hadConflictMarkers) ctx.statsTracker.recordContentConflict();

	return { merged: true, hadConflictMarkers };
}

/**
 * Modify-delete conflict resolution under **modifier-wins** semantics.
 *
 * Whichever side still has the file (the *modifier*) becomes the canonical
 * content at the original path; the side that had it deleted is brought
 * back in line by either pulling Drive content down or pushing local content
 * up.  A placeholder is created at a sibling `<base>-conflict-<tag>-<ts>.<ext>`
 * path to mark the deletion intent so the user can see what happened.
 *
 * Tags: `shortClientId(clientId)` when the local side was the one that had
 * its copy deleted (so the placeholder identifies *this* device's intent),
 * and the literal `'group'` when the deletion came from the remote/group
 * side.
 *
 * This is the change for sync-review-followups item (14) — the previous
 * implementation only created the placeholder and left the original path's
 * surviving side untouched, which produced a "boomerang" on the next
 * reconcile (the surviving side was treated as a brand-new no-history push
 * or pull, effectively reverting the user's delete without telling them).
 *
 * Returns `restoredOriginal: true` so `syncOneFile`'s conflict case
 * builds a `syncedState` for the now-coherent original path, while still
 * inserting the placeholder via `newSyncedFiles`.
 */
async function resolveDeleteConflict(
	candidate: Candidate,
	ctx: SyncContext,
): Promise<ConflictResult> {
	const { path, local } = candidate;
	const now = new Date();
	const rootFolderId = ctx.driveFolderId();
	const sampler = { value: false };
	const placeholderBytes = new TextEncoder().encode(PLACEHOLDER_TEXT).buffer;

	const syncedAt = Date.now();
	const newSyncedFiles: Array<{ path: string } & SyncedFileState> = [];

	if (!local) {
		// Local was deleted; remote (Drive) holds the modifier's content.
		// Pull the remote content down to the original path so local is back
		// in sync, then create a placeholder tagged with this device's id to
		// mark "this device's user wanted to delete this file."
		const remoteFileId = candidate.remote?.driveFileId;
		if (!remoteFileId) {
			throw new Error(
				`resolveDeleteConflict: remote driveFileId missing for ${path}; ` +
				`a delete-conflict requires the surviving Drive file to be known`,
			);
		}
		const remoteContent = await ctx.driveFs.readBinary(remoteFileId);
		await ctx.localFs.write(path, remoteContent);

		const placeholderPath = buildConflictFilename(path, shortClientId(ctx.clientId), now);
		await ctx.localFs.write(placeholderPath, placeholderBytes);
		const driveSide = await ctx.driveFs.write(rootFolderId, placeholderPath, placeholderBytes, ctx.statsTracker, sampler);
		const localSide = ctx.localFs.stat(placeholderPath);
		newSyncedFiles.push({
			path: placeholderPath,
			driveFileId: driveSide.driveFileId,
			localMtime: localSide?.mtime ?? 0,
			remoteMtime: driveSide.mtime,
			localSize: localSide?.size ?? 0,
			remoteSize: driveSide.size,
			syncedAt,
		});
	} else {
		// Remote was deleted; local holds the modifier's content.
		// Push the local content back up to Drive so remote is back in sync,
		// then create a placeholder tagged 'group' to mark "another device
		// wanted to delete this file."
		const localContent = await ctx.localFs.read(path);
		await ctx.driveFs.write(rootFolderId, path, localContent, ctx.statsTracker, sampler);

		const placeholderPath = buildConflictFilename(path, 'group', now);
		await ctx.localFs.write(placeholderPath, placeholderBytes);
		const driveSide = await ctx.driveFs.write(rootFolderId, placeholderPath, placeholderBytes, ctx.statsTracker, sampler);
		const localSide = ctx.localFs.stat(placeholderPath);
		newSyncedFiles.push({
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

	return { merged: false, hadConflictMarkers: false, newSyncedFiles, restoredOriginal: true };
}
