#!/usr/bin/env node
// Changelog helper for the /release skill. Operates on CHANGES.md in the cwd.
//
//   node changelog.mjs check          exit 1 unless "## [unreleased]" has at least one bullet
//   node changelog.mjs stamp <ver>    rename "## [unreleased]" to "## [<ver>]"
//   node changelog.mjs notes <ver>    print the body of the "## [<ver>]" section
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "CHANGES.md";
const [cmd, version] = process.argv.slice(2);
const text = readFileSync(FILE, "utf8");

/** Body of the section headed `## [label]`, up to the next `## [` heading. */
function section(label) {
	const lines = text.split("\n");
	const start = lines.findIndex(l => l.trim().toLowerCase() === `## [${label}]`.toLowerCase());
	if (start === -1) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex(l => l.startsWith("## ["));
	return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

function fail(msg) {
	console.error(msg);
	process.exit(1);
}

switch (cmd) {
	case "check": {
		const body = section("unreleased");
		if (body === null) fail(`${FILE} has no "## [unreleased]" section.`);
		if (!/^\s*[-*] /m.test(body)) fail(`"## [unreleased]" in ${FILE} has no entries.`);
		console.log(body);
		break;
	}
	case "stamp": {
		if (!version) fail("usage: changelog.mjs stamp <version>");
		if (section(version) !== null) fail(`${FILE} already has a "## [${version}]" section.`);
		const re = /^## \[unreleased\][ \t]*$/im;
		if (!re.test(text)) fail(`${FILE} has no "## [unreleased]" section.`);
		writeFileSync(FILE, text.replace(re, `## [${version}]`));
		console.log(`Renamed [unreleased] to [${version}].`);
		break;
	}
	case "notes": {
		if (!version) fail("usage: changelog.mjs notes <version>");
		const body = section(version);
		if (!body) fail(`${FILE} has no "## [${version}]" section, or it is empty.`);
		console.log(body);
		break;
	}
	default:
		fail("usage: changelog.mjs check | stamp <version> | notes <version>");
}
