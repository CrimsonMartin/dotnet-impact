import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  applyMeasurement,
  Binding,
  BindingTable,
  CONTRADICT_MIN,
  decayBindings,
  DECAY_MS,
  LearnedBindings,
  learnedSelection,
  mineDelta,
  MINED_CONFIRM_TO_COVER,
  pruneBindings,
  selectLearningTargets,
  shouldDrop,
} from "../core/bindings";
import { cacheDirFor } from "../core/util";

const A = "src/IService.cs"; // abstraction file
const B = "src/ServiceImpl.cs"; // dynamic target
const C = "src/OtherImpl.cs"; // second target

const NOW = Date.parse("2026-09-08T12:00:00Z");
const nowIso = new Date(NOW).toISOString();

function binding(partial: Partial<Binding> = {}): Binding {
  return {
    to: B,
    source: "mined",
    confirms: 1,
    contradicts: 0,
    lastSeen: nowIso,
    evidence: ["Ns.A"],
    ...partial,
  };
}

test("mineDelta: measured minus static, attributed to every referenced abstraction", () => {
  const d = mineDelta({
    staticFiles: ["src/Lib.cs", "src/IService.cs", "src/Container.cs"],
    measuredFiles: ["src/Lib.cs", "src/IService.cs", "src/ServiceImpl.cs", "src/OtherImpl.cs"],
    abstractFiles: ["src/IService.cs", "src/IRepo.cs"],
  });
  // Each Δ file × each referenced abstraction.
  const asJson = (xs: Array<{ from: string; to: string }>) =>
    xs.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(asJson(d), asJson([
    { from: "src/IService.cs", to: "src/OtherImpl.cs" },
    { from: "src/IRepo.cs", to: "src/OtherImpl.cs" },
    { from: "src/IService.cs", to: "src/ServiceImpl.cs" },
    { from: "src/IRepo.cs", to: "src/ServiceImpl.cs" },
  ]));
});

test("mineDelta: empty when measured ⊆ static, or without abstractions, or self-pair", () => {
  assert.deepEqual(
    mineDelta({ staticFiles: ["x.cs"], measuredFiles: ["x.cs"], abstractFiles: ["a.cs"] }),
    []
  );
  assert.deepEqual(
    mineDelta({ staticFiles: [], measuredFiles: ["x.cs"], abstractFiles: [] }),
    []
  );
  // A file cannot be its own dynamic target.
  assert.deepEqual(mineDelta({ staticFiles: [], measuredFiles: ["a.cs"], abstractFiles: ["a.cs"] }), []);
  // Same file under different case (case-insensitive FS) is still itself.
  assert.deepEqual(
    mineDelta({ staticFiles: [], measuredFiles: ["A.cs"], abstractFiles: ["a.cs"] }),
    []
  );
});

test("applyMeasurement: one Δ measurement activates an edge (confirms=1, evidence recorded)", () => {
  const t = applyMeasurement({}, {
    classFqn: "Ns.A",
    abstractFiles: [A],
    measuredFiles: ["src/T.cs", B],
    staticFiles: ["src/T.cs", "src/IService.cs"],
    now: nowIso,
  });
  // Key contract: lower-cased.
  assert.deepEqual(t[A.toLowerCase()], [
    { to: B, source: "mined", confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: ["Ns.A"] },
  ]);
});

test("applyMeasurement: a re-measurement confirms or contradicts known edges, no activation", () => {
  const table: BindingTable = { [A.toLowerCase()]: [binding(), { to: C, source: "mined", confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: [] }] };
  // B hit, C missed.
  const t = applyMeasurement(table, {
    classFqn: "Ns.A",
    abstractFiles: [A],
    measuredFiles: [B],
    staticFiles: null,
    now: nowIso,
  });
  assert.equal(t[A.toLowerCase()]![0].to, B);
  assert.equal(t[A.toLowerCase()]![0].confirms, 2);
  assert.equal(t[A.toLowerCase()]![1].to, C);
  assert.equal(t[A.toLowerCase()]![1].contradicts, 1);
  // Re-measurement never activates: a new Δ file with no prior edge…
  const t2 = applyMeasurement({}, {
    classFqn: "Ns.A",
    abstractFiles: [A],
    measuredFiles: ["src/BrandNew.cs"],
    staticFiles: null,
    now: nowIso,
  });
  assert.deepEqual(t2, {});
});

test("applyMeasurement: an edge activated by this measurement is not double-confirmed", () => {
  const t = applyMeasurement({ [A]: [] }, {
    classFqn: "Ns.A",
    abstractFiles: [A],
    measuredFiles: [B],
    staticFiles: [],
    now: nowIso,
  });
  assert.equal(t[A.toLowerCase()]![0].confirms, 1);
});

