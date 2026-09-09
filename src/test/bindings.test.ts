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
  effectiveFiles,
  LearnedBindings,
  mineDelta,
  pruneBindings,
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

test("effectiveFiles: extends static rows only — measured rows are ground truth", () => {
  const table: BindingTable = { [A.toLowerCase()]: [binding()] };
  // Static row: row files ∪ binding targets.
  const staticSet = effectiveFiles(
    { files: ["src/T.cs", "src/IService.cs"], source: "static" },
    [A],
    table
  );
  assert.deepEqual([...staticSet].sort(), ["src/IService.cs", B, "src/T.cs"]);
  // Coverage row: unchanged, even though the class references the abstraction.
  const covSet = effectiveFiles(
    { files: ["src/T.cs"], source: "coverage" },
    [A],
    table
  );
  assert.deepEqual([...covSet], ["src/T.cs"]);
  // Pre-marker row (source absent = coverage): unchanged.
  const legacySet = effectiveFiles({ files: ["src/T.cs"] }, [A], table);
  assert.deepEqual([...legacySet], ["src/T.cs"]);
});

test("decayBindings: stale edges drop, fresh ones stay", () => {
  const old = binding({ lastSeen: new Date(NOW - DECAY_MS - 1000).toISOString() });
  const t = decayBindings({ [A]: [binding(), old] }, NOW);
  assert.equal(t[A]!.length, 1);
  assert.equal(t[A]![0].lastSeen, nowIso);
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
