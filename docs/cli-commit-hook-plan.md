# CLI plan: pre-commit hooks and AI coding agents

The CLI (`impact affected` / `impact run`) is the interface for two consumers that
don't sit inside VS Code: git hooks (pre-commit, pre-push) and AI coding agents that
want sub-minute, blast-radius-scoped test feedback per edit or per commit. This
document records what change-selection the CLI supports today (verified against
`src/cli.ts` and `src/core/runner.ts`), where it falls short for those consumers,
and what we add.

## Current state (verified)

Change selection is already git-based — the CLI never watches file saves; save
triggering exists only in the VS Code extension. `Runner.changedFiles(base?, stagedOnly)`
supports three modes:

| Invocation | Git source of changed files |
|---|---|
| `impact run` (no flags) | `git status --porcelain --untracked-files=all` — all uncommitted changes, untracked included |
| `impact run --staged` | `git diff --name-only --cached` — the index only |
| `impact run --base <ref>` | `git diff --name-only <ref>` (ref vs working tree) **unioned with** full `git status` |

So the README's pre-commit hook (`impact run --staged`) already selects tests from a
git diff. What's missing is below.

## Gaps for hooks and agents

### 1. No committed-only diff — can't express "base..HEAD, ignore the dirty tree"

Every current mode folds in working-tree state: `--base <ref>` diffs the ref against
the *working tree* and additionally unions in `git status`. There is no way to ask
"which tests are affected by the commits between `origin/main` and `HEAD`?" while
ignoring uncommitted noise. That's exactly the question asked by:

- a **pre-push hook** (validate what's being pushed, not what's half-edited),
- an **agent verifying a commit it just made** (post-commit check),
- **CI** running affected-only on a PR branch.

**Add: a pass-through git-diff option.**

```
impact affected --diff <args...>
impact run --diff <args...>
```

`--diff` consumes the rest of the argument list and passes it verbatim to
`git diff --name-only -z <args...>`, with **no** status union. Examples:

```
impact run --diff HEAD~1                 # tests affected by the last commit
impact run --diff origin/main...HEAD     # merge-base diff for the branch (pre-push)
impact run --diff --cached               # equivalent to --staged
```

Pass-through (rather than a curated `--committed-only` flag) keeps us out of the
business of re-modelling git's range semantics — two-dot, three-dot/merge-base,
`--cached`, `-M` rename detection all come for free, and agents already speak
`git diff`. `--diff` is mutually exclusive with `--base`/`--staged` (error out if
combined). Rename detection: pass `--name-status` internally instead of
`--name-only` so both sides of a rename feed selection, matching what the
status-based path already does via `parseStatusZ`.

### 2. `--staged` selects from the index but tests run against the working tree

The shadow worktree is `HEAD` + a file-copy overlay of the **working tree**
(`syncOverlay` copies `git status` dirty files), not the index. With partial
staging, `impact run --staged` picks tests from staged files but executes unstaged
code — a pre-commit hook can green-light a commit whose actual (staged) content was
never built or run. This is the classic pre-commit snapshot problem (`git stash -k`
territory).

Decision: **document, don't solve yet.** Agents stage everything before committing,
so index == worktree in the primary use case; humans doing partial `git add -p` on a
.NET repo are the rare case, and index-snapshot checkout into the shadow is a
meaningful chunk of work (overlay from `git checkout-index` instead of file copies).
Add a note to the README's hook section; revisit as an opt-in `--index-snapshot`
mode if it bites.

### 3. No machine-readable output

Agents parse stdout today. Add `--json` to `affected` and `run`:

- `affected --json` → `{ "changedFiles": [...], "classes": [...], "fallbackProjects": [...] }`
- `run --json` → the above plus `{ "ok": bool, "outcomes": [{ "method", "passed", "skipped", "message" }] }`

Human-readable output stays the default; progress/phase chatter already goes to
stderr, so stdout stays clean JSON under the flag.

### 4. Explicit file list

An agent that just edited three files shouldn't need the repo to be dirty in any
particular way:

```
impact affected --files src/A.cs src/B.cs
```

Bypasses git entirely and feeds `computeAffected` directly (it already accepts any
repo-relative or absolute list — the extension uses this path on save). Low cost,
high agent ergonomics.

## Out of scope (unchanged)

- Save-watching in the CLI — that's the extension's job.
- Solving reflection/DI blind spots — documented in the README, fallback covers it.
- The `run` execution pipeline (shadow build, warm sessions, hot-patch) — selection
  is the only thing changing here.

## Implementation order

1. `--diff` pass-through in `changedFiles` + CLI parsing + README (`pre-push` example
   alongside the existing pre-commit one). *(core of this plan)*
2. `--json` on `affected` and `run`.
3. `--files` explicit list.
4. README note on the staged-vs-worktree caveat (with item 1).

Each step is independently shippable; 1 is the one that unblocks pre-push hooks and
post-commit agent verification.
