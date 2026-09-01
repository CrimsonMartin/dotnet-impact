# Microsoft.Testing.Platform / xunit v3 support

How impact handles test projects across the VSTest and Microsoft.Testing
Platform (MTP) worlds. Verified against .NET SDK 10.0.400, xunit.v3 2.0.3,
xunit.runner.visualstudio 3.1.0, MSTest 3.8.3 and MSTest.Sdk 4.1.0, with
classic xunit 2.9 as the control.

## Which pipeline a project gets

`usesMtpRunner` flags MTP-native projects from the csproj: explicit MTP
properties (`UseMicrosoftTestingPlatformRunner`,
`TestingPlatformDotnetTestSupport`, `EnableMSTestRunner` and friends),
`MSTest.Sdk`, or adapter-less `xunit.v3`. Everything else — including
**xunit v3 with the VSTest adapter, which behaves identically to xunit v2
everywhere** — takes the classic vstest pipeline unchanged.

The VSTest surfaces are silently dark on MTP-native projects (`dotnet test
--list-tests` exits 0 with empty output, `--logger trx` is accepted and
ignored, vstest.console can't host the app, coverage collectors are
ignored), so impact never uses them there.

## How MTP projects run

**Warm server-mode sessions** (`src/core/mtpSession.ts`) are the primary
path. The test app is launched once with `--server --client-host/--client-
port`, connects back to a listener impact owns, and speaks LSP-framed
JSON-RPC: `initialize`, then `testing/discoverTests` / `testing/runTests`
with `testing/testUpdates/tests` streaming test nodes. That gives impact:

- **discovery with class attribution** — nodes carry stable uids plus
  `location.type`/`location.method` (xunit v3, MSTest 4+);
- **per-class filtered runs** — requests carry the wanted nodes'
  `{uid, display-name}`;
- **per-test outcomes** — `execution-state` passed/failed/skipped with
  `error.message`, `error.stacktrace`, and durations;
- **hot patching** — the startup-hook env is injected at spawn, so the
  resident app registers as a patchable host and EnC deltas apply to it
  exactly as to vstest testhosts, including the capability handshake and
  the generation-coherence gate. A rebuild replaces the dll on disk; the
  session re-stats it on every use and recycles the process, which resets
  the patch epoch.
- **coverage refresh** — the warm-coverage instrumented mirrors run
  through a dedicated MTP session fleet (no hook env: coverage hosts are
  never patchable), with per-class `snapshot --reset` attribution as on
  vstest.

**The exec fallback** (`src/core/mtp.ts`) covers any warm-session miss
(spawn or protocol failure, or no session runner wired, as in the CLI):
discovery through the app's `--list-tests`, whole-project runs through the
app with per-method outcomes synthesized from its console output (failures
from `failed <FQN>` lines, passes from the discovery listing). On this
path the hot-patch fast path is gated off (`fastpath=off(mtp-project)`) —
a fresh MTP process loads disk assemblies, so an "applied" patch would run
stale code green.

## Current limitations

- **MSTest 3.x**: its server-mode nodes carry only uids and bare method
  display names (no `location.*`), which cannot be attributed to classes.
  Runs report run-level red/green with correct exit codes; per-test rows
  and class filtering need MSTest 4+ (current), whose nodes carry full
  location data.
- Parameterized-test display shapes beyond the standard `Class.Method`
  forms follow whatever the runner reports; attribution uses
  `location.type` when present and falls back to splitting dotted display
  names.