test("applyMeasurement: edges for unreferenced abstractions are untouched", () => {
  const table: BindingTable = {
    [A.toLowerCase()]: [binding()],
    "src/irepo.cs": [{ to: B, source: "mined", confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: [] }],
  };
  const t = applyMeasurement(table, {
    classFqn: "Ns.A",
    abstractFiles: [A], // only references A
    measuredFiles: ["other.cs"], // B missed
    staticFiles: null,
    now: nowIso,
  });
  assert.equal(t[A.toLowerCase()]![0].contradicts, 1); // A referenced → contradicted
  assert.equal(t["src/irepo.cs"]![0].contradicts, 0); // not referenced → untouched
});

test("shouldDrop: contradiction threshold is lopsided toward keeping", () => {
  const mk = (confirms: number, contradicts: number) =>
    binding({ confirms, contradicts });
  // c=1: drops exactly at CONTRADICT_MIN (4 ≥ 4 && 4 > 2).
  assert.equal(shouldDrop(mk(1, 3)), false);
  assert.equal(shouldDrop(mk(1, CONTRADICT_MIN)), true);
  // c=2: needs > 4, so 4 keeps, 5 drops.
  assert.equal(shouldDrop(mk(2, 4)), false);
  assert.equal(shouldDrop(mk(2, 5)), true);
  // c=10: needs > 20.
  assert.equal(shouldDrop(mk(10, 20)), false);
  assert.equal(shouldDrop(mk(10, 21)), true);
});

test("applyMeasurement: an edge is dropped once sufficiently contradicted", () => {
  let table: BindingTable = { [A.toLowerCase()]: [binding()] }; // c=1
  for (let i = 0; i < CONTRADICT_MIN; i++) {
    table = applyMeasurement(table, {
      classFqn: "Ns.A",
      abstractFiles: [A],
      measuredFiles: ["other.cs"],
      staticFiles: null,
      now: nowIso,
    });
  }
  assert.deepEqual(table, {});
});

test("decayBindings: stale edges drop, fresh ones stay", () => {
  const old = binding({ lastSeen: new Date(NOW - DECAY_MS - 1000).toISOString() });
  const t = decayBindings({ [A]: [binding(), old] }, NOW);
  assert.equal(t[A]!.length, 1);
  assert.equal(t[A]![0].lastSeen, nowIso);
});

const ROWS = [
  { fqn: "Ns.A", source: "static" as const, abstractFiles: [A] },
  { fqn: "Ns.B", source: "static" as const, abstractFiles: [A] },
  { fqn: "Ns.C", source: "static" as const, abstractFiles: ["src/IRepo.cs"] },
  { fqn: "Ns.D", source: "coverage" as const, abstractFiles: [A] },
];

test("selectLearningTargets: unresolved abstractions weighted by how many classes share them", () => {
  const unmeasured = [
    { classFqn: "Ns.Shared1", abstractFiles: [A] },
    { classFqn: "Ns.Shared2", abstractFiles: [A] },
    { classFqn: "Ns.Shared3", abstractFiles: [A] },
    { classFqn: "Ns.Solo", abstractFiles: ["src/IRepo.cs"] },
  ];
  const r = selectLearningTargets({ unmeasured, measuredAbstractFiles: new Set(), table: {}, budget: 10 });
  // All three A-sharers score 3 (measuring any one resolves A for all of
  // them); the solo scores 1.
  assert.deepEqual(r, ["Ns.Shared1", "Ns.Shared2", "Ns.Shared3", "Ns.Solo"]);
});

test("selectLearningTargets: budget caps, ordering is deterministic", () => {
  const unmeasured = [
    { classFqn: "Ns.B", abstractFiles: [A] },
    { classFqn: "Ns.A", abstractFiles: [A] },
    { classFqn: "Ns.C", abstractFiles: [A] },
  ];
  assert.deepEqual(
    selectLearningTargets({ unmeasured, measuredAbstractFiles: new Set(), table: {}, budget: 2 }),
    ["Ns.A", "Ns.B"]
  );
});

test("selectLearningTargets: resolved abstractions are never sampled", () => {
  const unmeasured = [
    { classFqn: "Ns.A", abstractFiles: [A] }, // binding exists
    { classFqn: "Ns.B", abstractFiles: ["src/IRepo.cs"] }, // measured class references it
    { classFqn: "Ns.C", abstractFiles: ["src/IFresh.cs"] }, // unresolved
  ];
  const table: BindingTable = { [A.toLowerCase()]: [binding()] };
  const r = selectLearningTargets({
    unmeasured,
    measuredAbstractFiles: new Set(["src/IRepo.cs"]),
    table,
    budget: 10,
  });
  assert.deepEqual(r, ["Ns.C"]);
});

