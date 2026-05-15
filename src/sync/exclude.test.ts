import { describe, it, expect } from 'vitest';
import { ExcludeMatcher } from './exclude';

// Test path constants — disable the hardcoded-config-path lint rule here since
// these are test fixture strings, not runtime references to Vault#configDir.
const OBS = '.obsidian';                                          // eslint-disable-line obsidianmd/hardcoded-config-path
const OBS_CONFIG = `${OBS}/config`;
const OBS_PLUGINS = `${OBS}/plugins`;
const OBS_PLUGINS_VS = `${OBS}/plugins/vault-share`;
const OBS_PLUGINS_VS_MAIN = `${OBS}/plugins/vault-share/main.js`;
const OBS_THEMES = `${OBS}/themes`;

describe('ExcludeMatcher.isExcluded', () => {
	it('excludes files matching a simple glob pattern', () => {
		const m = new ExcludeMatcher(['*.log']);
		expect(m.isExcluded('debug.log')).toBe(true);
		expect(m.isExcluded('note.md')).toBe(false);
	});

	it('excludes an entire directory and everything inside it', () => {
		const m = new ExcludeMatcher([OBS]);
		expect(m.isExcluded(OBS)).toBe(true);
		expect(m.isExcluded(OBS_CONFIG)).toBe(true);
		expect(m.isExcluded(OBS_PLUGINS_VS_MAIN)).toBe(true);
		expect(m.isExcluded('notes.md')).toBe(false);
	});

	it('matches ** across multiple path segments', () => {
		const m = new ExcludeMatcher(['**/tmp/**']);
		expect(m.isExcluded('a/tmp/b.md')).toBe(true);
		expect(m.isExcluded('tmp/b.md')).toBe(true);
		expect(m.isExcluded('a/b/c/tmp/d/e.md')).toBe(true);
		expect(m.isExcluded('a/notmp/b.md')).toBe(false);
	});

	it('re-includes a specific file after a broad exclude (last-match-wins)', () => {
		const m = new ExcludeMatcher([OBS, `!${OBS_PLUGINS_VS}`]);
		expect(m.isExcluded(OBS_CONFIG)).toBe(true);
		expect(m.isExcluded(OBS_PLUGINS_VS)).toBe(false);
		expect(m.isExcluded(OBS_PLUGINS_VS_MAIN)).toBe(false);
	});

	it('later rules override earlier rules (last-match-wins)', () => {
		const m = new ExcludeMatcher(['*.md', '!important.md', '*.md']);
		expect(m.isExcluded('important.md')).toBe(true);
	});

	it('does not exclude files that match no rule', () => {
		const m = new ExcludeMatcher(['*.log', 'tmp/']);
		expect(m.isExcluded('note.md')).toBe(false);
	});

	it('ignores blank lines and comment lines', () => {
		const m = new ExcludeMatcher(['', '# this is a comment', '*.log']);
		expect(m.isExcluded('debug.log')).toBe(true);
		expect(m.isExcluded('note.md')).toBe(false);
	});

	it('performs an exact match on a plain filename with no glob characters', () => {
		const m = new ExcludeMatcher(['secret.md']);
		expect(m.isExcluded('secret.md')).toBe(true);
		expect(m.isExcluded('notsecret.md')).toBe(false);
		expect(m.isExcluded('dir/secret.md')).toBe(false);
	});

	it('normalises backslashes to forward slashes', () => {
		const m = new ExcludeMatcher([OBS]);
		expect(m.isExcluded(`${OBS}\\config`)).toBe(true);
	});

	it('uses * to match within a single segment only', () => {
		const m = new ExcludeMatcher(['logs/*.log']);
		expect(m.isExcluded('logs/debug.log')).toBe(true);
		expect(m.isExcluded('logs/sub/debug.log')).toBe(false);
	});
});

describe('ExcludeMatcher.shouldDescend', () => {
	it('always descends into non-excluded directories', () => {
		const m = new ExcludeMatcher(['*.log']);
		expect(m.shouldDescend('notes')).toBe(true);
		expect(m.shouldDescend(OBS)).toBe(true);
	});

	it('does not descend into an excluded directory with no re-inclusion inside it', () => {
		const m = new ExcludeMatcher([OBS]);
		expect(m.shouldDescend(OBS)).toBe(false);
	});

	it('descends into an excluded directory when a re-inclusion rule targets a descendant', () => {
		const m = new ExcludeMatcher([OBS, `!${OBS_PLUGINS_VS}`]);
		expect(m.shouldDescend(OBS)).toBe(true);
		expect(m.shouldDescend(OBS_PLUGINS)).toBe(true);
	});

	it('does not descend into a sibling directory just because a re-inclusion exists elsewhere', () => {
		const m = new ExcludeMatcher([OBS, `!${OBS_PLUGINS_VS}`]);
		expect(m.shouldDescend(OBS_THEMES)).toBe(false);
	});
});
