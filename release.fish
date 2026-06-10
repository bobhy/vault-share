#!/usr/bin/env fish
#
# release.fish — cut a GitHub release for the vault-share plugin.
#
# Run AFTER `npm run version` (which propagates package.json's version into
# manifest.json + versions.json and stages those two). This script then:
#   1. ensures CHANGES.md's top-most release header matches package.json
#   2. commits package.json, manifest.json, versions.json (+ CHANGES.md if it
#      changed) as "release v<version>"
#   3. pushes the current branch to origin
#   4. builds the release artifacts (main.js; styles.css + manifest.json already exist)
#   5. `gh release create <version>` attaching the three plugin artifacts, titled
#      <version>, with the top-most CHANGES.md section as the release notes
#
# Usage:
#   ./release.fish              commit, push, build, release (prompts to confirm)
#   ./release.fish -y|--yes     skip the confirmation prompt
#   ./release.fish -n|--dry-run show the plan and exit without changing anything

function _die
    set_color red; echo "release: $argv" >&2; set_color normal
    exit 1
end

function _step
    set_color --bold cyan; echo "▶ $argv"; set_color normal
end

# ── Arguments ────────────────────────────────────────────────────────────────
set -l assume_yes 0
set -l dry_run 0
for arg in $argv
    switch $arg
        case -y --yes
            set assume_yes 1
        case -n --dry-run
            set dry_run 1
        case '*'
            _die "unknown argument: $arg (use -y/--yes or -n/--dry-run)"
    end
end

# ── Preflight ────────────────────────────────────────────────────────────────
type -q node; or _die "node not found"
type -q gh; or _die "gh (GitHub CLI) not found — install it or release via the web UI"

set -l repo (git rev-parse --show-toplevel 2>/dev/null); or _die "not inside a git repository"
cd $repo; or _die "cannot cd to repo root: $repo"
test -f package.json; or _die "no package.json at repo root"
test -f CHANGES.md; or _die "no CHANGES.md at repo root"

set -l relver (node -p "require('./package.json').version" 2>/dev/null)
test $status -eq 0 -a -n "$relver"; or _die "cannot read version from package.json"

set -l branch (git rev-parse --abbrev-ref HEAD)

# Refuse to clobber an existing release for this version.
if gh release view $relver >/dev/null 2>&1
    _die "a GitHub release '$relver' already exists — bump the version first"
end

# ── Locate the top-most release header in CHANGES.md ─────────────────────────
# A release header looks like '## [x.y.z]'; the top-most one is what we publish.
set -l hdr (grep -nE '^## \[[0-9][^]]*\]' CHANGES.md | head -n1)
test -n "$hdr"; or _die "no release header ('## [x.y.z]') found in CHANGES.md"
set -l hdr_lineno (string split -f1 ':' -- $hdr)
set -l hdr_version (string match -rg '^[0-9]+:## \[([^]]+)\]' -- $hdr)

set -l header_needs_fix 0
test "$hdr_version" != "$relver"; and set header_needs_fix 1

# ── Extract the top-most release section body as the release notes ───────────
# Everything between the first release header ('## …') and the next one; the
# '###' Added/Fixed/Changed subsections belong to the section. Leading/trailing
# blank lines trimmed.
set -l notes_file (mktemp)
awk '
    /^## / { hdr++; if (hdr == 1) next; if (hdr == 2) exit }
    hdr == 1 { print }
' CHANGES.md | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac >$notes_file
test -s $notes_file; or echo "release: warning — top CHANGES.md section is empty" >&2

# ── Plan ─────────────────────────────────────────────────────────────────────
echo
_step "Release plan"
echo "  version  : $relver"
echo "  branch   : $branch  → push to origin"
echo "  commit   : \"release v$relver\""
echo "             stages package.json manifest.json versions.json CHANGES.md — commits whichever changed"
if test $header_needs_fix -eq 1
    echo "  CHANGES  : retitle top header [$hdr_version] → [$relver]"
else
    echo "  CHANGES  : top header already [$relver]"
end
echo "  artifacts: main.js styles.css manifest.json"
echo "  notes    : top CHANGES.md section ↓"
sed 's/^/             │ /' $notes_file
echo

if test $dry_run -eq 1
    set_color yellow; echo "dry run — no changes made"; set_color normal
    rm -f $notes_file
    exit 0
end

if test $assume_yes -eq 0
    read -l -P "Proceed with commit, push, build, and GitHub release? [y/N] " ans
    if not string match -qir '^y(es)?$' -- $ans
        rm -f $notes_file
        _die "aborted by user"
    end
end

# ── 1. Sync CHANGES.md top header to the version ─────────────────────────────
if test $header_needs_fix -eq 1
    _step "Retitling CHANGES.md top header → [$relver]"
    sed -i "$hdr_lineno s/^## \[.*\]/## [$relver]/" CHANGES.md; or begin
        rm -f $notes_file; _die "failed to edit CHANGES.md"
    end
end

# ── 2. Commit ────────────────────────────────────────────────────────────────
_step "Committing release v$relver"
git add package.json manifest.json versions.json CHANGES.md; or begin
    rm -f $notes_file; _die "git add failed"
end
if git diff --cached --quiet
    echo "release: nothing staged to commit — assuming already committed, continuing"
else
    git commit -m "release v$relver"; or begin
        rm -f $notes_file; _die "git commit failed"
    end
end

# ── 3. Push ──────────────────────────────────────────────────────────────────
_step "Pushing $branch to origin"
git push origin $branch; or begin
    rm -f $notes_file; _die "git push failed"
end

# ── 4. Build artifacts ───────────────────────────────────────────────────────
_step "Building release artifacts (npm run build)"
npm run build; or begin
    rm -f $notes_file; _die "build failed"
end
for f in main.js styles.css manifest.json
    test -f $f; or begin
        rm -f $notes_file; _die "missing release artifact: $f"
    end
end

# ── 5. GitHub release ────────────────────────────────────────────────────────
# Tag = version (no 'v' prefix, matching package.json); created at the just-pushed
# commit. Title = version. Notes = the top CHANGES.md section.
set -l target (git rev-parse HEAD)
_step "Creating GitHub release $relver"
if not gh release create $relver main.js styles.css manifest.json \
        --target $target \
        --title "$relver" \
        --notes-file $notes_file
    rm -f $notes_file
    _die "gh release create failed (commit/push succeeded — rerun once resolved)"
end

rm -f $notes_file
set_color --bold green; echo "✔ Released $relver"; set_color normal
echo "  https://github.com/bobhy/vault-share/releases/tag/$relver"
