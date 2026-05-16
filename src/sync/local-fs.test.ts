import { describe, it, expect, beforeEach } from 'vitest';
import type { Vault } from 'obsidian';
import { App } from 'obsidian';
import { LocalFs } from './local-fs';
import { ExcludeMatcher } from './exclude';

function noExcludes(): ExcludeMatcher {
	return new ExcludeMatcher([]);
}

describe('LocalFs', () => {
	let app: App;
	let vault: Vault;
	let fs: LocalFs;

	beforeEach(() => {
		app = new App();
		vault = app.vault;
		fs = new LocalFs(app);
	});

	describe('list()', () => {
		it('returns empty array when vault is empty', async () => {
			const result = await fs.list(noExcludes());
			expect(result).toEqual([]);
		});

		it('returns files at the root level', async () => {
			await vault.create('note.md', '');
			await vault.create('image.png', '');

			const result = await fs.list(noExcludes());
			const paths = result.map(f => f.path).sort();
			expect(paths).toEqual(['image.png', 'note.md']);
		});

		it('recurses into subdirectories', async () => {
			await vault.createFolder('subdir');
			await vault.create('subdir/nested.md', '');
			await vault.create('root.md', '');

			const result = await fs.list(noExcludes());
			const paths = result.map(f => f.path).sort();
			expect(paths).toEqual(['root.md', 'subdir/nested.md']);
		});

		it('recurses into nested subdirectories', async () => {
			await vault.createFolder('a');
			await vault.createFolder('a/b');
			await vault.create('a/b/deep.md', '');

			const result = await fs.list(noExcludes());
			expect(result.map(f => f.path)).toEqual(['a/b/deep.md']);
		});

		it('excludes files matching exclude rules', async () => {
			await vault.create('keep.md', '');
			await vault.create('skip.md', '');
			const matcher = new ExcludeMatcher(['skip.md']);

			const result = await fs.list(matcher);
			expect(result.map(f => f.path)).toEqual(['keep.md']);
		});

		it('does not descend into excluded directories', async () => {
			await vault.createFolder('hidden');
			await vault.create('hidden/secret.md', '');
			await vault.create('visible.md', '');
			const matcher = new ExcludeMatcher(['hidden']);

			const result = await fs.list(matcher);
			expect(result.map(f => f.path)).toEqual(['visible.md']);
		});

		it('returns file mtime and size metadata', async () => {
			const before = Date.now();
			await vault.create('file.md', '');
			const after = Date.now();

			const result = await fs.list(noExcludes());
			expect(result).toHaveLength(1);
			expect(result[0]!.mtime).toBeGreaterThanOrEqual(before);
			expect(result[0]!.mtime).toBeLessThanOrEqual(after);
		});
	});

	describe('stat()', () => {
		it('returns metadata for an existing file', async () => {
			await vault.create('note.md', '');
			const stat = fs.stat('note.md');
			expect(stat).not.toBeNull();
			expect(stat!.path).toBe('note.md');
		});

		it('returns null for a missing file', () => {
			expect(fs.stat('nonexistent.md')).toBeNull();
		});
	});

	describe('read()', () => {
		it('reads binary content from a file', async () => {
			const data = new Uint8Array([1, 2, 3]).buffer;
			await vault.createBinary('bin.dat', data);

			const result = await fs.read('bin.dat');
			expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
		});

		it('throws when file does not exist', async () => {
			await expect(fs.read('missing.md')).rejects.toThrow('Local file not found: missing.md');
		});
	});

	describe('write()', () => {
		it('creates a new file when path does not exist', async () => {
			const data = new TextEncoder().encode('hello').buffer;
			await fs.write('new.md', data);

			expect(vault.getFileByPath('new.md')).not.toBeNull();
		});

		it('modifies an existing file', async () => {
			await vault.create('existing.md', '');
			const data = new TextEncoder().encode('updated').buffer;

			await expect(fs.write('existing.md', data)).resolves.toBeUndefined();
			// eslint-disable-next-line @typescript-eslint/unbound-method -- modifyBinary is a vi.fn() mock with no 'this' dependency
			expect(vault.modifyBinary).toHaveBeenCalled();
		});

		it('creates parent folders as needed', async () => {
			const data = new Uint8Array([]).buffer;
			await fs.write('deep/nested/file.md', data);

			expect(vault.getFolderByPath('deep')).not.toBeNull();
			expect(vault.getFolderByPath('deep/nested')).not.toBeNull();
		});
	});

	describe('delete()', () => {
		it('deletes an existing file via fileManager.trashFile', async () => {
			await vault.create('todelete.md', '');
			await fs.delete('todelete.md');

			// eslint-disable-next-line @typescript-eslint/unbound-method -- trashFile is a vi.fn() mock with no 'this' dependency
			expect(app.fileManager.trashFile).toHaveBeenCalled();
		});

		it('is a no-op for missing files', async () => {
			await expect(fs.delete('missing.md')).resolves.toBeUndefined();

			// eslint-disable-next-line @typescript-eslint/unbound-method -- trashFile is a vi.fn() mock with no 'this' dependency
			expect(app.fileManager.trashFile).not.toHaveBeenCalled();
		});
	});

	describe('rename()', () => {
		it('renames an existing file via fileManager.renameFile', async () => {
			await vault.create('old.md', '');
			await fs.rename('old.md', 'new.md');

			// eslint-disable-next-line @typescript-eslint/unbound-method -- renameFile is a vi.fn() mock with no 'this' dependency
			expect(app.fileManager.renameFile).toHaveBeenCalled();
		});

		it('throws when source file does not exist', async () => {
			await expect(fs.rename('missing.md', 'other.md')).rejects.toThrow('Local file not found: missing.md');
		});
	});
});