test("learnedSelection: changed binding target selects static classes referencing the abstraction", () => {
  // Confirmed twice (>= MINED_CONFIRM_TO_COVER) → the target is covered too.
  const table: BindingTable = { [A.toLowerCase()]: [binding({ confirms: MINED_CONFIRM_TO_COVER })] };
  const r = learnedSelection({ changedFiles: [B], table, classes: ROWS });
  assert.deepEqual([...r.classes].sort(), ["Ns.A", "Ns.B"]);
  assert.deepEqual([...r.covered], [B.toLowerCase()]);
});

test("learnedSelection: covered is earned — mined needs 2 confirms, parsed covers at 1", () => {
  // Single-evidence MINED edge: classes are selected (safe over-selection),
  // but the target file is NOT covered — the project-level fallback still
  // runs (the pre-#31 safety net; a one-measurement edge may be attributed
  // to the wrong abstraction).
  const mined1: BindingTable = { [A.toLowerCase()]: [binding({ confirms: 1 })] };
  const r1 = learnedSelection({ changedFiles: [B], table: mined1, classes: ROWS });
  assert.deepEqual([...r1.classes].sort(), ["Ns.A", "Ns.B"], "classes selected at confirms=1");
  assert.deepEqual(r1.covered, new Set(), "one evidence: fallback still runs");

  // Second confirmation grants covered.
  const mined2: BindingTable = { [A.toLowerCase()]: [binding({ confirms: MINED_CONFIRM_TO_COVER })] };
  const r2 = learnedSelection({ changedFiles: [B], table: mined2, classes: ROWS });
  assert.deepEqual([...r2.covered], [B.toLowerCase()]);

  // Parsed seeds name their types precisely: covered from the first sight.
  const parsed: BindingTable = {
    [A.toLowerCase()]: [
      { to: B, source: "parsed", confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: [] },
    ],
  };
  const r3 = learnedSelection({ changedFiles: [B], table: parsed, classes: ROWS });
  assert.deepEqual([...r3.classes].sort(), ["Ns.A", "Ns.B"]);
  assert.deepEqual([...r3.covered], [B.toLowerCase()], "parsed seed covers immediately");

  // Mixed edges on one target: the parsed edge grants covered even though
  // the mined one hasn't earned it; a different abstraction's edge to a
  // different file selects nothing for B.
  const mixed: BindingTable = {
    [A.toLowerCase()]: [
      binding({ confirms: 1 }),
      { to: B, source: "parsed", confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: [] },
    ],
    "src/irepo.cs": [binding({ to: "src/OtherImpl.cs", confirms: 1 })],
  };
  const r4 = learnedSelection({ changedFiles: [B], table: mixed, classes: ROWS });
  assert.deepEqual([...r4.classes].sort(), ["Ns.A", "Ns.B"], "only IService-referencers selected for B");
  assert.deepEqual([...r4.covered], [B.toLowerCase()], "parsed edge grants covered");
});

test("learnedSelection: a target with no selectable class does not suppress the fallback", () => {
  // Edge grants covered, but no class references the abstraction → nothing
  // is selected → the file stays unknown (fallback must still run).
  const parsed: BindingTable = {
    "src/iunknown.cs": [
      { to: B, source: "parsed", confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: [] },
    ],
  };
  const r = learnedSelection({ changedFiles: [B], table: parsed, classes: ROWS });
  assert.deepEqual(r.classes, new Set());
  assert.deepEqual(r.covered, new Set(), "no class selected: not covered");
});

test("learnedSelection: measured rows are never extended; unrelated abstractions untouched", () => {
  const table: BindingTable = { [A.toLowerCase()]: [binding()] };
  const r = learnedSelection({ changedFiles: [B], table, classes: ROWS });
  assert.ok(!r.classes.has("Ns.D"), "coverage row not selected via the binding");
  assert.ok(!r.classes.has("Ns.C"), "class without the abstraction not selected");
  // An unrelated changed file selects nothing.
  const r2 = learnedSelection({ changedFiles: ["src/Unrelated.cs"], table, classes: ROWS });
  assert.deepEqual(r2.classes, new Set());
  assert.deepEqual(r2.covered, new Set());
});

test("learnedSelection: case-insensitive matching on both sides", () => {
  const table: BindingTable = { [A.toLowerCase()]: [binding({ to: B.toUpperCase() })] };
  const r = learnedSelection({ changedFiles: [B.toUpperCase()], table, classes: ROWS });
  assert.deepEqual([...r.classes].sort(), ["Ns.A", "Ns.B"]);
});

