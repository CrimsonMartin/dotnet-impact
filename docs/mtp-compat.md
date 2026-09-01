# Microsoft.Testing.Platform / xunit v3 compatibility (#23)

Probed 2026-09-01, headless, against the compiled pipeline (Runner +
SessionRunner + HotPatcher driven directly, the gif-scenario harness shape).
Environment: .NET SDK 10.0.400 (Linux), xunit.v3 2.0.3,
xunit.runner.visualstudio 3.1.0, MSTest 3.8.3, Microsoft.NET.Test.Sdk 17.13.0.
Control scenario: classic xunit 2.9.0 + adapter 2.8.2.

## Matrix — before Phase 1

| pipeline stage | xunit v2 (control) | xunit v3 + VSTest adapter | xunit v3 MTP-native | MSTest MTP |
|---|---|---|---|---|
| project builds; plain `dotnet test` | works | works | works (exit 0 pass / 1 fail) | works |
| discovery (`dotnet test --list-tests`) | works | works | **fails: exits 0 with EMPTY stdout** — no listing is produced, so the tree shows no tests | same failure |
| run outcomes (`--logger trx`) | works | works | **fails silently: `--logger trx --results-directory` accepted and ignored, 0 .trx written** — runs report ok/fail with zero per-test outcomes | same failure |
| warm sessions (vstest.console) | works | works | **never available** — vstest cannot host an MTP app; every run logs `no warm testhosts` and takes the build path | same |
| hot-patch fast path | works¹ | works¹ (identical behavior to v2 control) | n/a (no hosts) — but see the stale-green hazard below | n/a |
| coverage (`--collect "Code Coverage"`) | works | works | **fails silently: collector ignored, no report** (refresh keeps existing rows, logs "no coverage produced") | same |

¹ Both VSTest scenarios reproduced a **pre-existing fast-path no-op bug**
(identical in the v2 control, so unrelated to xunit v3): sequence
*discovery-build → run-all → edit+save (build path, fresh baseline) →
breaking edit+save* yields `no-op (engine: no effective changes;
persistent=0 transient=0 rebuild=0)` → `applied 0 delta(s)` → the breaking
edit stays green. Deterministic repro (single lib + test project, xunit v2
or v3): drive the Runner through exactly `prepare → discoverAll` (which
builds the solution) `→ runAffected(full) → whitespace edit +
runAffected(changed)` (build path, fresh baseline+preload) `→ breaking edit
+ runAffected(changed)` — the last run reports `fastpath=hit … 0 delta(s)`
and stays green. Same zero-diagnostic no-op shape investigated in the
v0.2.7 stale-baseline work, now reliably reproducible — for the fast-path
owners, out of scope here.

## What the MTP app itself offers (probe findings)

- `dotnet exec <app.dll> --list-tests` prints the standard
  `The following Tests are available:` listing. **xunit v3 lists full FQNs**
  (parseListedTests handles it unchanged); **MSTest lists display names only**
  (`Adds`), which cannot be mapped to classes.
- A run prints one `failed <FQN> (<duration>)` line per failing test with
  indented assertion details, then a `Test run summary:` block with
  total/failed/succeeded/skipped counts. Exit 0 = pass, non-zero = fail.
  This output is the platform's device, shared across runners.
- `--report-trx` requires the extra `Microsoft.Testing.Extensions.TrxReport`
  package (not present by default; unknown option without it). Filter options
  are runner-specific (xunit: `--filter-class`/`--filter-method` work;
  MTP-generic `--filter-query`/`--treenode-filter` need extensions).
- `dotnet test` passthrough leaves a UTF-16 console-capture log under
  `bin/**/TestResults/*.log` — summary counts only, no per-test records.

## Matrix — after Phase 1 (this branch)

| pipeline stage | xunit v3 MTP-native | MSTest MTP |
|---|---|---|
| detection (`usesMtpRunner`) | flagged via MTP properties / MSTest.Sdk / adapter-less xunit.v3 | flagged |
| discovery | **works** — listed through the app (`dotnet exec <dll> --list-tests`) | still empty (display names only, no FQNs) — Phase 2 |
| run outcomes | **works** — the app runs whole-project, failures parsed from its `failed <FQN>` lines, passes synthesized from the discovery listing | run-level only: exit codes correct (red/green run state), no per-test rows — Phase 2 |
| hot-patch fast path | **hard-gated**: `fastpath=off(mtp-project)` — a fresh MTP process loads disk assemblies, so an "applied" patch would run stale code green | same gate |
| warm sessions | skipped with an explicit log line; ~1.3s/save via the build path | same |
| per-class filtering | not attempted (runner-specific options); whole project runs — correctness over speed | same |
| coverage refresh | unchanged: no report, existing rows kept, logged | same |

## Phase 2 scope (parity)

MTP apps stay resident with `--server` (jsonrpc over stdin/stdout) — the
natural analog of the vstest SessionRunner:

- a second session flavor speaking the MTP server protocol: discovery and
  per-test execution with **stable test node IDs** (fixes MSTest attribution
  and per-class filtering runner-agnostically);
- hot-patch env (`DOTNET_STARTUP_HOOKS`, `DOTNET_MODIFIABLE_ASSEMBLIES`)
  injected at spawn — we own the process, so the existing hook/pipe pipeline
  should carry over, re-enabling the fast path;
- coverage: MTP's own `--coverage` extension or the warm instrumented-mirror
  pipeline pointed at MTP hosts.

Estimated shape: a `mtpSession.ts` sibling of `vstestSession.ts` plus a
protocol client; the runner's per-project routing added in Phase 1 is the
seam it plugs into.
