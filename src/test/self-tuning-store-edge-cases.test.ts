import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DECAY_MS,
  LearnedBindings,
  BindingTable,
  mineDelta,
  applyMeasurement,
  selectLearningTargets,
  decayBindings,
  shouldDrop,
  MINED_CONFIRM_TO_COVER,
} from "../core/bindings";
import { cacheDirFor } from "../core/util";

/* ----------------------------------------------------------- */
/*  LearnedBindings store: corruption / edge-case resilience   */
/* ----------------------------------------------------------- */

const A = "src/IService.cs";
const B = "src/ServiceImpl.cs";
const NOW = Date.parse("2026-09-08T12:00:00Z");
const nowIso = new Date(NOW).toISOString();

test("LearnedBindings: corrupted JSON is treated as empty store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-corrupt-"));
  const file = path.join(cacheDirFor(root), "learned-bindings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json at all!!! }");
  try {
    const store = new LearnedBindings(root);
    assert.equal(store.count, 0, "corrupted JSON → empty store");
    // Still usable — can learn fresh.
    store.observeMeasurement({
      classFqn: "Ns.A",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now: nowIso,
    });
    assert.equal(store.count, 1, "fresh store works after corruption");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings: empty file is treated as empty store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-empty-"));
  const file = path.join(cacheDirFor(root), "learned-bindings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  try {
    const store = new LearnedBindings(root);
    assert.equal(store.count, 0, "empty file → empty store");
    // Still usable.
    store.observeMeasurement({
      classFqn: "Ns.A",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now: nowIso,
    });
    assert.equal(store.count, 1);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings: unknown version is treated as empty store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-version-"));
  const file = path.join(cacheDirFor(root), "learned-bindings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 99, bindings: { [A]: [] } }));
  try {
    const store = new LearnedBindings(root);
    assert.equal(store.count, 0, "unknown version → empty store");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings: bindings field missing is treated as empty store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-no-bindings-"));
  const file = path.join(cacheDirFor(root), "learned-bindings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1 }));
  try {
    const store = new LearnedBindings(root);
    assert.equal(store.count, 0, "missing bindings field → empty store");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings: seedParsed does not overwrite existing mined evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-seed-override-"));
  try {
    const store = new LearnedBindings(root);
    // Mined first: a real measurement found this edge.
    store.observeMeasurement({
      classFqn: "Ns.Real",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now: nowIso,
    });
    assert.equal(store.count, 1, "mined edge present");

    // Parsed seed comes later — should NOT add a duplicate.
    const added = store.seedParsed([{ from: A, to: B }], nowIso);
    assert.equal(added, 0, "mined evidence wins over parsed seed");
    assert.equal(store.count, 1, "no duplicate edge added");
    const edges = store.bindingsFor(A);
    assert.equal(edges[0].source, "mined", "mined source preserved");
    assert.deepEqual(edges[0].evidence, ["Ns.Real"], "original evidence preserved");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings: seedParsed adds only where no binding covers the pair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-seed-mixed-"));
  try {
    const store = new LearnedBindings(root);
    // Only IService → ServiceImpl has a mined binding.
    store.observeMeasurement({
      classFqn: "Ns.Real",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now: nowIso,
    });
    // Seed two edges: one already exists (A→B), one is new (A→C).
    const C = "src/IRepo.cs";
    const D = "src/RepoImpl.cs";
    const added = store.seedParsed([{ from: A, to: B }, { from: C, to: D }], nowIso);
    assert.equal(added, 1, "only the new pair is seeded");
    assert.equal(store.count, 2, "total count correct");
    const edgesD = store.bindingsFor(C);
    assert.equal(edgesD.length, 1, "seeded edge present for C→D");
    assert.equal(edgesD[0].source, "parsed");
    assert.equal(edgesD[0].to, D);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings: seedParsed returns 0 when all pairs already exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-seed-zero-"));
  try {
    const store = new LearnedBindings(root);
    store.observeMeasurement({
      classFqn: "Ns.Real",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now: nowIso,
    });
    const added = store.seedParsed([{ from: A, to: B }], nowIso);
    assert.equal(added, 0, "no new pairs seeded");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LearnedBindings: summary counts mixed sources correctly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-bindings-summary-"));
  try {
    const store = new LearnedBindings(root);
    store.seedParsed([{ from: A, to: B }], nowIso);
    // Parsed A→B has confirms=1. observeMeasurement with staticFiles=[A]
    // and measuredFiles=[B,A] activates A→B (B not in static).
    // applyMeasurement finds the parsed edge for A→B and increments confirms.
    store.observeMeasurement({
      classFqn: "Ns.Real",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now: nowIso,
    });
    // The parsed edge now has confirms=2, but source is still "parsed".
    assert.deepEqual(store.summary, { total: 1, mined: 0, parsed: 1 });
    // Now add a new mined edge (different from).
    store.observeMeasurement({
      classFqn: "Ns.Real2",
      abstractFiles: ["src/IRepo.cs"],
      measuredFiles: ["src/RepoImpl.cs", "src/IRepo.cs"],
      staticFiles: ["src/IRepo.cs"],
      now: nowIso,
    });
    assert.deepEqual(store.summary, { total: 2, mined: 1, parsed: 1 });
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  mineDelta: empty input edge cases                           */
/* ----------------------------------------------------------- */

test("mineDelta: empty measuredFiles yields no edges", () => {
  assert.deepEqual(
    mineDelta({
      staticFiles: ["a.cs"],
      measuredFiles: [],
      abstractFiles: ["b.cs"],
    }),
    []
  );
});

test("mineDelta: empty staticFiles — first measurement, no baseline", () => {
  // No static baseline means ALL measured files are Δ.
  const d = mineDelta({
    staticFiles: [],
    measuredFiles: ["src/T.cs", "src/ServiceImpl.cs"],
    abstractFiles: ["src/IService.cs"],
  });
  assert.deepEqual(
    d.map((x) => JSON.stringify(x)).sort(),
    [JSON.stringify({ from: "src/IService.cs", to: "src/ServiceImpl.cs" }), JSON.stringify({ from: "src/IService.cs", to: "src/T.cs" })].sort()
  );
});

test("mineDelta: empty abstractFiles yields no edges (nothing to attribute to)", () => {
  assert.deepEqual(
    mineDelta({
      staticFiles: ["a.cs"],
      measuredFiles: ["b.cs"],
      abstractFiles: [],
    }),
    []
  );
});

test("mineDelta: duplicate files in measured are deduplicated", () => {
  // Even if measuredFiles has duplicates, each (from, to) pair appears at most once.
  const d = mineDelta({
    staticFiles: [],
    measuredFiles: ["b.cs", "b.cs", "c.cs"],
    abstractFiles: ["a.cs"],
  });
  assert.equal(d.length, 2, "deduplicated: b.cs and c.cs → one edge each from a.cs");
});

/* ----------------------------------------------------------- */
/*  selectLearningTargets: empty / edge inputs                  */
/* ----------------------------------------------------------- */

test("selectLearningTargets: empty unmeasured yields empty list", () => {
  const r = selectLearningTargets({ unmeasured: [], measuredAbstractFiles: new Set(), table: {}, budget: 10 });
  assert.deepEqual(r, []);
});

test("selectLearningTargets: budget 0 yields empty list", () => {
  const r = selectLearningTargets({
    unmeasured: [{ classFqn: "Ns.A", abstractFiles: ["a.cs"] }],
    measuredAbstractFiles: new Set(),
    table: {},
    budget: 0,
  });
  assert.deepEqual(r, []);
});

test("selectLearningTargets: all abstractions resolved yields empty list", () => {
  const r = selectLearningTargets({
    unmeasured: [
      { classFqn: "Ns.A", abstractFiles: ["a.cs"] },
      { classFqn: "Ns.B", abstractFiles: ["b.cs"] },
    ],
    measuredAbstractFiles: new Set(["a.cs", "b.cs"]),
    table: {},
    budget: 10,
  });
  assert.deepEqual(r, []);
});

/* ----------------------------------------------------------- */
/*  shouldDrop: edge cases at the threshold                     */
/* ----------------------------------------------------------- */

test("shouldDrop: exactly at threshold drops, one below keeps", () => {
  // CONTRADICT_MIN = 4, CONTRADICT_RATIO = 2.
  // c=2: needs > 4, so 4 keeps, 5 drops.
  const mk = (c: number, d: number) => ({ to: "x", source: "mined" as const, confirms: c, contradicts: d, lastSeen: nowIso, evidence: [] });
  assert.equal(shouldDrop(mk(2, 4)), false, "contradicts=4 with confirms=2: keeps");
  assert.equal(shouldDrop(mk(2, 5)), true, "contradicts=5 with confirms=2: drops");
  // c=1: needs > 2, so 2 keeps, 3 drops (but CONTRADICT_MIN=4 means 3 < 4 → keeps).
  assert.equal(shouldDrop(mk(1, 3)), false, "contradicts=3 with confirms=1: keeps (below CONTRADICT_MIN)");
  assert.equal(shouldDrop(mk(1, 4)), true, "contradicts=4 with confirms=1: drops");
});

/* ----------------------------------------------------------- */
/*  decayBindings: all edges stale                              */
/* ----------------------------------------------------------- */

test("decayBindings: all edges stale yields empty table", () => {
  const old = (ts: number) => ({ to: "x", source: "mined" as const, confirms: 1, contradicts: 0, lastSeen: new Date(ts).toISOString(), evidence: [] });
  const t = decayBindings(
    { "a": [old(NOW - DECAY_MS - 1000), old(NOW - DECAY_MS - 2000)] },
    NOW
  );
  assert.deepEqual(t, {});
});

/* ----------------------------------------------------------- */
/*  applyMeasurement: no Δ but confirm/contradict still fires   */
/* ----------------------------------------------------------- */

test("applyMeasurement: no Δ (measured ⊆ static) still confirms/contradicts existing edges", () => {
  const A2 = "src/I.cs";
  const B2 = "src/Impl.cs";
  // BindingTable keys are lower-cased (store contract).
  const table: BindingTable = { [A2.toLowerCase()]: [{ to: B2, source: "mined" as const, confirms: 1, contradicts: 0, lastSeen: nowIso, evidence: [] }] };
  // No Δ (measured === static) but the abstraction is referenced → confirm.
  const t = applyMeasurement(table, {
    classFqn: "Ns.A",
    abstractFiles: [A2],
    measuredFiles: ["src/Impl.cs", "src/I.cs"],
    staticFiles: ["src/Impl.cs", "src/I.cs"],
    now: nowIso,
  });
  assert.equal(t[A2.toLowerCase()]![0].confirms, 2, "edge confirmed even without Δ");
  assert.equal(t[A2.toLowerCase()]![0].contradicts, 0, "not contradicted");
});
