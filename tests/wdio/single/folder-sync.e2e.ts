/**
 * End-to-end test: subfolder hierarchy is correctly mirrored in Drive.
 *
 * Regression test for the bug where DriveFsAdapter.write called resolveFolder()
 * with a Drive file ID as the first path segment, causing subfolders to be
 * created under My Drive root (with file-ID names) rather than nested under the
 * group vault folder with correct names.
 */

import { runBulkSync } from "../../../wdio.conf.mts";
import type { DriveFsAdapter } from "../../../src/sync/drive-fs";

// A timestamped root prefix isolates this test run from prior vault content.
const ROOT = `folder-sync-test-${Date.now()}`;

// ~10 files across: root dir, one subdir, and one subdir with a sub-subdir.
const FILES: Array<[string, string]> = [
	[`${ROOT}/note1.md`,          "note 1 content"],
	[`${ROOT}/note2.md`,          "note 2 content"],
	[`${ROOT}/note3.md`,          "note 3 content"],
	[`${ROOT}/subdir1/a.md`,      "subdir1 file a"],
	[`${ROOT}/subdir1/b.md`,      "subdir1 file b"],
	[`${ROOT}/subdir1/c.md`,      "subdir1 file c"],
	[`${ROOT}/subdir2/deep/d.md`, "subdir2 deep file d"],
	[`${ROOT}/subdir2/deep/e.md`, "subdir2 deep file e"],
	[`${ROOT}/subdir2/deep/f.md`, "subdir2 deep file f"],
];

describe("Folder hierarchy sync", () => {
	before(async () => {
		// Create the vault folder tree and files before syncing.
		await browser.executeObsidian(async ({ app }, files) => {
			// Collect unique parent directories; sort so parents come before children.
			const dirs = new Set<string>();
			for (const [path] of files as Array<[string, string]>) {
				const parts = path.split("/");
				for (let i = 1; i < parts.length; i++) {
					dirs.add(parts.slice(0, i).join("/"));
				}
			}
			for (const dir of [...dirs].sort()) {
				if (!app.vault.getAbstractFileByPath(dir)) {
					await app.vault.createFolder(dir);
				}
			}
			for (const [path, content] of files as Array<[string, string]>) {
				if (!app.vault.getFileByPath(path)) {
					await app.vault.create(path, content);
				}
			}
		}, FILES);
	});

	it("uploads all files and reports the correct count", async () => {
		const result = await runBulkSync(browser);
		// At least the 9 new files must have been pushed.
		expect(result.uploaded).toBeGreaterThanOrEqual(FILES.length);
	});

	it("mirrors the full subfolder hierarchy in Drive with correct folder names", async () => {
		// Use driveFs.listAll to walk the Drive tree and collect all file paths.
		// If the bug were present, folders would be missing from this folder and the
		// expected paths would not appear in the list.
		const drivePaths = await browser.executeObsidian(async ({ app }) => {
			type DriveFs = DriveFsAdapter;
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, unknown> };
			}).plugins.plugins["vault-share"];
			if (!plugin) throw new Error("vault-share plugin not loaded");

			const folderId = (plugin as unknown as { driveFolderId: string }).driveFolderId;
			const driveFs = (plugin as unknown as { driveFs: DriveFs }).driveFs;
			const allFiles = await driveFs.listAll(folderId);
			return allFiles.map(f => f.path);
		}) as unknown as string[];

		// Every local path must appear in Drive under the same relative path.
		for (const [expectedPath] of FILES) {
			expect(drivePaths).toContain(expectedPath);
		}
	});

	it("creates named Drive folders, not file-ID-named folders at Drive root", async () => {
		// Verify that the subfolder names visible in Drive match what was in the vault.
		// The bug produced top-level Drive folders named after file IDs (e.g., "1cdNv6Tc1_...").
		const folderNames = await browser.executeObsidian(async ({ app }, root) => {
			const plugin = (app as unknown as {
				plugins: { plugins: Record<string, unknown> };
			}).plugins.plugins["vault-share"];
			if (!plugin) throw new Error("vault-share plugin not loaded");

			const api = (plugin as unknown as { api: { findFolder: (parentId: string, name: string) => Promise<{ id: string; name: string } | null> } }).api;
			const folderId = (plugin as unknown as { driveFolderId: string }).driveFolderId;

			// Expect a folder named <ROOT> directly under the group vault folder.
			const rootFolder = await api.findFolder(folderId, root as string);
			if (!rootFolder) return null;

			// Expect named subfolders inside it.
			const sub1 = await api.findFolder(rootFolder.id, "subdir1");
			const sub2 = await api.findFolder(rootFolder.id, "subdir2");
			if (!sub1 || !sub2) return null;

			const deep = await api.findFolder(sub2.id, "deep");
			if (!deep) return null;

			return {
				root: rootFolder.name,
				subdir1: sub1.name,
				subdir2: sub2.name,
				deep: deep.name,
			};
		}, ROOT) as unknown as { root: string; subdir1: string; subdir2: string; deep: string } | null;

		expect(folderNames).not.toBeNull();
		expect(folderNames?.root).toBe(ROOT);
		expect(folderNames?.subdir1).toBe("subdir1");
		expect(folderNames?.subdir2).toBe("subdir2");
		expect(folderNames?.deep).toBe("deep");
	});
});
