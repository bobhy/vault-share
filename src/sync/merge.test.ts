import { describe, it, expect } from 'vitest';
import { isMergeEligible, threeWayMerge } from './merge';

describe('isMergeEligible', () => {
	it('accepts .md files', () => {
		expect(isMergeEligible('note.md')).toBe(true);
		expect(isMergeEligible('subdir/note.md')).toBe(true);
	});

	it('accepts .txt files', () => {
		expect(isMergeEligible('readme.txt')).toBe(true);
	});

	it('is case-insensitive for the extension', () => {
		expect(isMergeEligible('NOTE.MD')).toBe(true);
		expect(isMergeEligible('README.TXT')).toBe(true);
	});

	it('rejects files with no extension', () => {
		expect(isMergeEligible('noextension')).toBe(false);
	});

	it('rejects non-text extensions', () => {
		expect(isMergeEligible('data.json')).toBe(false);
		expect(isMergeEligible('styles.css')).toBe(false);
		expect(isMergeEligible('image.png')).toBe(false);
	});

	it('uses the last extension, not the first', () => {
		// .md.bak has final extension .bak → not eligible
		expect(isMergeEligible('note.md.bak')).toBe(false);
	});

	it('rejects dotfile names without a double extension', () => {
		const obsDir = '.obsidian'; // eslint-disable-line obsidianmd/hardcoded-config-path
		// lastIndexOf('.') = 0, slice(0) = '.obsidian' → not in the eligible set
		expect(isMergeEligible(obsDir)).toBe(false);
	});
});

describe('threeWayMerge', () => {
	it('produces a clean merge when only one side changed', () => {
		const result = threeWayMerge(
			'line1\nshared\nline3',
			'line1\nlocal-edit\nline3',
			'line1\nshared\nline3',
		);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe('line1\nlocal-edit\nline3');
	});

	it('produces a clean merge when both sides made the same change', () => {
		const result = threeWayMerge(
			'a\nb\nc',
			'a\nX\nc',
			'a\nX\nc',
		);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe('a\nX\nc');
	});

	it('produces a clean merge when changes are on different lines', () => {
		const result = threeWayMerge(
			'a\nb\nc',
			'A\nb\nc',  // local changed line 1
			'a\nb\nC',  // remote changed line 3
		);
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe('A\nb\nC');
	});

	it('inserts conflict markers when both sides modified the same line differently', () => {
		const result = threeWayMerge(
			'a\nBASE\nc',
			'a\nLOCAL\nc',
			'a\nREMOTE\nc',
		);
		expect(result.hasConflicts).toBe(true);
		expect(result.content).toContain('> <<<<< local');
		expect(result.content).toContain('LOCAL');
		expect(result.content).toContain('> ||||| base');
		expect(result.content).toContain('BASE');
		expect(result.content).toContain('> =====');
		expect(result.content).toContain('REMOTE');
		expect(result.content).toContain('> >>>>> group');
	});

	it('uses markdown blockquote prefix (> ) on conflict markers', () => {
		const result = threeWayMerge('x', 'local', 'remote');
		const lines = result.content.split('\n');
		const markers = lines.filter(l =>
			l === '> <<<<< local' || l === '> ||||| base' ||
			l === '> =====' || l === '> >>>>> group',
		);
		expect(markers.length).toBe(4);
	});

	it('strips a trailing newline before merging then omits it from output', () => {
		// Inputs ending in \n should not produce a spurious blank line in output.
		const result = threeWayMerge('a\nb\n', 'a\nX\n', 'a\nb\n');
		expect(result.hasConflicts).toBe(false);
		expect(result.content).toBe('a\nX');
	});
});
