# Plan: self-tuning map — learning dynamic edges from measured coverage (#31)

The static IL map can't see edges that only exist at runtime (DI-container
construction, reflection, fixture wiring). Today's hybrid fixes this per class:
a coverage refresh replaces the static row with measured files. That knowledge
is **per-class and non-transferable** — an edit to `ServiceImpl.cs` only selects
the test classes that were individually coverage-measured.

This plan makes the knowledge transferable: mine coverage runs for
**abstraction ⇒ implementation binding edges**, attach them to the abstraction,
and let every class that statically references the abstraction inherit them.
Safety is asymmetric by design: learned edges only **add** files to closures
(over-selection), never remove. Under-selection — the only dangerous
direction — is what shrinks.

Sequencing note from #31 ("after PR #30 lands") is satisfied: #30 is merged,
and #33 (startup change detection) is in at HEAD. No blockers.

## Architecture: three tiers, one invariant

| Tier | Source | Precedence |
|---|---|---|
| coverage | measured per-class files (existing) | wins, untouched |
| static | IL closure rows (existing) | base row for unmeasured classes |
| learned | mined binding edges + parsed registrations | **adds to static rows only** |

The existing invariant stands: a measured row is the ground truth for its class
and is never modified by the learned tier. The learned tier only extends rows
whose `source === "static"`. Application is **query-time** — `impact-map.json`
rows are never rewritten; the bindings live in their own store.

## Data model

### `MapEntry` extension (`src/core/map.ts`)

```ts
interface MapEntry {
  csproj: string;
  files: string[];
  source?: "static" | "coverage";
  updatedAt: string;
  /** NEW: repo-relative files of types this class DIRECTLY references that
   *  are interfaces or abstract classes. Absent on old rows ⇒ treated as []. */
  abstractFiles?: string[];
}
```

Old map files without the field keep working (learned edges simply don't
apply to those rows until the next `buildMap`); no schema version bump needed,
but the field's absence must be handled everywhere the new code touches it.

### `learned-bindings.json` (new, in `cacheDirFor(repoRoot)`)

```jsonc
{
  "version": 1,
  "bindings": {
    "src/IService.cs": [
      {
        "to": "src/ServiceImpl.cs",
        "source": "mined" | "parsed",   // coverage-mined vs registration-parser seed
        "confirms": 2,                   // measurements of A-referencing classes where `to` was hit
        "contradicts": 0,                // measurements of A-referencing classes where `to` was NOT hit
        "lastSeen": "2026-09-08T00:00:00Z",
        "evidence": ["Ns.AlphaTests"]    // classes whose Δ first implied the edge
      }
    ]
  }
}
```

Keys and values are repo-relative forward-slash source files.

## Components

### A. Static-map helper extension (`helper-static/Program.cs`)

The helper already computes each test class's *direct* references before the
BFS closure (`RefCollector`), and knows every solution type's source file.
Two output additions:

1. **`abstractFiles` per class**: files of directly-referenced types that are
   interfaces or abstract classes. Direct references only — this is what keeps
   attribution precise (a class that reaches `IService` through a fixture
   doesn't get the binding attributed to it; the fixture's own closure or the
   fixture's classes cover that case). Conservative by design.
2. **Registration source (deviation, shipped)**: DI registration pairs are
   parsed from **source text** (`src/core/registrations.ts`), not IL. Reason:
   recent Roslyn (SDK 10) emits MethodSpec rows that make typed registrations
   IL-visible, older SDKs don't — IL extraction is toolchain-dependent, while
   a source pass over `AddScoped<IService, ServiceImpl>()` / `TryAdd*` /
   `AddSingleton` / `AddTransient` / Autofac `RegisterType` (two-generic form,
   plus `AddScoped<I>(new Impl())`) works on every toolchain. Names resolve
   against the helper's type index (exact FQN → non-generic → UNIQUE short
   name; ambiguous/unresolvable ⇒ no seed). Factory-lambda and convention-
   based registrations are out of scope for the parser by design — they are
   exactly what Δ-mining is for.

`StaticMapper.compute` surfaces `abstractFiles` + `types`; `Runner.buildMap`
stores `abstractFiles` on static rows and runs the registration seed.

### B. Δ-mining (hook in `Runner.refreshPending`)

At the existing refresh point — after `cov.files` is resolved, **before**
`this.map.update(...)` overwrites the static row:

