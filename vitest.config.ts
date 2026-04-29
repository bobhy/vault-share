import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
	},
	resolve: {
		alias: {
			obsidian: "./src/__mocks__/obsidian.ts",
		},
	},
});
