# Impact

**Live unit testing for .NET in VS Code — free and open source.**

Save a file, see the affected tests go green (or red) in **~50 milliseconds**. No
build, no test-host startup, no running the whole suite. The closest thing to
this is Visual Studio's Live Unit Testing, which requires an Enterprise license
and doesn't exist for VS Code at all.

<!-- demo.gif: save → red → fix → green, with the timing line visible -->

## Why it's fast

Most "run tests on save" tools pay the full toll every time: MSBuild spin-up,
test-host spawn, suite discovery — seconds of ceremony before a single assert
runs. Impact removes the toll booths:

- **Hot patching** — your edit is compiled into an [Edit-and-Continue
  delta](https://learn.microsoft.com/visualstudio/debugger/hot-reload) (the same
  engine behind `dotnet watch` hot reload) and injected into already-running
  test hosts. Method bodies, new methods, new fields, new types, lambdas — no
  build at all.
- **Warm test sessions** — pre-warmed testhosts stay alive between runs, so
  even when a real build is needed, running the tests costs milliseconds of
  dispatch instead of seconds of startup.
- **Affected-test selection** — an IL-based impact map (refined by measured
  coverage as tests run) knows which test classes can reach the file you
  changed, so only those run.
- **Shadow worktree** — everything happens in a background `git worktree`
  mirror of your repo, so background builds never fight your editor over
  `bin`/`obj`.

Every run logs an honest timing line to the *Impact* output channel:
`timing: fastpath=hit build=0ms tests=12ms total=36ms` — and when the fast path
can't be used (a changed public signature, a rude edit), it says exactly why
and falls back to a minimal rebuild.

## Getting started

1. Install the extension, open a .NET repo with test projects.
2. The Testing panel populates with your tests (classes and methods) and an
   impact map builds in the background.
3. Save a `.cs` file — affected tests run automatically. Or toggle the
   continuous-run "eye" on the *Affected tests* profile.

Works with xUnit, NUnit, and MSTest via `dotnet test` / VSTest. Coverage runs
(native VS Code coverage view) are built in via the *Coverage* profile.

The first run on a repo pays a one-time setup: a full build, the impact map,
and a small local build of the helper services. After that, saves are fast.

## CLI (pre-commit hooks / AI agents)

The same engine ships as a CLI for hooks and coding agents:

```
impact build-map                  # build or refresh the map (background/overnight)
impact affected [file ...]        # print affected test classes
impact run [file ...]             # run affected tests; exit 1 on failure
impact run --staged               # pre-commit mode (index only)
impact run --base <ref>           # everything the branch changed
```

Exit codes are the contract: 0 pass/nothing affected, 1 failure, 2 usage.
Infrastructure never blocks a commit — no map yet or shadow busy warns and
exits 0. Pre-commit via lint-staged (`{ "*.cs": "impact run" }`) or a plain
hook with `impact run --staged`.

For an AI coding agent, `impact run <files>` after each edit gives sub-minute
feedback scoped to the blast radius of the change. Put that in your repo's
agent docs (`CLAUDE.md` or equivalent) so agents discover it.

## How selection works

1. **Impact map** — built statically in seconds from the assemblies' IL
   metadata and portable PDBs: each test class's transitive type-reference
   closure becomes `source file → test classes`. Measured per-class coverage
   replaces the static rows as tests actually run, converging on observed
   truth (including DI/reflection edges static analysis can't see).
2. **On save** — changed files are looked up in the map; mapped files run just
   those test classes, unmapped files fall back to every test project that
   transitively references the changed project.

## Known blind spots (by design)

- Reflection / DI indirection: a config change that reroutes DI can affect
  tests the map doesn't predict. Non-`.cs` and unmapped files fall back to
  project-level selection.
- `.csproj` / config edits use the project-graph fallback, not the map.
- A changed **public/internal signature** always takes the rebuild path:
  hot-patching it would leave dependent assemblies green against an API that
  no longer compiles, so Impact refuses and rebuilds instead.

## Development

```
npm install
npm run compile     # or: npm run watch
npm test            # unit tests (node --test)
```

Launch with F5 (Extension Development Host). All state lives under
`~/.impact/<repo>-<hash>/` — delete that folder to reset everything (then
`git worktree prune` in the repo).
