import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from 'obsidian';
import { GDriveAuth } from './auth';
import { GDriveApi, DriveFile } from './api';
import { spyRequestUrl, makeMockResponse } from './test-helpers';

function makeFile(overrides: Partial<DriveFile> = {}): DriveFile {
	return { id: 'file1', name: 'test.md', mimeType: 'text/plain', ...overrides };
}

function makeApi() {
	const app = new App();
	const auth = new GDriveAuth(app);
	// Give the auth instance a refresh token so getAccessToken won't fail.
	const internal = auth as unknown as { refreshToken: string; accessToken: string; accessTokenExpiry: number };
	internal.refreshToken = 'ref';
	internal.accessToken = 'acc';
	internal.accessTokenExpiry = Date.now() + 3_600_000;
	return new GDriveApi(auth);
}

describe('GDriveApi', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('listChildren', () => {
		it('requests files with correct parent query', async () => {
			const api = makeApi();
			const spy = spyRequestUrl().mockResolvedValue(
				makeMockResponse({ json: { files: [makeFile()] } }),
			);

			const files = await api.listChildren('parent123');
			expect(files).toHaveLength(1);
			expect(spy).toHaveBeenCalledOnce();
			const url = (spy.mock.calls[0]![0] as { url: string }).url;
			expect(url).toContain('parent123');
		});

		it('throws GDriveError on 401', async () => {
			const api = makeApi();
			spyRequestUrl().mockResolvedValue(makeMockResponse({ status: 401, json: {} }));
			await expect(api.listChildren('p')).rejects.toMatchObject({ code: 'auth-expired' });
		});
	});

	describe('readFile', () => {
		it('returns text content from Drive', async () => {
			const api = makeApi();
			spyRequestUrl().mockResolvedValue(makeMockResponse({ text: 'hello world' }));
			const content = await api.readFile('file1');
			expect(content).toBe('hello world');
		});
	});

	describe('writeFile', () => {
		it('creates a new file when none exists in folder', async () => {
			const api = makeApi();
			const createdFile = makeFile({ id: 'new1' });
			const spy = spyRequestUrl()
				// findFile → listChildren with no results
				.mockResolvedValueOnce(makeMockResponse({ json: { files: [] } }))
				// createFileWithContent
				.mockResolvedValueOnce(makeMockResponse({ json: createdFile }));

			const result = await api.writeFile('folder1', 'note.md', 'content');
			expect(result.id).toBe('new1');
			expect(spy).toHaveBeenCalledTimes(2);
		});

		it('overwrites an existing file', async () => {
			const api = makeApi();
			const existingFile = makeFile({ id: 'exist1' });
			const updatedFile = makeFile({ id: 'exist1' });
			const spy = spyRequestUrl()
				// findFile → existing file found
				.mockResolvedValueOnce(makeMockResponse({ json: { files: [existingFile] } }))
				// updateFileContent
				.mockResolvedValueOnce(makeMockResponse({ json: updatedFile }));

			const result = await api.writeFile('folder1', 'note.md', 'new content');
			expect(result.id).toBe('exist1');
			// PATCH goes to upload URL with file id
			const patchUrl = (spy.mock.calls[1]![0] as { url: string }).url;
			expect(patchUrl).toContain('exist1');
		});
	});

	describe('deleteFile', () => {
		it('sends DELETE and succeeds on 204', async () => {
			const api = makeApi();
			const spy = spyRequestUrl().mockResolvedValue(makeMockResponse({ status: 204 }));
			await api.deleteFile('file1');
			const opts = spy.mock.calls[0]![0] as { method: string };
			expect(opts.method).toBe('DELETE');
		});
	});

	describe('resolveFolder', () => {
		it('returns root for empty path', async () => {
			const api = makeApi();
			const result = await api.resolveFolder('/');
			expect(result).toBe('root');
		});

		it('walks path and creates missing folders', async () => {
			const api = makeApi();
			const spy = spyRequestUrl()
				// findFolder('root', 'vault-share') → not found
				.mockResolvedValueOnce(makeMockResponse({ json: { files: [] } }))
				// createFolder('root', 'vault-share')
				.mockResolvedValueOnce(makeMockResponse({ json: makeFile({ id: 'vs1', name: 'vault-share', mimeType: 'application/vnd.google-apps.folder' }) }))
				// findFolder('vs1', 'shared') → not found
				.mockResolvedValueOnce(makeMockResponse({ json: { files: [] } }))
				// createFolder('vs1', 'shared')
				.mockResolvedValueOnce(makeMockResponse({ json: makeFile({ id: 'sh1', name: 'shared', mimeType: 'application/vnd.google-apps.folder' }) }));

			const id = await api.resolveFolder('/vault-share/shared');
			expect(id).toBe('sh1');
			expect(spy).toHaveBeenCalledTimes(4);
		});

		it('reuses existing folders without creating them', async () => {
			const api = makeApi();
			const existingFolder = makeFile({ id: 'vs1', name: 'vault-share', mimeType: 'application/vnd.google-apps.folder' });
			spyRequestUrl()
				// findFolder → found
				.mockResolvedValueOnce(makeMockResponse({ json: { files: [existingFolder] } }));

			const id = await api.resolveFolder('/vault-share');
			expect(id).toBe('vs1');
		});

		it('accepts backslash as separator', async () => {
			const api = makeApi();
			const folder = makeFile({ id: 'f1', name: 'vault-share', mimeType: 'application/vnd.google-apps.folder' });
			spyRequestUrl().mockResolvedValue(makeMockResponse({ json: { files: [folder] } }));
			const id = await api.resolveFolder('\\vault-share');
			expect(id).toBe('f1');
		});
	});

	describe('createFolder', () => {
		it('sends correct metadata', async () => {
			const api = makeApi();
			const folder = makeFile({ mimeType: 'application/vnd.google-apps.folder' });
			const spy = spyRequestUrl().mockResolvedValue(makeMockResponse({ json: folder }));
			await api.createFolder('parent1', 'my-folder');
			const body = JSON.parse((spy.mock.calls[0]![0] as { body: string }).body) as { name: string; mimeType: string; parents: string[] };
			expect(body.name).toBe('my-folder');
			expect(body.mimeType).toBe('application/vnd.google-apps.folder');
			expect(body.parents).toContain('parent1');
		});
	});
});
