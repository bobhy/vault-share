import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
		environment: "jsdom",
		clearMocks: true,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__mocks__/**", "src/**/test-helpers.ts"],
			reporter: ["text", "html"],
		},
	},
	resolve: {
		alias: {
			obsidian: "obsidian-mock/src/index.ts",
		},
	},
});
