# CLI plan: pre-commit hooks and AI coding agents

The CLI (`impact affected` / `impact run`) is the interface for two consumers that
don't sit inside VS Code: git hooks (pre-commit, pre-push) and AI coding agents that
want sub-minute, blast-radius-scoped test feedback per edit or per commit. This
document records what change-selection the CLI supports today (verified against
`src/cli.ts` and `src/core/runner.ts`), where it falls short for those consumers,
and what we change.

## Current state (verified)

Change selection is already git-based — the CLI never watches file saves; save
triggering exists only in the VS Code extension. `Runner.changedFiles(base?, stagedOnly)`
supports three modes:

| Invocation | Git source of changed files |
|---|---|
| `impact run` (no flags) | `git status --porcelain --untracked-files=all` — all uncommitted changes, untracked included |
| `impact run --staged` | `git diff --name-only --cached` — the index only |
| `impact run --base <ref>` | `git diff --name-only <ref>` (ref vs working tree) **unioned with** full `git status` |

The gap: every mode is anchored to the working tree. Nothing answers "what did the
commits on this branch affect?" — the question asked by a pre-push hook, an agent
verifying a commit it just made, and CI running affected-only on a PR branch. With
`--base`, uncommitted noise is always unioned in; with no flags, committed work is
invisible the moment it's committed.

## Design principle: right by default, no new flags

Each context has an *ideal* changed-set (staged files for pre-commit, `HEAD~1` for
post-commit verification, `origin/main...HEAD` for pre-push/CI, the just-edited
files for an agent's inner loop). But a **superset is always correct** — the map
collapses files to test classes, dedup drops double-runs, failure-first ordering and
warm sessions make overlap cheap. So instead of a flag per context (`--diff`
pass-through was considered and dropped), we make the default set a superset that
contains every context's right answer, and keep the two existing flags as
narrow-down overrides.

### 1. Default changed-set = committed branch diff ∪ dirty tree

`impact run` / `impact affected` with no flags selects from:

1. **Committed work on this branch**: auto-detect the base — the branch's
   `@{upstream}` if set, else `origin/HEAD` (the remote default branch), else none —
   and take `git diff --name-only -z <merge-base(base, HEAD)>..HEAD` (three-dot
   semantics: what *this branch* changed, not what base moved on). Rename origins
   included via `--name-status`, matching what the status path already does.
2. **Uncommitted work**: the existing `git status --porcelain --untracked-files=all`
   union, unchanged.

Degradations are all safe: no upstream and no `origin/HEAD` → status only (today's
behavior, e.g. a fresh local-only repo); branch not ahead of base (merge-base ==
HEAD, e.g. just after a pull on the default branch) → committed part is empty →
today's behavior; detached HEAD → status only unless an upstream resolves.

This makes all the commit-granular cases work with **zero flags**:

- **post-commit verify** (agent just committed): the commit is in the branch diff.
- **pre-push hook / CI**: clean tree → exactly the merge-base range every
  affected-test system (Nx, Turborepo, dotnet-affected) is built on.
- **agent inner loop**: dirty tree still included, as today.

Existing flags become the narrow-down overrides, not additions:

- `--base <ref>` — overrides base auto-detection (and keeps its current
  "vs working tree" meaning for an explicitly chosen ref).
- `--staged` — the tight, index-only mode for speed-sensitive pre-commit hooks and
  partial staging; unchanged.

Trade-off, stated honestly: on a long-lived branch the default set is larger than a
per-context minimum, so a pre-commit hook on such a branch re-covers earlier branch
commits. Mitigations already exist (`--staged` for the hook, failure-first ordering,
warm sessions); if it bites in practice, a "last validated commit" watermark is the
future optimization — not a new flag.

### 2. Positional file arguments — the hook-framework contract, not a flag

```
impact run [file ...]
impact affected [file ...]
```

When positional paths are given, git inspection is skipped entirely and they feed
`computeAffected` directly (the same internal path the VS Code extension uses on
save). This is not ergonomic sugar: **lint-staged and pre-commit.com invoke hook
commands with the staged filenames as trailing arguments** — that's their interface.
Positional args make impact a drop-in entry for both:

```jsonc
// lint-staged
{ "*.cs": "impact run" }
```

```yaml
# .pre-commit-config.yaml
- repo: local
  hooks:
    - id: impact
      entry: impact run
      language: system
      files: \.cs$
```

They also give agents the tight inner loop ("I edited these 3 files, test their
blast radius") without depending on the tree being otherwise clean.

### 3. `--staged` selects from the index but tests run against the working tree

The shadow worktree is `HEAD` + a file-copy overlay of the **working tree**
(`syncOverlay` copies `git status` dirty files), not the index. With partial
staging, `impact run --staged` picks tests from staged files but executes unstaged
code — a hook can green-light a commit whose actual staged content was never run.
This is the exact problem pre-commit.com engineered its stash-unstaged behavior
around.

Decision: **document, don't solve yet.** Agents stage everything, so index ==
worktree in the primary use case. Revisit as an index-snapshot overlay
(`git checkout-index` based) only if it bites.

### 4. JSON output — deferred

Considered and parked: it can't be *default* behavior (changing stdout format breaks
existing consumers), agents parse the current text output fine, and the exit code
already carries the pass/fail contract. Revisit only on concrete demand; until then
treat the current stdout format as stable.

## Out of scope (unchanged)

- Save-watching in the CLI — that's the extension's job.
- Solving reflection/DI blind spots — documented in the README, fallback covers it.
- The `run` execution pipeline (shadow build, warm sessions, hot-patch) — selection
  is the only thing changing here.

## Implementation order

1. Default changed-set: base auto-detection (`@{upstream}` → `origin/HEAD` → none) +
   merge-base committed diff unioned into `changedFiles`. *(core of this plan)*
2. Positional file arguments on `affected` and `run`.
3. README: hook recipes (lint-staged / pre-commit.com pre-commit, pre-push), the
   staged-vs-worktree caveat note, and a suggested `CLAUDE.md`/agent-docs snippet
   ("after editing run `impact run <files>`; after committing run `impact run`") so
   agents discover the workflow.

Each step is independently shippable; 1 makes hooks, CI, and post-commit agent
verification work with no flags at all.
