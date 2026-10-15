#!/usr/bin/env node
// Changelog helper for the /release skill. Operates on CHANGES.md in the cwd.
//
//   node changelog.mjs check          exit 1 unless "## [unreleased]" has at least one bullet
//   node changelog.mjs stamp <ver>    rename "## [unreleased]" to "## [<ver>]"
//   node changelog.mjs notes <ver>    print the body of the "## [<ver>]" section
//
// The functions are also imported by step.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = "CHANGES.md";

/** Body of the section headed `## [label]`, up to the next `## [` heading, or null if absent. */
export function section(label, text = readFileSync(FILE, "utf8")) {
	const lines = text.split("\n");
	const start = lines.findIndex(l => l.trim().toLowerCase() === `## [${label}]`.toLowerCase());
	if (start === -1) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex(l => l.startsWith("## ["));
	return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** Release notes for `version`; throws if the section is missing or empty. */
export function notes(version) {
	const body = section(version);
	if (!body) throw new Error(`${FILE} has no "## [${version}]" section, or it is empty.`);
	return body;
}

function main([cmd, version]) {
	const text = readFileSync(FILE, "utf8");
	switch (cmd) {
		case "check": {
			const body = section("unreleased", text);
			if (body === null) throw new Error(`${FILE} has no "## [unreleased]" section.`);
			if (!/^\s*[-*] /m.test(body)) throw new Error(`"## [unreleased]" in ${FILE} has no entries.`);
			console.log(body);
			return;
		}
		case "stamp": {
			if (!version) throw new Error("usage: changelog.mjs stamp <version>");
			if (section(version, text) !== null) throw new Error(`${FILE} already has a "## [${version}]" section.`);
			const re = /^## \[unreleased\][ \t]*$/im;
			if (!re.test(text)) throw new Error(`${FILE} has no "## [unreleased]" section.`);
			writeFileSync(FILE, text.replace(re, `## [${version}]`));
			console.log(`Renamed [unreleased] to [${version}].`);
			return;
		}
		case "notes":
			if (!version) throw new Error("usage: changelog.mjs notes <version>");
			console.log(notes(version));
			return;
		default:
			throw new Error("usage: changelog.mjs check | stamp <version> | notes <version>");
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
