import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
		environment: "jsdom",
		clearMocks: true,
		coverage: {
			// istanbul (not v8) so unit coverage uses the same line model as the
			// Istanbul-instrumented e2e build — required for a coherent line-union
			// combined report (scripts/coverage-combine.mjs).
			provider: "istanbul",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__mocks__/**", "src/**/test-helpers.ts"],
			// `json` emits coverage/coverage-final.json (Istanbul-shaped) so the
			// unit run can be merged with the wdio e2e coverage — see the
			// test:coverage:combined script and specs/ui-map.md.
			reporter: ["text", "html", "json"],
		},
	},
	resolve: {
		alias: {
			obsidian: "obsidian-mock/src/index.ts",
		},
	},
});
