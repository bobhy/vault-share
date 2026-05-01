import { defineConfig } from 'vitest/config';

// Playground tests make real network calls to Google Drive.
// The 'obsidian' alias replaces Obsidian-specific APIs with Node.js shims so
// GDriveAuth and GDriveApi run outside of the Obsidian Electron environment.
export default defineConfig({
	test: {
		include: ['tests/playground/**/*.playground.ts'],
		testTimeout: 30_000,
		reporters: ['verbose'],
	},
	resolve: {
		alias: {
			obsidian: './tests/playground/obsidian-shim.ts',
		},
	},
});
