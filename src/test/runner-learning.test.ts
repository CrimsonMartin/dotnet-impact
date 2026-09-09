import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Binding, BindingTable } from "../core/bindings";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * #31 step 5 — the Runner's learningTargets wiring, as pure unit tests
 * (no dotnet, no build): which rows count as unmeasured candidates and which
 * abstractions count as resolved is the Runner's job (the scoring itself is
 * selectLearningTargets, pinned in bindings.test.ts).
 */
type Row = { csproj: string; files: string[]; source?: "static" | "coverage"; abstractFiles?: string[]; updatedAt: string };

function binding(to: string): Binding {
  return { to, source: "mined", confirms: 1, contradicts: 0, lastSeen: new Date().toISOString(), evidence: [] };
}

function harness(rows: Record<string, Row>, table: BindingTable = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-learning-unit-"));
  const runner = new Runner(root);
  (runner as unknown as { map: unknown }).map = {
    classes: () => Object.keys(rows),
    entry: (f: string) => rows[f],
  };
  (runner as unknown as { bindings: unknown }).bindings = { tableSnapshot: table };
  const learningTargets = (runner as unknown as {
    learningTargets(tried: Set<string>): string[];
  }).learningTargets.bind(runner);
  return { root, runner, learningTargets };
}

test("learningTargets: static rows are candidates; coverage rows resolve their abstractions", () => {
  const rows: Record<string, Row> = {
    "Ns.Measured": { csproj: "T.csproj", files: ["t1.cs"], source: "coverage", abstractFiles: ["I.cs"], updatedAt: "x" },
    "Ns.Cand": { csproj: "T.csproj", files: ["c1.cs"], source: "static", abstractFiles: ["I.cs"], updatedAt: "x" },
    "Ns.Cand2": { csproj: "T.csproj", files: ["c2.cs"], source: "static", abstractFiles: ["I.cs", "J.cs"], updatedAt: "x" },
    "Ns.NoAbs": { csproj: "T.csproj", files: ["n.cs"], source: "static", updatedAt: "x" },
  };
  const { root, learningTargets } = harness(rows);
  try {
    // I.cs is resolved by the measured row → only J.cs is unresolved.
    // Ns.Cand2 shares it (score 1); Ns.Cand scores 0 and is dropped.
    assert.deepEqual(learningTargets(new Set()), ["Ns.Cand2"]);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("learningTargets: tried classes are excluded; budget caps; FQN tie-break", () => {
  const rows: Record<string, Row> = {
    "Ns.B": { csproj: "T.csproj", files: [], source: "static", abstractFiles: ["I.cs"], updatedAt: "x" },
    "Ns.A": { csproj: "T.csproj", files: [], source: "static", abstractFiles: ["I.cs"], updatedAt: "x" },
    "Ns.C": { csproj: "T.csproj", files: [], source: "static", abstractFiles: ["I.cs"], updatedAt: "x" },
  };
  const { root, runner, learningTargets } = harness(rows);
  try {
    assert.deepEqual(learningTargets(new Set()), ["Ns.A", "Ns.B", "Ns.C"]);
    assert.deepEqual(learningTargets(new Set(["Ns.A"])), ["Ns.B", "Ns.C"]);
    runner.learningBudget = 1;
    assert.deepEqual(learningTargets(new Set()), ["Ns.A"]);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("learningTargets: existing bindings resolve abstractions like measured rows do", () => {
  const rows: Record<string, Row> = {
    "Ns.A": { csproj: "T.csproj", files: [], source: "static", abstractFiles: ["I.cs", "J.cs"], updatedAt: "x" },
  };
  const table: BindingTable = { "i.cs": [binding("Impl.cs")] };
  const { root, learningTargets } = harness(rows, table);
  try {
    // I.cs is bound → resolved; J.cs is unresolved → still worth sampling.
    assert.deepEqual(learningTargets(new Set()), ["Ns.A"]);
    table["j.cs"] = [binding("Impl2.cs")];
    assert.deepEqual(learningTargets(new Set()), [], "nothing left to learn");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
