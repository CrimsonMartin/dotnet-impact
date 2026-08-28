# Changelog

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
