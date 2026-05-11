import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
		environment: "jsdom",
		clearMocks: true,
	},
	resolve: {
		alias: {
			obsidian: "/shares/src/obsidian/obsidian-mock/src/index.ts",
		},
	},
});
