# Changelog

## Unreleased

- The static map now records, per test class, the source files of directly
  referenced interfaces and abstract classes (first step of the self-tuning
  map, #31): this is the attribution surface for dynamic edges that static
  analysis cannot see (DI bindings, reflection), and the helper's type index
  lets the extension resolve type names found in DI registration calls back
  to files. No behavior change yet — the data is collected, not consumed.
- Every coverage refresh now mines the gap between measured and static
  coverage (the Δ): each file a run executes that the static closure missed
  is attributed to the abstractions the class references, and the resulting
  binding edges (e.g. `IService.cs ⇒ ServiceImpl.cs`) are recorded in a
  per-repo store with confirmation/contradiction evidence. The store is
  collected, not yet consumed — selection changes land with the query-time
  application.
- Selection now applies the learned binding edges: editing a file that a
  binding points at selects every unmeasured test class that references the
  binding's abstraction — the transfer effect the per-class hybrid could not
  produce (a DI implementation edit now runs tests that were never
  coverage-measured). Measured rows stay ground truth and are never
  extended. `dotnetImpact.learnedBindings` (default on) turns the tier off;
  the CLI gets it for free since selection is shared.
- Fallback suppression is earned, not assumed. A "covered" file (one that
  stops triggering project-level fallback) is the ONE place a learned edge
  can reduce selection, so the rule is: a mined edge — which credits every
  abstraction the class references and may land on the wrong one — selects
  classes from the first confirmation but covers its target only from the
  SECOND (`MINED_CONFIRM_TO_COVER`); a parsed registration seed names its
  types precisely and covers immediately. In practice this is invisible in
  the common case (the evidence class's measured row still names the target
  file, so the fallback never triggers at all); it bites only when the
  target leaves every row — e.g. right after a refactor re-measured the
  evidence class — and then the pre-#31 fallback (whole project) still runs
  until the second confirmation. No under-selection is possible at any
  stage.
- Map builds now also SEED bindings from statically-visible DI
  registrations in source (`AddScoped<IService, ServiceImpl>()` and the
  `TryAdd*`/`AddSingleton`/`AddTransient`/Autofac `RegisterType` family,
  plus the `AddScoped<I>(new Impl())` form), resolved against the static
  map's type index — the transfer effect works on a fresh repo with zero
  test runs. Mined evidence wins over seeds; ambiguous or unresolvable type
  names yield no edge. Factory-lambda and convention-based registrations
  remain mining's job.
- Idle refresh passes now actively learn: when the queued refreshes are
  drained, the pass samples the unmeasured classes whose measurements would
  teach the most — unmeasured classes that reference abstractions with no
  binding AND no measured reference, scored by how many unmeasured classes
  share each abstraction (measuring one resolves it for all of them),
  budget 20 per drain (`Runner.learningBudget`), deterministic order. The
  samples flow through the existing low-priority warm pipeline and a
  foreground run still preempts them; sampling stops once every abstraction
  is resolved, and it honors the `dotnetImpact.learnedBindings` switch.
- Map builds now maintain the store: edges unseen for 30 days decay out,
  and edges whose abstraction or target file no longer exists in the tree
  are pruned (dead paths from refactors). `impact status` reports the store
  size with a mined/parsed breakdown when non-empty. Edges are evidence, not
  facts: the mining baseline is the PREVIOUS row of any source (static on
  first measurement, the previous coverage row on re-measurements), so a
  changed world both contradicts stale edges (target no longer hit) and
  attributes freshly-appearing files to new ones in the same measurements;
  `contradicts >= 4 && contradicts > 2*confirms` drops an edge and reverts
  selection — pinned by an e2e that flips the fixture's convention-based
  registration to a second implementation and watches the learned edge die
  and the fallback return while the new reality is learned.
- `Runner.resyncShadow()` re-mirrors the real repo's uncommitted state into
  the shadow worktree (used by the contradiction e2e after an out-of-band
  edit; the watch path will use it too).

## 0.4.2

- Changes made while VS Code was closed are now detected at startup (#33):
  Impact records a digest of the source tree and, on activation, re-walks
  and diffs it — edits, additions and deletions that landed from another
  editor, a `git pull`, or a branch switch trigger the affected tests and
  their rebuild, instead of the tree sitting on the previous session's
  verdicts until the next save. A cold cache records a baseline rather
  than treating everything as changed, edits already tested in a session
  don't re-fire at the next startup, and `dotnetImpact.watchExternalChanges`
  (which governs the same "changes Impact didn't cause" story in-session)
  turns it off.

## 0.4.1

- Fixed the class icon staying green when a failed build skipped its tests:
  the explorer's class rollup treated "no failures" as passed, so an
  all-skipped class got an explicit green check painted over its grey
  method rows. The rollup now distinguishes skipped from passed — a class
  whose every method skipped shows grey, one where anything really ran
  and nothing failed shows green, and any real failure stays red.

## 0.4.0

- Compile errors now surface as red squigglies in the editor — no C# Dev
  Kit needed. Every failed build's msbuild output is parsed into VS Code
  diagnostics with exact spans (previously that output was silently
  discarded on the minimal-build path), and on the hot-patch fast path the
  resident Roslyn session returns structured diagnostics with a refused
  save, so squigglies land in ~100ms without waiting for a build. Rude
  edits (valid C# the runtime can't hot-patch) never squiggle. Diagnostics
  clear per project on its next clean build or clean delta emit, so they
  can't go stale — and warnings survive a green build (a clean compile's
  output is parsed too, not discarded). `dotnetImpact.surfaceBuildWarnings`
  defaults to `auto`: warnings squiggle only when the C# extension isn't
  installed, since its language server already shows them live and doubling
  up would duplicate markers (`on`/`off` override). The status bar
  now says `✗ build failed (N errors)` instead of the misleading
  `✗ 0 failing` when a run dies in the compiler.

- Tests no longer run against stale binaries after a failed build: a test
  project whose build (or a dependency's) fails has its affected tests
  reported as skipped ("build failed") — grey in the explorer, never a
  stale green — while unrelated projects that still build keep running
  for real. Failure-first ordering ignores the skips, and coverage runs
  skip the same way so stale hits can't poison the map.

- Failed tests now carry an inline annotation at the failing assert line:
  the TRX stack trace is resolved to the first frame inside the repo
  (shadow-worktree paths mapped back to the workspace) and attached as the
  test message's location.

## 0.3.0

- Solution-wide Edit and Continue (#22): all loaded projects now share one
  Roslyn workspace with metadata references rewired into project
  references, so a single save that spans projects — a signature change in
  a library plus its call-site fixes — hot-patches every touched module in
  one emit instead of falling to the build path. The API-surface guard
  relaxes only for projects whose transitive dependents are all loaded in
  the session (computed from the project graph); anything less refuses
  exactly as before. Mid-epoch reloads are refused (a restarted session
  would re-baseline from disk behind the hosts' committed generation) and
  the delta reply is now uniformly `updates[]`, one entry per module.

- Microsoft Testing Platform support (#23): MTP-native test projects
  (xunit v3 with `UseMicrosoftTestingPlatformRunner`, and MSTest 4+) get
  their own warm server-mode sessions with hot patching, per-test
  attribution, and coverage — full parity with the VSTest path. Benchmarked
  on the same xunit v3 suite, MTP-native warm saves land in ~200ms vs
  ~1.3s through the VSTest adapter; xunit v3's VSTest adapter runs test
  code in an unhooked child process and can never take a hot patch, so
  MTP is the recommended shape for xunit v3 projects. MSTest 3.x runs
  under MTP with run-level results (per-test attribution needs 4+).
  Projects without a warm session fall back to `dotnet test` execution
  with the fast path off.

- CI integration (#24): `impact run --ci` makes a pipeline fail (exit 1)
  where hook safety would soft-skip — a cold map or a held shadow lock —
  so a PR job can never green-light untested code; local hook behavior is
  unchanged. `impact affected --format json` emits a machine-readable
  selection (`mapReady`, `classes`, `projects`, `changedFiles`) for
  workflow branching, and `impact build-map --if-missing` is the cached-CI
  no-op warmer. `docs/ci.md` carries a complete GitHub Actions recipe
  (map cached across runs, affected-only PR builds, full-suite fallback).

- Fixed a silent-green in repos without a `.gitignore` (#28): untracked
  `bin`/`obj` output mirrored into the shadow worktree could get picked up
  as the hot-patch baseline, whose PDB matched no source document — the
  save then "passed" without any code applied. Build-output directories
  are never mirrored now, and the delta service refuses any baseline
  whose PDB documents match nothing in the loaded compilation.

- Fixed NUnit and MSTest test discovery returning empty when the adapter
  lists bare display names: fully qualified names are now recovered via
  `vstest --ListFullyQualifiedTests`, restoring class-level selection for
  both frameworks. Also fixed `--parallel` silently accepting non-numeric
  values.

## 0.2.10

- Affected runs now also trigger on external file changes (#10): `git
  checkout` / `pull` / `revert`, scripts, or another editor writing source
  files fires the same affected-test pipeline as an editor save. A file
  with unsaved editor changes is left alone (the explicit save stays its
  trigger); a save's own watcher echo never double-triggers; and batchy git
  operations collect under a longer rolling debounce
  (`dotnetImpact.externalDebounceMs`, default 1s) so a pull touching
  hundreds of files becomes one run — which for large sets naturally
  approaches a full run via the map's fallback machinery. Git-driven
  structural changes usually land on the minimal-rebuild path (seconds),
  not the hot-patch loop. `dotnetImpact.watchExternalChanges` (default on)
  turns it off.

## 0.2.9

- Live map refresh is ~3x faster per class (#3): coverage is now collected
  through a resident `dotnet-coverage` server session with statically
  instrumented copies of the built test outputs running on a dedicated warm
  testhost fleet — measured ~0.5s per class against ~1.7s for the classic
  `dotnet test --collect` spin-up. The instrumented copies never share
  hosts with the hot-patch fast path (rewritten IL can't take EnC deltas),
  are re-mirrored automatically after every rebuild, and any failure at any
  stage (tool unavailable, instrument/server/snapshot error) falls back to
  the classic per-class collector run. The `dotnet-coverage` tool installs
  itself on first use; `dotnetImpact.warmCoverageRefresh` turns the
  pipeline off.

## 0.2.8

- Hot-patch capability handshake (#11 P2): every testhost now reports its
  runtime's actual hot-reload capability set
  (`MetadataUpdater.GetCapabilities()`) when it registers, and delta
  generation is gated on the intersection across the live fleet instead of
  an assumed modern-CoreCLR list. Edits a runtime can't apply are refused
  up front with the engine's own ENC reason and fall to the build path,
  rather than emitting deltas that would die inside the host.

- Multi-file saves hot-patch as one unit (#11 P3): all changed files of a
  project now enter a single Edit-and-Continue emit, so interdependent
  edits — a method added in one file, called from another — patch together
  where per-file emission used to refuse them and rebuild.

- The extension now takes the cross-process shadow lock (#8) around its
  shadow-mutating phases (runs, coverage runs, discovery, map build and
  refresh), closing the race with CLI hook invocations (lint-staged,
  pre-commit). Waits are abortable — a newer save supersedes a run still
  queued on the lock — and background work skips rather than camps when a
  CLI process holds the shadow. The lock is re-entrant within a process,
  so the extension's own overlapping phases behave exactly as before.

## 0.2.7

- Fixed a save that could stay silently GREEN after a breaking edit. Any
  build that bypassed the baseline snapshot (test discovery's solution
  build, a manual `dotnet build`) rewrote the shadow dll+pdb while the fast
  path kept loading the previous complog; Roslyn's EnC engine then held
  every baseline document out-of-sync and answered each edit with "no
  changes to apply", which the runner treated as a benign no-op — saves
  reported `fastpath=hit ... 0 delta(s)` while warm testhosts kept running
  the pre-edit assembly. The delta service now verifies the complog's
  source checksums against the dll's PDB at load and refuses a mismatched
  pair ("baseline mismatch"), a "no changes" verdict carrying an ENC
  diagnostic is refused instead of swallowed, and no-op saves log the
  engine's reason. Refusals fall to the build path, which rebuilds and
  re-snapshots a coherent baseline. Regression-tested at both layers: the
  mismatched-pair refusal in the delta service, and the full README-gif
  scenario (real git repo, real builds, warm testhosts) asserting a
  breaking edit always turns the affected test red.

- New README demo GIFs, re-recorded with the mouse cursor parked out of the
  way of the edits.

## 0.2.6

- Fixed stale assemblies after an edit raced the shadow sync (#16): a save
  landing between the overlay sync and the incremental build's freshness-stamp
  read was recorded as built even though the compiled shadow source predated
  it. The project then looked up to date forever while dependents rebuilt
  against members its binary didn't have, surfacing as a misleading
  `MissingMethodException` deep in a dependent project's tests. Stamps (and
  discovery-cache rows) are now recorded only when every source file predates
  the sync; a raced edit costs a single extra project build on the next run
  instead of a stale-binary run.

## 0.2.5

- Fixed stale entries lingering in the Test Explorer after a test class was
  moved or deleted (most visible on Windows): moving a class into a subfolder
  kept its old namespace in the pane, because the freshness stamp saw an
  unchanged file count and mtime and skipped re-discovery, while the impact
  map kept resurrecting the dead class on every tree rebuild. The stamp now
  folds in a digest of project-relative paths, discovery prunes the map (and
  lastFailures) as it goes, and results for methods that no longer exist are
  dropped so replay stops reporting phantom outcomes. Pruning is guarded: a
  discovery that succeeds but lists nothing never wipes a project's rows.

## 0.2.4

- Fixed a race that could abort a full run with "file not found" (most likely
  on Windows): scanning for built test dlls while MSBuild was still replacing
  outputs threw when a dll vanished between the directory listing and its
  stat. A vanished file is now treated as absent, and a dependency copy that
  loses the same race is skipped with a log line instead of failing the run.

## 0.2.3

- Test Explorer no longer shows duplicate, empty project entries when the repo
  contains git worktrees (e.g. Claude Code's `.claude/worktrees/`) or nested
  clones — the project scan now stays out of directories that are their own
  git repository.
- Non-`.cs` saves after a rebuild no longer fail with "complog … being used by
  another process": snapshot evicts the warm EnC session holding the old
  baseline before rewriting it, so the fast path recovers instead of falling
  back to full builds forever.
- Static impact map: enum and const-only files now map to the tests that use
  them (name-graph union), with a god-type cap to keep hub types from pulling
  in everything.
- Session runner correctness: abandoned test-host starts are swept, helper
  logs are forwarded, and multi-TFM test projects run every framework's tests.

## 0.2.2

- Adding a new test method (`[Fact]`, `[Theory]`, NUnit, MSTest) now takes one
  clean rebuild so the test runner discovers it immediately — hot-patching a
  new test was invisible to discovery. Body edits, helper methods, and new
  `[InlineData]` cases stay on the ~50ms hot path.

## 0.2.1

- README: demo GIFs recorded from real sessions — save-to-red-to-green, and
  adding a brand-new method as a hot patch.

## 0.2.0

- Hot patching now runs on Roslyn's Edit-and-Continue engine (the one behind
  `dotnet watch` hot reload): added methods, fields, types, and lambda edits
  hot-patch into live test hosts — not just method bodies. Rude edits log
  their ENC diagnostic as the fallback reason.
- API-surface guard: a changed or removed public/internal signature always
  rebuilds, so dependent test assemblies can never stay green against an API
  that no longer compiles.

## 0.1.9

- Windows: the delta service no longer holds baseline dlls open (file-lock
  build failures), pre-build session release now sweeps every warm session,
  and MSBuild terminal-logger escape codes are kept out of captured output.

## 0.1.8

- Fixed a silent init crash on fresh installs that permanently disabled the
  fast path (every save paid a full build + cold test host).

## 0.1.7

- The timing line now says why the fast path was not attempted
  (`fastpath=off(...)`), and activation logs a hot-patch ready/unavailable
  verdict.

## 0.1.6

- Repaired the hot-patch fast path: no-op builds no longer poison the
  baseline, Windows no longer kills warm hosts before trying to patch,
  preloaded baselines survive, and a restarted test host can't silently run
  stale code. Every run logs `timing: fastpath=... build=... tests=...`.

## 0.1.5

- Running icons spin down to the method level; run-all spins exactly what it
  executes.

## 0.1.4

- Test Explorer pre-populates method items at discovery time — class
  dropdowns are filled on startup, no run needed.

## 0.1.1 – 0.1.3

- Coverage run profile (native VS Code coverage view).
- Non-default profile when C# Dev Kit is present (no double Run All).
- Subset runs settle the counter at all/all without flashing queued icons.

## 0.1.0

- First marketplace release: affected-test selection from an IL impact map,
  shadow-worktree builds, warm test sessions, hot-patched saves, CLI for
  pre-commit hooks and agents.
