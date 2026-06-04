# N-way text conflicts — the living reference

> **Status: Living (design).** Authoritative conceptual reference for how
> vault-share represents and combines unresolved text conflicts. Read this
> before [`src/sync/nway-merge.ts`](../src/sync/nway-merge.ts) and the conflict
> branch of [`conflict-resolver.ts`](../src/sync/conflict-resolver.ts). Replaces
> the original flat two-way `diff3` marker scheme described in
> [`merge.ts`](../src/sync/merge.ts).

## Why this exists

The original design wrote `diff3`'s two-way conflict markers into both the local
file and the group (Drive) file, recorded that *marked-up* text as the next
merge base, and re-ran `diff3` over it on the next pass. Because `diff3` treats
marker lines as ordinary text — and because the base/side content *inside* a
conflict block aliases the clean inputs — successive passes tore conflict blocks
apart at both the (non-unique) marker lines and the aliased content lines,
producing deeply nested, **unbalanced** marker soup that no longer parses (e.g.
3 `<<<<< local` against 5 each of the other markers). Three devices editing the
same region reach this state with no additional bug; more devices reach it
faster. See the June 2026 investigation thread.

The fix is a representation change plus one hard rule:

> **`diff3` is run only on clean text. Marker-bearing text is never fed to a
> three-way merge.** Once a conflict exists, it only ever **grows by union of
> distinct alternatives that share a common base**, with de-duplication.
> Anything that does not fit falls back to **keep-both**.

## Vocabulary

| Term | Meaning |
|------|---------|
| **Region** | One contiguous conflicted span of a file. A file may contain several disjoint regions separated by stable text. |
| **Base** | The common ancestor content of a region. Always present in a well-formed region (rule 1), labelled `base`. It is a *selectable* resolution target. |
| **Alternative** | One candidate version of a region's span, labelled `A1`, `A2`, … A region holds **N ≥ 2** alternatives plus the base. |
| **Contribution** | What a label names: one coherent *across-region* version introduced by a single fold. The same label is stamped in every region that fold touched, so "choose `A2` in every region" reconstructs the whole version it contributed. A label names a contribution, **not a device** — there are no client ids in the file. |
| **Stable text** | Lines outside any region — identical across every contributing version. |
| **Fold** | Combining two sides that share a base into the union of their alternatives, de-duplicated. The only conflict-growing operation. |
| **Mint** | Creating the first (two-alternative) region from two *clean* files via `diff3`. The only place `diff3` runs. |
| **Keep-both** | The fallback: rename the two sides to `…-conflict-<tag>-<ts>` copies and leave the namespace clean. Bounded, never garbles. |

## On-disk format (flat, N-way, base-carrying, labelled)

Markers are backtick-fenced so they render as inline code in Markdown and do not
collide with Markdown's own `=====` setext underline. Every segment is
introduced by a labelled separator — nothing is positional. One region:

```text
`<<<<< conflict`
`===== base`
…common ancestor lines…
`===== A1`
…A1's lines for this region…
`===== A2`
…A2's lines for this region…
`>>>>> conflict`
```

- Opens with `` `<<<<< conflict` ``, closes with `` `>>>>> conflict` `` — pure
  delimiters.
- `` `===== base` `` introduces the common ancestor (**exactly one per region**).
- `` `===== A1` ``, `` `===== A2` ``, … introduce the alternatives.
- No `local` / `group` labels: those are positional lies once a file lives on
  three+ devices. Labels are non-positional and device-agnostic.

There is **no nesting** — flatness plus backtick fencing is the entire
disambiguation.

**Well-formed** (else → keep-both): markers balance; exactly one `` `===== base` ``
per region; at least two alternative segments; every separator matches
`` `===== (base|A<n>)` ``; no marker appears inside another region's span.

### Labels are append-only and Drive-anchored

A label names a *contribution*, identified by **content, not by which device made
it** (no client ids). Labelling is append-only, not sorted:

- A fold **preserves the incoming (Drive) file's labels** and gives its own new
  contribution the **next free number**, chosen across *all* regions, placed
  **last** in each region the contribution touches. So existing labels don't
  churn, and the same `An` across regions denotes the same contribution — "choose
  `An` everywhere" yields a coherent whole-file version.
- De-dup is by **content**; the push decision is **set-based** — a device pushes
  only when its contributions add something Drive's set lacks. Drive's set
  therefore grows **monotonically** (pushes terminate), and on a no-op the result
  **adopts Drive's bytes**, so devices converge to the Drive anchor.

The only transient divergence — **documented for users** — is a device holding a
contribution it hasn't pushed yet, or two devices that folded concurrently and
briefly numbered their private additions the same; the first push wins the anchor
and the others adopt it. Numbers are handles, not durable ids.

## The single rule: fold by union of same-base alternatives

Model each side as `(base, [alternatives])`:

- a **clean** file is `(its sync-history base, [itself])`;
- an **N-way** file is `(its embedded base, [V₁ … Vₙ])`.

`reconcileText(base, local, remote)` (entry point in
[`nway-merge.ts`](../src/sync/nway-merge.ts)) returns one of:

| Outcome | When |
|---------|------|
| **clean** (no markers) | The two sides reduce to a single version (one side equals base / equals the other; or `diff3` of two clean files has no conflict). |
| **folded** (`changed: true`) | Same base, and the union adds ≥ 1 distinct alternative. |
| **folded** (`changed: false`) | Same base, but every alternative is already present — **idempotent no-op** (the anti-thrash guarantee). |
| **keepBoth** | Bases differ; a side is malformed/hand-mangled; a side's changes fall **outside** the region span; or region structure (span/count) cannot be reconciled. |