- Baseline = the row this measurement replaces (static on first
  measurement, the PREVIOUS coverage row on re-measurements). `Δ = measured
  − baseline`. For each `B ∈ Δ` and each `A ∈ abstractFiles(T)` with `A ≠ B`:
  record evidence for binding `A ⇒ B` (activate or re-confirm). This is the
  only window where Δ exists — the overwrite destroys the baseline, so mining
  must precede it. (Shipped refinement over the original "no Δ on
  re-measurement": using the previous coverage row as baseline is what lets a
  CHANGED world teach a new edge — when the convention flips to a different
  implementation, the newly-appearing impl file is attributed and the old
  impl's edge starts accumulating contradictions in the same measurements.)
- Every measurement: each known `A ⇒ B` with `A ∈ abstractFiles(T)` gets
  `confirms++` if `B ∈ measured(T)`, else `contradicts++`.

All evidence math is a pure function in a new `src/core/bindings.ts`.

### C. Binding store + evidence rules (`src/core/bindings.ts`, pure)

- **Activation**: 1 attributed evidence class is enough. Rationale: the
  #31 E2E contract requires one measured class to transfer knowledge to a
  never-measured one, and a false edge only costs extra tests.
- **Confirmation/contradiction**: as in B. **Drop rule**:
  `contradicts ≥ 4 && contradicts > 2 × confirms`. Deliberately lopsided —
  a true binding re-confirms on every measurement of an A-referencing class
  that exercises the path, while a dead one (impl deleted/unregistered)
  contradicts on all of them; but a class whose tests simply never touch the
  DI path is weak evidence in both directions, and the safe direction is to
  keep.
- **Staleness decay**: at `buildMap` time, drop bindings with
  `lastSeen` older than 30 days — they relearn cheaply from the next
  refresh, and file moves/renames leave dead-path edges behind.
- **Path prune**: same pass drops bindings whose `from` or `to` file no
  longer exists in the repo tree (mirrors `ImpactMap.prune`).

### D. Query-time application (`Runner.computeAffected`)

Single application point, so the VS Code extension and the CLI
(`impact run --base`, hooks) get it for free:

For each changed file `B`: existing inverted-index lookup selects classes as
today, **plus** for each binding `A ⇒ B`, every class whose row is `source
=== "static"` and whose `abstractFiles` contain `A` is added.

**Covered status (fallback suppression) is earned, not assumed.** It is the
ONE place a learned edge can reduce selection relative to the fallback, so:
- a **parsed** seed (types named precisely) covers from the first sight;
- a **mined** edge covers its target only from its SECOND confirmation
  (`MINED_CONFIRM_TO_COVER = 2`). One-evidence mined edges still SELECT
  classes (safe over-selection) but the target file keeps triggering the
  project-level fallback — pre-#31 behavior, no under-selection possible.

Rationale: Δ attribution credits EVERY abstraction the class references, so a
single-measurement edge may be attached to the wrong abstraction; suppressing
the fallback on such an edge would drop tests the fallback used to run. The
second confirmation arrives with the next refresh of any class that exercises
the binding (the fallback run itself queues them), so selection converges to
precise within one test run.

Kill switch: `dotnetImpact.learnedBindings` (default `true`), same
`getConfiguration` pattern as `watchExternalChanges`.

### E. Registration-parser seed (component A's `registrations`)

At `buildMap` time, each `{service, impl}` pair whose both files resolve
becomes a binding with `source: "parsed"`, `confirms: 1`. Parsed seeds let a
repo get the transfer effect **with zero test runs**; mined edges then confirm
(parser-visible registration + runtime reality), extend (reflection/convention
registration the parser can't see), or contradict.

### F. Active learning pass ("learn on its own by running tests")

`selectLearningTargets(known, bindings, budget)` — pure function:

For each unmeasured class `T` (static or missing row), for each
`A ∈ abstractFiles(T)` with **no known binding at all**:
`score(T) += count of unmeasured classes sharing A` (what one measurement
would teach). Return the top-`budget` classes.

Wiring: after `buildMap` completes and after `refreshPending` drains, at
idle priority with the existing abort-signal discipline (a foreground run
preempts; in-flight class requeues). Enqueues directly into
`pendingRefresh` (bypassing `queueRefreshFromOutcomes`, which only sees
classes that just ran). Budget: a dozen or two classes — the warm pipeline
(#3, ~0.5 s/class) makes it affordable. This pass is what drives the #2
metric toward zero without the user ever touching a test.

## PR breakdown and tests

Each PR ships green; unit tests are `node:test` against the pure functions in
`bindings.ts` (new `src/test/bindings.test.ts`), e2e tests follow the
existing fixture style (temp repo, real builds, real `Runner` — cf.
`warm-coverage.test.ts`, `gif-scenario.test.ts`).

### PR 1 — helper + schema (plumbing, zero behavior change)
- Helper emits `abstractFiles` + `registrations`; `buildMap` stores
  `abstractFiles` on static rows. Nothing consumes them yet.
- **Tests**: extend `staticmap.test.ts` — repo with `IService` (interface),
  `ServiceImpl`, and a test class that references the interface but not the
  impl: entry has `IService.cs` in `abstractFiles`, `ServiceImpl.cs` in
  neither `abstractFiles` nor `files` (no static edge exists — the whole
  premise). Old-map-compat test: a v1 map file without `abstractFiles` loads
  and behaves as today.

### PR 2 — mining + binding store
- `bindings.ts` (pure), `learned-bindings.json` load/save, mining hook in
  `refreshPending` (before `map.update`). No query application yet.
- **Unit tests** (`bindings.test.ts`):
  - `mineDelta`: attribution across multiple abstractions; `A === B` skipped;
    empty `abstractFiles` ⇒ no edges; measured ⊆ static ⇒ empty Δ.
  - Evidence arithmetic: activation at 1; `confirms++`/`lastSeen` bump on
    re-measurement; drop rule boundary cases (`contradicts = 3` keeps,
    `4 > 2×1` drops, `4 vs confirms = 2` keeps); staleness decay at the
    30-day boundary; path prune.
  - Query-time invariant as named tests: a coverage row is never selected or
    extended via a binding; covered requires a selected class AND a covering
    edge (parsed, or mined with ≥ MINED_CONFIRM_TO_COVER).
- **Integration test**: DI fixture repo (interface, container-registered impl,
  two test classes resolving through the container); warm-refresh class A;
  assert `learned-bindings.json` gained `IService.cs ⇒ ServiceImpl.cs` with
  `evidence: [A]` — and that A's map row is now `source: "coverage"`.

### PR 3 — query-time application
- `computeAffected` extension + `dotnetImpact.learnedBindings` setting.
- **Unit tests**: `affectedClasses`/`computeAffected` with a bindings store —
  edit `ServiceImpl.cs` ⇒ selects the static-row class referencing
  `IService`; a class referencing an unrelated abstraction is *not* selected
  (control); a coverage-row class is selected iff `ServiceImpl.cs` is in its
  measured row (invariant holds through the new path); setting off ⇒ no
  learned selections.
- **E2E — the marquee test** (the #31 contract): DI repo; coverage-refresh
  class A only; then edit `ServiceImpl.cs` and assert class B — never
  measured — is selected via the learned binding. This is the transfer
  effect today's hybrid cannot produce; it must fail on the pre-PR-3 build.

### PR 4 — registration-parser seed
- Helper `registrations` scan; seed at `buildMap`.
- **Tests**: e2e — same DI repo, `buildMap` only, **no test runs**: binding
  present with `source: "parsed"`; edit impl ⇒ class B selected. Negative:
  a registration whose impl type isn't in the solution ⇒ no edge, no crash;
  a two-generic call on a non-DI method name ⇒ ignored.

### PR 5 — active learning pass
- `selectLearningTargets` (pure) + idle wiring + budget.
- **Unit tests**: scoring (classes sharing an unknown abstraction outrank
  singleton ones), budget cap, dedup, skips measured classes and abstractions
  with known bindings.
- **E2E**: DI repo where no class is ever refreshed by the user; after
  `buildMap` + the idle pass, edit impl ⇒ class B selected (the pass measured
  A and learned). Budget test: N classes sharing one abstraction ⇒ at most
  `budget` classes measured by the pass.

### PR 6 — decay/contradiction e2e + metric (small, can merge into 2/5)
- **E2E**: un-register the impl, re-measure ⇒ edge contradicts to a drop;
  selection reverts to static-only behavior.
- **Metric**: dev command (or throwaway script) re-running the #2
  measurement — classes whose measured coverage ⊄ (static ∪ learned).
  Target: 92/254 on EDITools → near 0 after the active-learning pass
  converges.

## Risks / edge cases

- **File moves/renames**: binding keys are paths; stale edges die via the
  path prune + staleness decay at next `buildMap`. Git rename-aware
  rebinding is out of scope (safe direction: a moved impl just stops being
  learned until re-mined).
- **Multi-TFM / MTP / xunit v3**: mining is collector- and framework-agnostic
  (operates on resolved repo-relative files); the warm pipeline already
  handles runner differences.
- **Shadow → repo-relative**: reuse the existing `repoTreeFiles` normalization
  at the mining hook (already applied to `cov.files` there).
- **Cross-repo contamination**: none — store is per-repo
  (`cacheDirFor`), like the impact map.
- **God-type cap** (`--god-percent`): learned precise bindings eventually
  justify tightening the cap (hub files reached only via real bindings no
  longer need blanket closure edges) — follow-up, explicitly deferred.
- **Abstraction ambiguity**: none at the IL level (fully qualified types);
  the only resolution that happens in TS is file lookup, which is exact.
- **Wrong-abstraction attribution**: Δ credits every referenced abstraction,
  so a mined edge can land on the wrong one. Class selection on such an edge
  is safe (over-selection); fallback suppression on it is not — hence the
  MINED_CONFIRM_TO_COVER = 2 gate (see component D).

## Estimate

| PR | Scope | Est. |
|---|---|---|
| 1 | helper + schema | ~1 d |
| 2 | mining + store (unit-heavy) | ~1–2 d |
| 3 | query application + marquee e2e | ~1 d |
| 4 | registration seed | ~1–2 d |
| 5 | active learning | ~1–2 d |
| 6 | decay e2e + metric | ~0.5–1 d |

≈ one focused week, six green PRs, each independently shippable (every PR
before #3 leaves behavior byte-identical or strictly adds over-selection).
