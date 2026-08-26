# dotnet-impact

NCrunch-style **affected-test selection** for .NET in VS Code — free and open source.

Builds a coverage-based impact map (which test classes execute which source files) in a
background **git worktree shadow**, then on every save runs *only the tests affected by
your change*, reporting results through VS Code's native Test Explorer. The same core
ships as a CLI for pre-commit hooks and AI coding agents, where a full CI run is too
expensive per commit.

## How it works

1. **Shadow worktree** — `git worktree add` gives a full checkout sharing the object
   store (near-instant, no duplicate history). Uncommitted edits are mirrored on top as
   a file-copy overlay, so background builds/test runs never touch your working tree and
   its warm `bin`/`obj` never collide with your editor's builds.
2. **Impact map** — each test class is run once with Coverlet
   (`--collect "XPlat Code Coverage"`), and the Cobertura report is inverted into
   `source file → test classes that execute it`. Class-level granularity keeps the map
   build tractable; rows refresh whenever their tests re-run.
3. **Affected set** — on save (or per commit), changed files are looked up in the map.
   Mapped files → run just those test classes (`dotnet test --filter`). Unmapped files →
   conservative fallback: run every test project that transitively references the
   changed file's project (computed from the `ProjectReference` graph).

Test projects need `coverlet.collector` (the default in the xunit template) for map
building; running affected tests works regardless.

## VS Code extension

Native Test Explorer integration via the `TestController` API — no custom UI:

- **Continuous run** — toggle the "eye" on the *Affected tests* profile and affected
  tests re-run on every `.cs` save (also available as plain auto-run-on-save via
  `dotnetImpact.autoRunOnSave`).
- **Automatic map build** — on workspace open, any test classes missing from the map
  are mapped in the background (status-bar progress; disable via
  `dotnetImpact.autoBuildMap`). `dotnet-impact: Build impact map (background)` runs
  the same thing on demand with a cancellable progress notification.
- `dotnet-impact: Run affected tests now` — affected set for the current dirty files.
- Status bar shows the last run's result.

## CLI (pre-commit hooks / agents)

```
dotnet-impact build-map [--refresh]      # build or refresh the map (run overnight / in background)
dotnet-impact affected [--base <ref>] [--staged]   # print affected test classes
dotnet-impact run [--base <ref>] [--staged]        # run affected tests; exit 1 on failure
dotnet-impact status
```

Pre-commit hook (`.git/hooks/pre-commit`):

```sh
#!/bin/sh
node /path/to/dotnet-impact/out/cli.js run --staged || exit 1
```

For an AI coding agent, `dotnet-impact run` after each edit gives sub-minute feedback
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
live under `~/.dotnet-impact/<repo>-<hash>/` — delete that folder to reset everything
(then `git worktree prune` in the repo).
