#!/usr/bin/env node
// The /release steps the user runs themselves (Claude's permissions block
// commit/tag/publish). Each checks its preconditions, then runs git/gh with
// argument arrays — no shell — so the user can invoke it from any shell with `!`:
//
//   .claude/skills/release/scripts/step.mjs commit <ver>    commit the five release files as "release v<ver>"
//   .claude/skills/release/scripts/step.mjs tag <ver>       tag HEAD <ver> (no "v") and push the tag
//   .claude/skills/release/scripts/step.mjs publish <ver>   create the GitHub release with assets and notes
//
// Run from the repo root.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { notes } from "./changelog.mjs";

/** Files a release commit touches: the version bump plus the stamped changelog. */
const RELEASE_FILES = ["CHANGES.md", "manifest.json", "package.json", "package-lock.json", "versions.json"];
/** Files attached to the GitHub release; Obsidian installs the plugin from these. */
const ASSETS = ["main.js", "manifest.json", "styles.css"];

class StepError extends Error {}

/**
 * Run a command; return stdout without trailing whitespace, or throw with its
 * stderr unless `allowFail`. Leading whitespace is kept: `git status --porcelain`
 * lines start with a significant space.
 */
function run(cmd, args, { input, allowFail = false } = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
	if (r.error) throw new StepError(`${cmd}: ${r.error.message}`);
	if (r.status !== 0 && !allowFail) throw new StepError(`${cmd} ${args.join(" ")} failed:\n${r.stderr.trim()}`);
	return r.status === 0 ? r.stdout.trimEnd() : null;
}

function check(ok, message) {
	if (!ok) throw new StepError(message);
}

function manifestVersion() {
	return JSON.parse(readFileSync("manifest.json", "utf8")).version;
}

function requireMain() {
	check(run("git", ["branch", "--show-current"]) === "main", "Not on branch main.");
}

function changedFiles() {
	return run("git", ["status", "--porcelain"]).split("\n").filter(Boolean).map(l => l.slice(3));
}

function commit(version) {
	requireMain();
	check(manifestVersion() === version, `manifest.json is at ${manifestVersion()}, not ${version}; run the version bump first.`);
	const changed = changedFiles();
	const unexpected = changed.filter(f => !RELEASE_FILES.includes(f));
	check(unexpected.length === 0, `Uncommitted changes outside the release files: ${unexpected.join(", ")}`);
	const missing = RELEASE_FILES.filter(f => !changed.includes(f));
	check(missing.length === 0, `Expected release changes are missing: ${missing.join(", ")}`);
	run("git", ["add", "--", ...RELEASE_FILES]);
	run("git", ["commit", "-m", `release v${version}`]);
	console.log(run("git", ["log", "--oneline", "-1"]));
}

function tag(version) {
	requireMain();
	check(changedFiles().length === 0, "Working tree is not clean.");
	check(run("git", ["log", "-1", "--format=%s"]) === `release v${version}`, `HEAD is not the "release v${version}" commit.`);
	check(manifestVersion() === version, `manifest.json is at ${manifestVersion()}, not ${version}.`);
	check(run("git", ["rev-parse", "-q", "--verify", `refs/tags/${version}`], { allowFail: true }) === null, `Tag ${version} already exists locally.`);
	run("git", ["fetch", "-q", "origin", "main"]);
	check(run("git", ["rev-parse", "HEAD"]) === run("git", ["rev-parse", "origin/main"]), "HEAD is not pushed to origin/main yet.");
	run("git", ["tag", version]);
	run("git", ["push", "origin", version]);
	console.log(`Tagged ${run("git", ["rev-parse", "--short", "HEAD"])} as ${version} and pushed the tag.`);
}

function publish(version) {
	check(changedFiles().length === 0, "Working tree is not clean; the assets might not match the tag.");
	check(run("git", ["rev-parse", "HEAD"]) === run("git", ["rev-parse", `${version}^{commit}`], { allowFail: true }), `HEAD is not tag ${version}.`);
	check(run("git", ["ls-remote", "--tags", "origin", `refs/tags/${version}`]) !== "", `Tag ${version} is not on origin; run "step.mjs tag ${version}" first.`);
	for (const f of ASSETS) check(existsSync(f) && statSync(f).size > 0, `Release asset ${f} is missing or empty; run "npm run build".`);
	check(run("gh", ["release", "view", version], { allowFail: true }) === null, `GitHub release ${version} already exists.`);
	const url = run("gh", ["release", "create", version, ...ASSETS, "--title", version, "--notes-file", "-", "--verify-tag"], { input: notes(version) });
	console.log(url);
}

const STEPS = { commit, tag, publish };
const [stepName, version] = process.argv.slice(2);
try {
	check(stepName in STEPS && /^\d+\.\d+\.\d+$/.test(version ?? ""), "usage: step.mjs commit|tag|publish <x.y.z>");
	STEPS[stepName](version);
} catch (err) {
	console.error(err instanceof StepError ? err.message : err);
	process.exit(1);
}
