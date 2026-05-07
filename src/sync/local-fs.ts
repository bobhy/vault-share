import type { App } from 'obsidian';
import { TFile, TFolder } from 'obsidian';
import type { FileSide } from './types';
import type { ExcludeMatcher } from './exclude';

/**
 * Obsidian Vault adapter for local file system operations.
 * All paths are vault-relative (forward slashes, no leading slash).
 * Uses only the Obsidian API — no Node.js or Electron APIs.
 */
export class LocalFs {
	constructor(private readonly app: App) {}

	/**
	 * List all syncable files in the vault, applying exclude rules.
	 * Descends into excluded directories only when re-inclusion rules require it.
	 */
	async list(excludeMatcher: ExcludeMatcher): Promise<FileSide[]> {
		const results: FileSide[] = [];
		await this.walk('', excludeMatcher, results);
		return results;
	}

	/** Return file metadata, or null if the file does not exist. */
	stat(path: string): FileSide | null {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		return { path, mtime: file.stat.mtime, size: file.stat.size };
	}

	/** Read a file's raw bytes. */
	async read(path: string): Promise<ArrayBuffer> {
		const file = this.getFileOrThrow(path);
		return this.app.vault.readBinary(file);
	}

	/**
	 * Write content to a vault path, creating parent folders as needed.
	 * mtime is not settable via the Obsidian API; the OS assigns it.
	 */
	async write(path: string, content: ArrayBuffer): Promise<void> {
		const existing = this.app.vault.getFileByPath(path);
		if (existing) {
			await this.app.vault.modifyBinary(existing, content);
		} else {
			await this.ensureParentFolder(path);
			await this.app.vault.createBinary(path, content);
		}
	}

	/** Delete a file from the vault. No-op if not found. */
	async delete(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file) await this.app.fileManager.trashFile(file);
	}

	/** Rename/move a file within the vault. */
	async rename(oldPath: string, newPath: string): Promise<void> {
		const file = this.getFileOrThrow(oldPath);
		await this.ensureParentFolder(newPath);
		await this.app.fileManager.renameFile(file, newPath);
	}

	private async walk(
		dirPath: string,
		excludeMatcher: ExcludeMatcher,
		results: FileSide[],
	): Promise<void> {
		const folder = dirPath === ''
			? this.app.vault.getRoot()
			: this.app.vault.getFolderByPath(dirPath);

		if (!folder) return;

		for (const child of folder.children) {
			const childPath = child.path;

			if (child instanceof TFolder) {
				if (excludeMatcher.shouldDescend(childPath)) {
					await this.walk(childPath, excludeMatcher, results);
				}
			} else if (child instanceof TFile) {
				if (!excludeMatcher.isExcluded(childPath)) {
					results.push({ path: childPath, mtime: child.stat.mtime, size: child.stat.size });
				}
			}
		}
	}

	private getFileOrThrow(path: string): TFile {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`Local file not found: ${path}`);
		return file;
	}

	private async ensureParentFolder(filePath: string): Promise<void> {
		const parts = filePath.split('/');
		parts.pop(); // remove filename
		if (parts.length === 0) return;

		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getFolderByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}
