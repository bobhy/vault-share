/**
 * Combined unit + e2e coverage — by LINE-LEVEL UNION.
 *
 * Unit coverage (vitest, v8 provider, vite-transpiled) and e2e coverage
 * (the esbuild-bundled, Istanbul-instrumented `main.js` run under wdio) cover
 * the same source files but instrument *different* transpiled JS, so their
 * per-file statement maps don't align. A statement-level `nyc merge` of the two
 * therefore corrupts the numbers (it averages rather than unions). What *is*
 * coherent is the set of covered **source lines**: a line counts as covered in
 * the combined view if either run exercised it. This script unions those sets.
 *
 * Inputs:  coverage/coverage-final.json (unit) + .nyc_output/*.json (e2e).
 * Output:  a per-file + total line-coverage table on stdout, and a JSON summary
 *          at coverage-all/combined-line-coverage.json.
 */
import libCoverage from 'istanbul-lib-coverage';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const { createCoverageMap } = libCoverage;
import { relative, join } from 'node:path';

function loadMap(files) {
	const map = createCoverageMap({});
	for (const f of files) {
		if (existsSync(f)) map.merge(JSON.parse(readFileSync(f, 'utf8')));
	}
	return map;
}

const unit = loadMap(['coverage/coverage-final.json']);
const e2eFiles = existsSync('.nyc_output')
	? readdirSync('.nyc_output').filter(f => f.endsWith('.json')).map(f => join('.nyc_output', f))
	: [];
const e2e = loadMap(e2eFiles);

const sources = [unit, e2e];
const files = new Set([...unit.files(), ...e2e.files()]);

const rows = [];
let totalCovered = 0;
let totalLines = 0;
for (const file of [...files].sort()) {
	const covered = new Map(); // lineNo -> coveredByAny
	for (const map of sources) {
		if (!map.files().includes(file)) continue;
		const lc = map.fileCoverageFor(file).getLineCoverage();
		for (const [ln, hits] of Object.entries(lc)) {
			covered.set(ln, (covered.get(ln) ?? false) || hits > 0);
		}
	}
	const lines = covered.size;
	const cov = [...covered.values()].filter(Boolean).length;
	totalCovered += cov;
	totalLines += lines;
	rows.push({ file: relative(process.cwd(), file), covered: cov, lines, pct: lines ? (cov / lines) * 100 : 100 });
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const nameW = Math.max(20, ...rows.map(r => r.file.length));
console.log('\nCombined line coverage (unit ∪ e2e)\n');
console.log(`${pad('File', nameW)} | ${padL('% Lines', 8)} | ${padL('Covered/Total', 14)}`);
console.log('-'.repeat(nameW + 28));
for (const r of rows) {
	console.log(`${pad(r.file, nameW)} | ${padL(r.pct.toFixed(2), 8)} | ${padL(`${r.covered}/${r.lines}`, 14)}`);
}
console.log('-'.repeat(nameW + 28));
const totalPct = totalLines ? (totalCovered / totalLines) * 100 : 100;
console.log(`${pad('All files', nameW)} | ${padL(totalPct.toFixed(2), 8)} | ${padL(`${totalCovered}/${totalLines}`, 14)}\n`);

mkdirSync('coverage-all', { recursive: true });
writeFileSync(
	'coverage-all/combined-line-coverage.json',
	JSON.stringify({ total: { covered: totalCovered, lines: totalLines, pct: totalPct }, files: rows }, null, 2),
);
console.log('Wrote coverage-all/combined-line-coverage.json');
