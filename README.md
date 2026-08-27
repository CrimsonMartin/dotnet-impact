# Impact

NCrunch-style **affected-test selection** for .NET in VS Code — free and open source. (Extension and CLI: **Impact**.)

Builds a static IL-based impact map (which test classes relate to which source files)
in seconds inside a background **git worktree shadow**, refines it with measured
coverage as tests run, and on every save runs *only the tests affected by your
change*, reporting results through VS Code's native Test Explorer. The same core
ships as a CLI for pre-commit hooks and AI coding agents, where a full CI run is too
expensive per commit.

## How it works

1. **Shadow worktree** — `git worktree add` gives a full checkout sharing the object
   store (near-instant, no duplicate history). Uncommitted edits are mirrored on top as
   a file-copy overlay, so background builds/test runs never touch your working tree and
   its warm `bin`/`obj` never collide with your editor's builds.
2. **Impact map** — built statically in seconds: the built assemblies' IL metadata
   and portable PDBs yield each test class's transitive type-reference closure as
   source files (`source file → test classes that could reach it`). Rows are tagged
   `static`, and the live-refresh pipeline replaces them with measured per-class
   coverage as tests actually run — converging on observed truth, including
   DI/reflection edges static analysis can't see. Class-level granularity throughout.
3. **Affected set** — on save (or per commit), changed files are looked up in the map.
   Mapped files → run just those test classes (`dotnet test --filter`). Unmapped files →
   conservative fallback: run every test project that transitively references the
   changed file's project (computed from the `ProjectReference` graph).

Live map refresh uses the Microsoft.CodeCoverage collector (bundled with
`Microsoft.NET.Test.Sdk`) — block-level instrumentation, much faster than Coverlet —
and falls back to `coverlet.collector` automatically where it's unavailable. Map
building itself is static analysis and needs no collector; running affected tests
works regardless.

## VS Code extension

Native Test Explorer integration via the `TestController` API — no custom UI:

- **Continuous run** — toggle the "eye" on the *Affected tests* profile and affected
  tests re-run on every `.cs` save (also available as plain auto-run-on-save via
  `dotnetImpact.autoRunOnSave`). A save during a run supersedes it: the in-flight run
  is cancelled and its files fold into the new one.
- **Persistent test sessions** — a small shipped helper (built once on first use)
  keeps vstest.console and pre-warmed testhosts alive between runs, so an
  incremental run costs milliseconds of dispatch instead of seconds of process
  startup. Sessions are freshness-checked against the build output (never run
  stale assemblies) and everything falls back to plain `dotnet test` when
  unavailable (`dotnetImpact.persistentTestSessions`).
- **Live map refresh** — after each affected run, coverage is re-collected for the
  classes that ran (low-priority, background), so map rows track your code as it
  changes instead of going stale (`dotnetImpact.liveMapRefresh`). Full map builds
  also prune entries for deleted test classes/projects.
- **Automatic map build** — on workspace open, any test classes missing from the map
  are mapped in the background (status-bar progress; disable via
  `dotnetImpact.autoBuildMap`). `Impact: Build impact map (background)` runs
  the same thing on demand with a cancellable progress notification.
- `Impact: Run affected tests now` — affected set for the current dirty files.
- Status bar shows the last run's result.

## CLI (pre-commit hooks / agents)

```
impact build-map [--refresh]      # build or refresh the map (run overnight / in background)
impact affected [--base <ref>] [--staged]   # print affected test classes
impact run [--base <ref>] [--staged]        # run affected tests; exit 1 on failure
impact status
```

Pre-commit hook (`.git/hooks/pre-commit`):

```sh
#!/bin/sh
node /path/to/dotnet-impact/out/cli.js run --staged || exit 1
```

For an AI coding agent, `impact run` after each edit gives sub-minute feedback
scoped to the blast radius of the change, instead of a full CI cycle.

## Known blind spots (by design, documented not solved)

- Reflection / DI indirection: coverage maps observed execution; a config change that
  reroutes DI can affect tests the map doesn't predict. Unmapped/non-`.cs` files fall
  back to project-level selection.
- `.csproj` / config edits trigger the project-graph fallback, not the map.
- Map rows go stale for code you aren't touching; they refresh as their tests re-run.

## Development

```
npm install
npm run compile     # or: npm run watch
npm test            # unit tests (node --test) over the parsing/selection core
```

Launch the extension with F5 (Extension Development Host). The shadow worktree and map
live under `~/.impact/<repo>-<hash>/` — delete that folder to reset everything
(then `git worktree prune` in the repo).