test("pruneBindings: dead abstraction or target files drop the edge", () => {
  // Keys are lower-cased (store contract); `to` keeps its original case.
  const table: BindingTable = {
    [A.toLowerCase()]: [binding(), { to: "src/Gone.cs", source: "mined", confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: [] }],
    "src/goneabs.cs": [binding()],
  };
  const t = pruneBindings(table, new Set([A, B].map((f) => f.toLowerCase())));
  assert.equal(Object.keys(t).length, 1);
  assert.equal(t[A.toLowerCase()]!.length, 1);
  assert.equal(t[A.toLowerCase()]![0].to, B);
});

test("LearnedBindings store: observeMeasurement attributes, keys, and persists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-store-"));
  try {
    const store = new LearnedBindings(root);
    assert.equal(store.count, 0);
    store.observeMeasurement({
      classFqn: "Ns.T",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now: nowIso,
    });
    assert.equal(store.count, 1);
    // Case-insensitive abstraction lookup; `to` keeps original case.
    const edges = store.bindingsFor(A.toUpperCase());
    assert.equal(edges.length, 1);
    assert.equal(edges[0].to, B);
    assert.equal(edges[0].source, "mined");
    assert.equal(edges[0].confirms, 1);
    assert.deepEqual(edges[0].evidence, ["Ns.T"]);

    // Contradictions accumulate across store-level observations.
    store.observeMeasurement({
      classFqn: "Ns.U",
      abstractFiles: [A],
      measuredFiles: [A],
      staticFiles: null,
      now: nowIso,
    });
    assert.equal(store.bindingsFor(A)[0].contradicts, 1);

    // Persistence: a second store over the same root sees the same table.
    const reloaded = new LearnedBindings(root);
    assert.equal(reloaded.count, 1);
    assert.equal(reloaded.bindingsFor(A)[0].to, B);
    assert.equal(reloaded.bindingsFor(A)[0].contradicts, 1);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings store: summary, decay and prune maintain the table", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-store-"));
  try {
    const store = new LearnedBindings(root);
    store.seedParsed([{ from: A, to: B }], nowIso);
    store.observeMeasurement({
      classFqn: "Ns.T",
      abstractFiles: ["src/IRepo.cs"],
      measuredFiles: ["src/RepoImpl.cs", "src/IRepo.cs"],
      staticFiles: ["src/IRepo.cs"],
      now: nowIso,
    });
    // Mixed sources count separately in the status/telemetry summary.
    assert.deepEqual(store.summary, { total: 2, mined: 1, parsed: 1 });

    // Staleness decay: an edge unseen for >30 days drops, fresh ones stay.
    store.decay(Date.parse(nowIso) + 10 * 24 * 3600 * 1000);
    assert.equal(store.count, 2);
    store.decay(Date.parse(nowIso) + 31 * 24 * 3600 * 1000);
    assert.equal(store.count, 0, "all edges decayed past staleness");

    // Path prune: dead targets and dead abstractions drop; live pairs keep.
    store.seedParsed([{ from: A, to: B }, { from: A, to: "src/Gone.cs" }], nowIso);
    store.seedParsed([{ from: "src/GoneAbs.cs", to: B }], nowIso);
    const tree = new Set([A, B].map((f) => f.toLowerCase()));
    store.prune(tree);
    assert.equal(store.bindingsFor("src/GoneAbs.cs").length, 0, "dead abstraction row pruned");
    assert.deepEqual(store.bindingsFor(A).map((b) => b.to), [B], "dead target pruned, live pair kept");

    // Maintenance persists.
    const reloaded = new LearnedBindings(root);
    assert.equal(reloaded.count, 1);
    assert.equal(reloaded.bindingsFor(A)[0].to, B);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("applyMeasurement: a re-measurement with a coverage baseline attributes new files", () => {
  // B6 semantics: the baseline is the previous row of ANY source. Files that
  // newly appear since the previous coverage row are attributed (the world
  // changed: the convention now binds a different implementation), while
  // edges whose target is no longer hit start accumulating contradictions.
  const table: BindingTable = {
    [A.toLowerCase()]: [binding()], // IService -> ServiceImpl, mined earlier
  };
  const t = applyMeasurement(table, {
    classFqn: "Ns.A",
    abstractFiles: [A],
    measuredFiles: [A, C], // C = the new implementation; B (old impl) absent
    staticFiles: [A, B], // the previous coverage row
    now: nowIso,
  });
  const edges = t[A.toLowerCase()]!;
  assert.ok(edges.some((b) => b.to === C && b.source === "mined" && b.confirms === 1), "new file attributed to the abstraction");
  const old = edges.find((b) => b.to === B)!;
  assert.equal(old.contradicts, 1, "old impl's edge contradicted in the same measurement");
});
