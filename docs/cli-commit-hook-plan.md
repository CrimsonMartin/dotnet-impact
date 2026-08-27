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

**Constraint: the VS Code extension's behavior stays exactly as-is.**
`Runner.changedFiles()` is shared — the extension's *Run affected tests now* command
calls it with no arguments (`extension.ts` → `runAffectedNow`). Every selection
change below is therefore scoped to the CLI path only: a CLI-only entry point (new
method or options object that only `cli.ts` passes), never a change to the shared
default.

## Design principle: right by default, no new flags — within the CLI's cost model

Each context has an *ideal* changed-set (staged files for pre-commit, `HEAD~1` for
post-commit verification, `origin/main...HEAD` for pre-push/CI, the just-edited
files for an agent's inner loop). A **superset is always correct** — the map
collapses files to test classes and dedup drops double-runs — so one smart default
can contain every context's right answer, and the two existing flags become
narrow-down overrides. (A `--diff` pass-through flag was considered and dropped as
subsumed.)

But correct is not free here: warm sessions, hot-patch, and pre-warmed testhosts
live in the extension — `cli.ts` never wires `runner.sessions`, so every CLI
invocation pays build + plain `dotnet test` per affected project. The smart default
therefore targets the contexts where the superset matches the question anyway:
**pre-push, CI, and post-commit agent verification**. Speed-sensitive **pre-commit
hook recipes recommend `--staged`** (or the positional-args form below), not the
default.

### 1. Default changed-set = committed branch diff ∪ dirty tree (CLI only)

`impact run` / `impact affected` with no flags selects from:

1. **Committed work on this branch**: auto-detect the base, then take
   `git diff --name-status -z <base>...HEAD` — git's three-dot form, which by
   definition diffs `merge-base(base, HEAD)` against `HEAD`, i.e. what *this branch*
   changed, not what base moved on. One spelling: the implementation must not also
   compute a merge-base and stack a second range on top. `--name-status` (not
   `--name-only`) so both sides of a rename feed selection, matching the status
   path's `parseStatusZ` handling.
2. **Uncommitted work**: the existing `git status --porcelain --untracked-files=all`
   union, unchanged.

Base auto-detection, in order: the branch's `@{upstream}` if set; else `origin/HEAD`
if resolvable; else **probe** `origin/main` then `origin/master` for existence; else
none. The probe matters: `origin/HEAD` only exists after a clone or an explicit
`git remote set-head`, so locally-inited repos — a primary target — would otherwise
silently degrade.

Degradations are all safe: no resolvable base → status only (today's behavior);
branch not ahead of base (merge-base == HEAD, e.g. just after a pull on the default
branch) → committed part empty → today's behavior; detached HEAD → status only
unless an upstream resolves.

Flag semantics:

- `--base <ref>` — overrides auto-detection and is **realigned to the same
  semantics**: `<ref>...HEAD` ∪ dirty tree. Today's meaning ("ref vs working tree",
  which also pulls in drift committed *on* the base since the fork point) is
  dropped now, pre-1.0, so the explicit and auto-detected paths can't diverge.
  CLI-only; the extension never passes a base.
- `--staged` — unchanged: the tight, index-only mode, and the recommended mode for
  pre-commit hooks.

Trade-off, stated honestly: on a long-lived branch the default set is larger than a
per-context minimum. Mitigations exist (`--staged`/positional args for hooks,
failure-first ordering); if it bites in practice, a "last validated commit"
watermark is the future optimization — not a new flag.

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

Path forms differ by caller — lint-staged passes absolute paths, pre-commit.com
repo-relative — and `computeAffected` already normalizes both. Parsing note: the
current `arg()`/`has()` helpers scan argv blindly (`arg()` returns whatever follows
the flag), so positional support requires a real parse that separates value-taking
flags from trailing paths.

### 3. Hook safety: cold start and concurrent invocations

Two failure modes appear the moment the CLI runs inside `git commit`, and the plan
takes one principle for both: **exit 1 means affected tests failed — nothing else
blocks a commit.**

- **Cold start.** The first-ever run creates the shadow worktree and builds the
  solution — minutes, inside a hook. Stance: when no map/shadow exists, `run` and
  `affected` print a warning to stderr ("no impact map — run `impact build-map`
  first") and **exit 0** rather than hijack the commit. `build-map` remains the
  explicit, foreground way to pay the cold cost (overnight / background, per the
  README).
- **Concurrency.** lint-staged parallelizes hook commands, and a CLI invocation can
  race the extension's background map refresh; nothing serializes shadow access
  across processes today. Add a lock file in the repo's cache dir
  (`~/.impact/<repo>-<hash>/`; implementation uses `cacheDirFor()`, never a
  literal path): wait briefly for the holder, then bail with a
  clear "another impact instance holds the shadow — skipped" message and exit 0 in
  the same never-block spirit. Residual risk, named: the lock is CLI-side only —
  the extension is pinned (see the constraint above) and does not take it, so a
  CLI invocation can still race the extension's background refresh. CLI-vs-CLI
  (the lint-staged case) is fully covered; extension adoption of the same lock
  file is a follow-up outside this plan.

### 4. `--staged` selects from the index but tests run against the working tree

The shadow worktree is `HEAD` + a file-copy overlay of the **working tree**
(`syncOverlay` copies `git status` dirty files), not the index. With partial
staging, `impact run --staged` picks tests from staged files but executes unstaged
code — a hook can green-light a commit whose actual staged content was never run.
This is the exact problem pre-commit.com engineered its stash-unstaged behavior
around.

Decision: **document, don't solve yet.** Agents stage everything, so index ==
worktree in the primary use case. Revisit as an index-snapshot overlay
(`git checkout-index` based) only if it bites.

### 5. Exit codes are the contract; stdout is not

The machine-readable contract is the exit code — hooks and agents branch on it.
Stdout stays human-oriented and free to change between versions (no stability
promise), and `--json` stays deferred until there's concrete demand.

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `run` | affected tests passed — or nothing affected, or no map yet (see §3) | test failure, or internal error | usage |
| `affected` | selection printed (possibly empty) | internal error | usage |
| `build-map` | map built (per-class mapping failures are reported, not fatal) | internal error | usage |
| `status` | stats printed | internal error | usage |

## Out of scope (unchanged)

- Save-watching in the CLI — that's the extension's job.
- Any change to the VS Code extension's selection behavior (see the constraint above).
- Solving reflection/DI blind spots — documented in the README, fallback covers it.
- The `run` execution pipeline (shadow build, warm sessions, hot-patch) — selection
  is the only thing changing here.

## Implementation order

1. CLI-only default changed-set: base auto-detection (`@{upstream}` → `origin/HEAD`
   → probe `origin/main`/`origin/master` → none) + three-dot committed diff unioned
   into a CLI-scoped selection path; `--base` realigned to `ref...HEAD ∪ dirty`.
   The extension's `changedFiles()` call is untouched. *(core of this plan)*
2. Positional file arguments on `affected` and `run`, with the argv parse split
   (value-taking flags vs trailing paths).
3. Hook safety: no-map/no-shadow early exit 0 + cross-process shadow lock file.
4. README: hook recipes — pre-commit via lint-staged / pre-commit.com (positional
   args or `--staged`), pre-push using the no-flag default — the staged-vs-worktree
   caveat note, the exit-code table, and a suggested `CLAUDE.md`/agent-docs snippet
   ("after editing run `impact run <files>`; after committing run `impact run`") so
   agents discover the workflow.

Each step is independently shippable; 1 makes pre-push, CI, and post-commit agent
verification work with no flags at all, and 3 is required before recommending the
CLI inside `git commit`.
