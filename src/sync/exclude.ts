/**
 * Evaluates vault-share's ordered, last-match-wins exclude rules.
 *
 * Semantics differ from standard gitignore in one key way: a file may be
 * re-included with a ! rule even when its parent directory is excluded.
 * This requires descending into excluded directories when a re-inclusion
 * rule could match something inside them.
 */
export class ExcludeMatcher {
	private readonly rules: Array<{ pattern: string; include: boolean }>;
	/** Prefixes from re-inclusion rules — directories that must be descended. */
	private readonly reincludePrefixes: string[];

	constructor(rules: string[]) {
		this.rules = rules
			.map(r => r.trim())
			.filter(r => r.length > 0 && !r.startsWith('#'))
			.map(r => ({
				pattern: r.startsWith('!') ? r.slice(1) : r,
				include: r.startsWith('!'),
			}));

		this.reincludePrefixes = this.rules
			.filter(r => r.include)
			.map(r => r.pattern)
			.flatMap(p => ancestorPaths(p));
	}

	/**
	 * Returns true if this path should be excluded from sync.
	 * Processes rules top-to-bottom; the last matching rule wins.
	 */
	isExcluded(path: string): boolean {
		const normalised = normalisePath(path);
		let excluded = false;

		for (const rule of this.rules) {
			if (matches(normalised, rule.pattern)) {
				excluded = !rule.include;
			}
		}

		return excluded;
	}

	/**
	 * Returns true if a directory should be descended into during enumeration.
	 * A directory must be descended even when it is itself excluded, whenever
	 * a re-inclusion rule could match a descendant.
	 */
	shouldDescend(dirPath: string): boolean {
		const normalised = normalisePath(dirPath);
		// Always descend if not excluded.
		if (!this.isExcluded(normalised)) return true;
		// Excluded but this directory is a direct ancestor of a re-included path.
		// reincludePrefixes already contains every ancestor of every re-inclusion rule,
		// so an exact-match is sufficient — a startsWith check would incorrectly
		// include sibling directories that share the same prefix (e.g. ".obsidian/themes"
		// when only ".obsidian/plugins/vault-share" is re-included).
		return this.reincludePrefixes.some(p => p === normalised);
	}
}

/** Normalise to forward slashes, no leading or trailing slash. */
function normalisePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Return all ancestor directory paths of a given path, normalised.
 * E.g. ".obsidian/plugins/vault-share" → [".obsidian", ".obsidian/plugins"]
 */
function ancestorPaths(p: string): string[] {
	const parts = normalisePath(p).split('/');
	const ancestors: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		ancestors.push(parts.slice(0, i).join('/'));
	}
	return ancestors;
}

/**
 * Returns true when path matches pattern using simple glob semantics:
 * - `**` matches any number of path segments
 * - `*` matches any characters within a single segment
 * - No pattern → exact match or prefix match for directories
 */
function matches(path: string, pattern: string): boolean {
	const norm = normalisePath(pattern);

	// Exact match.
	if (path === norm) return true;

	// Directory prefix match: pattern "foo" matches "foo/bar".
	if (path.startsWith(norm + '/')) return true;

	// Glob match.
	const re = globToRegex(norm);
	return re.test(path);
}

function globToRegex(glob: string): RegExp {
	let src = '';
	let i = 0;
	while (i < glob.length) {
		if (glob[i] === '*' && glob[i + 1] === '*') {
			if (glob[i + 2] === '/') {
				// **/ → match zero-or-more complete path segments as a prefix.
				// Using (.*\/)? rather than .*\/ ensures segment-boundary anchoring:
				// **/tmp/** must NOT match "notmp/foo" via the "tmp" substring.
				src += '(.*\\/)?';
				i += 3;
			} else {
				// ** at end of pattern or not followed by / → match any remainder.
				src += '.*';
				i += 2;
			}
		} else if (glob[i] === '*') {
			src += '[^/]*';
			i++;
		} else if (glob[i] === '?') {
			src += '[^/]';
			i++;
		} else {
			src += escapeRegex(glob[i]!);
			i++;
		}
	}
	return new RegExp(`^${src}$`);
}

function escapeRegex(ch: string): string {
	return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