### Decision table

| local | remote | action |
|-------|--------|--------|
| clean | clean, both diverge from base, overlapping | **mint** 2-way via `diff3` (clean inputs only) |
| clean | clean, non-overlapping diverge | clean merge via `diff3` (no markers) |
| `local == base` | anything | clean: adopt remote (local is stale) |
| anything | `remote == base` | clean: adopt local (remote unchanged — a resolution drains here) |
| `local == remote` | — | clean: reconcile, no write |
| clean | N-way, **same base** | fold: add local as an alternative unless `local ∈ {base} ∪ alts` |
| N-way | clean, **same base** | fold: add remote as an alternative unless `remote ∈ {base} ∪ alts` |
| N-way | N-way, **same base & span** | fold: union the two alternative sets, de-duplicated |
| any | any, **base mismatch / malformed / out-of-span / span mismatch** | **keep-both** |

De-dup compares an alternative's span content (and the base) byte-for-byte.
Folding a clean file requires it to agree with the base on all stable text; its
divergence must lie **within** the region span, otherwise → keep-both.

## Propagation rules

- **Mint may push.** The merge-write that *creates* a conflict writes the marker
  file to both local and Drive — that is how the group first learns of it.
- **A distinct new alternative may push.** A *merge-write* that folds a genuinely
  new alternative (same base, not a duplicate) may write the grown N-way file to
  Drive. So a region's file is written to Drive **at most once per distinct
  alternative** — bounded, and idempotent folds never write.
- **User hand-edits of a marker file are held.** While a local file *contains
  markers*, user edits to it are **not** pushed (single-file or bulk) until the
  file is conflict-free. The plugin warns the user if they pause/blur with
  markers still present. Engine-authored writes (mint/fold) are exempt — only
  user-originated, still-conflicted saves are held.
- Net invariant: **markers reach the group only via mint or a distinct-alternative
  fold; a partially-hand-edited conflict never propagates; a fully resolved
  (clean) file propagates as an ordinary change.**

## Base management (the syncer's contract)

`reconcileText(base, local, remote)` uses `base` for two distinct jobs, and the
syncer must persist it accordingly:

- **Provenance** (the cheap equality short-circuits): `base` is the *last-synced
  content* for the path — so a device's stored base advances to whatever it last
  synced, **including N-way marker text** when it adopted a conflict. This is what
  makes a resolution drain: a resolver's Drive copy still equals its base, so
  `remote == base` fires and pushes the clean file; peers then see
  `local == base` and pull it. Without advancing base to the N-way content,
  resolutions would fold back in instead of draining.
- **diff3/localize ancestor**: a three-way merge needs *clean* ancestor text. When
  the stored base is itself N-way (the device last synced a conflict), the engine
  takes the ancestor from the base's **embedded `base` segment**, never the
  markers. This is what stops two devices that resolve *differently* from feeding
  a marker base to `diff3` — they re-conflict cleanly against the common ancestor
  instead of garbling. (See the two-clients-resolve-differently test.)

So the rule is **not** "base advances only on clean": base tracks the last-synced
bytes, and the engine derives a clean ancestor from them when needed.

## Navigation & resolution (find-next / find-previous)

- A **whole region is one stop**. Find-next/-previous step between regions, not
  between alternatives within a region.
- **Resolve chooses exactly one** segment of the region — one alternative **or the
  base** (the base is selectable) — and replaces the whole region with it,
  deleting the markers. A file becomes clean (and therefore pushable) once every
  region is resolved.
- Labels are the tool's **handles**: offering `base` / `A1` / `A2` / … lets the
  user pick "`A2` here" region-by-region, or "`A2` everywhere" to take one
  contribution's whole version at once.

## Invariants

1. **`diff3` only on clean text.** No marker-bearing string is ever an input to a
   three-way merge. (Kills both garbling causes; bounds conflict depth at "flat".)
2. **Conflicts only grow by same-base union.** Folding is idempotent over the
   contribution *set*; re-folding an already-present set adds nothing and pushes
   nothing. Drive's set grows **monotonically**, so it terminates, and no-op folds
   adopt Drive's bytes — devices converge to the Drive anchor.
3. **Well-formed or keep-both.** Any input that does not parse to balanced,
   base-carrying, non-overlapping regions is resolved as keep-both. There is no
   "best effort parse" that can lose a side.
4. **Round-trip.** `parse` then `emit` reproduces the file byte-for-byte;
   `emit` then `parse` reproduces the structure.
5. **Markers never travel up except as mint or a distinct new alternative.** A
   user-edited, still-conflicted file is held from push until clean.
6. **Resolution drains.** When a peer publishes a clean resolution, the local
   side reconciles to clean without re-minting (the `remote == base` /
   `local == base` short-circuits), so the group converges as devices resolve.

## Where this maps in code

| Concept | File |
|---------|------|
| Format grammar, `parse` / `emit`, `reconcileText`, fold/mint/de-dup | [`nway-merge.ts`](../src/sync/nway-merge.ts) |
| Conflict-branch routing (mint vs fold vs keep-both) | [`conflict-resolver.ts`](../src/sync/conflict-resolver.ts) (`resolveMerge`) |
| Hold-until-clean on user edits + warn | [`single-file-sync.ts`](../src/sync/single-file-sync.ts) (push-hold) |
| Merge preview for the pending-list editor | [`resolution-executor.ts`](../src/sync/resolution-executor.ts) (`computeMerge`) |
| Find-next/-previous, resolve-to-one-segment | [`conflict-marker-navigator.ts`](../src/ui/conflict-marker-navigator.ts) |
