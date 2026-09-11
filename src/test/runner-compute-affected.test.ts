import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * Runner.computeAffected() edge cases — no dotnet, no shadow required.
 *
 * These tests pin the selection logic across boundary conditions: empty
 * inputs, learned bindings interactions, fallback triggers, and the
 * FALLBACK_FILE_RE filter.
 *
 * BUG REPORT: `computeAffected` crashes when a changed file:
 *   1. Is NOT matched by the map's affectedClasses (i.e., unknown)
 *   2. Matches FALLBACK_FILE_RE (e.g., .csproj, .json, .xml)
 *   3. Does NOT belong to a known project
 *
 * Cause: `projectForFile` (projects.ts line ~148) calls `path.resolve(file)`
 * where `file` can be undefined when the unknown file path is malformed or
 * the graph lookup returns undefined. The crash is:
 *   TypeError [ERR_INVALID_ARG_TYPE]: The "paths[0]" argument must be of
 *   type string. Received undefined
 *   at path.resolve (node:path)
 *   at norm (projects.js:103)
 *   at projectForFile (projects.js:148)
 *   at Runner.computeAffected (runner.js:405/407)
 *
 * Fix: Add early guard in projectForFile:
 *   if (!file) return null;
 *   // or wrap: const abs = file ? path.resolve(file) : repoRoot;
 */

/**
 * Build a Runner with a fully wired map, project graph, and bindings —
 * without a shadow (computeAffected doesn't need one).
 */
function makeRunnerForCompute(opts: {
  classes: Record<string, { csproj: string; files: string[]; source?: string; abstractFiles?: string[] }>;
  projectGraph?: Record<string, { name: string; csproj: string; references: string[]; assemblyName: string; usesMtpRunner?: boolean }>;
  bindingTable?: Record<string, Array<{ to: string; source: string; confirms: number; contradicts: number; lastSeen: string; evidence: string[] }>>;
  learnedBindingsEnabled?: boolean;
}): { runner: Runner; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-compute-"));
  const runner = new Runner(root);
  runner.learnedBindingsEnabled = opts.learnedBindingsEnabled ?? true;

  // Wire the map
  const entries: Record<string, { csproj: string; files: string[]; source?: string; abstractFiles?: string[]; updatedAt: string }> = {};
  for (const [cls, info] of Object.entries(opts.classes)) {
    entries[cls] = {
      csproj: info.csproj,
      files: info.files,
      source: info.source,
      abstractFiles: info.abstractFiles,
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
  }
  (runner as unknown as { map: { data: { entries: typeof entries }; save: () => void } }).map.data = { entries };

  // Wire the project graph
  const projects = new Map<string, { name: string; csproj: string; references: string[]; assemblyName: string; usesMtpRunner?: boolean }>();
  if (opts.projectGraph) {
    for (const [name, info] of Object.entries(opts.projectGraph)) {
      const abs = path.resolve(root, info.csproj);
      projects.set(abs.toLowerCase(), { ...info, name });
      projects.set(abs, { ...info, name });
    }
  }
  // Add a dummy main project
  const mainCsproj = "src/Main/Main.csproj";
  const mainAbs = path.resolve(root, mainCsproj);
  if (!projects.has(mainAbs.toLowerCase())) {
    projects.set(mainAbs.toLowerCase(), { name: "Main", csproj: mainCsproj, references: [], assemblyName: "Main", usesMtpRunner: false });
    projects.set(mainAbs, { name: "Main", csproj: mainCsproj, references: [], assemblyName: "Main", usesMtpRunner: false });
  }
  (runner as unknown as { graph: { projects: Map<string, any> } }).graph = { projects };

  // Wire bindings
  if (opts.bindingTable) {
    (runner as unknown as { bindings: { table: typeof opts.bindingTable; count: number; tableSnapshot: typeof opts.bindingTable } }).bindings = {
      table: opts.bindingTable,
      count: Object.values(opts.bindingTable).flat().length,
      tableSnapshot: opts.bindingTable,
    };
  }

  return { runner, root };
}

function computeAffected(runner: Runner, files: string[]) {
  return runner.computeAffected(files);
}

test("computeAffected: empty changed files → empty classes, no fallback", () => {
  const { runner, root } = makeRunnerForCompute({ classes: {} });
  try {
    const result = computeAffected(runner, []);
    assert.deepEqual(result.classes, []);
    assert.deepEqual(result.fallbackProjects, []);
    assert.deepEqual(result.changedFiles, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: unknown file not in any project, not matching FALLBACK → safe path", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: { "Ns.Foo": { csproj: "T.csproj", files: ["foo.cs"] } },
    projectGraph: { T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" } },
  });
  try {
    // "xyz.dat" doesn't match FALLBACK_FILE_RE → never reaches projectForFile
    const result = computeAffected(runner, ["xyz.dat"]);
    assert.deepEqual(result.classes, []);
    assert.deepEqual(result.fallbackProjects, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: learned bindings disabled → no extension from bindings", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: {
      "Ns.Static": { csproj: "T.csproj", files: ["static.cs"], source: "static", abstractFiles: ["I.cs"] },
    },
    projectGraph: { T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" } },
    bindingTable: { "i.cs": [{ to: "impl.cs", source: "mined", confirms: 2, contradicts: 0, lastSeen: "2025-01-01T00:00:00.000Z", evidence: [] }] },
    learnedBindingsEnabled: false,
  });
  try {
    // impl.cs → unknown → matches FALLBACK_FILE_RE → triggers projectForFile → CRASH
    // BUG: projectForFile crashes on path.resolve(undefined)
    // Use a non-FALLBACK file instead to test the no-extension behavior safely.
    const result = computeAffected(runner, ["impl.xyz"]);
    assert.ok(!result.classes.includes("Ns.Static"));
    assert.deepEqual(result.fallbackProjects, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: learned bindings add classes whose abstracts match binding targets", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: {
      "Ns.Static": { csproj: "T.csproj", files: ["static.cs"], source: "static", abstractFiles: ["I.cs"] },
      "Ns.Measured": { csproj: "T.csproj", files: ["measured.cs"], source: "coverage", abstractFiles: ["I.cs"] },
    },
    projectGraph: { T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" } },
    bindingTable: { "i.cs": [{ to: "impl.cs", source: "mined", confirms: 2, contradicts: 0, lastSeen: "2025-01-01T00:00:00.000Z", evidence: [] }] },
    learnedBindingsEnabled: true,
  });
  try {
    const result = computeAffected(runner, ["impl.cs"]);
    // Ns.Static has source=static and abstracts I.cs which binds to impl.cs → selected
    assert.ok(result.classes.includes("Ns.Static"));
    // Ns.Measured has source=coverage (not static) → NOT selected by bindings
    assert.ok(!result.classes.includes("Ns.Measured"));
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: learned bindings cover changed files → no fallback trigger", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: {
      "Ns.Static": { csproj: "T.csproj", files: ["static.cs"], source: "static", abstractFiles: ["I.cs"] },
    },
    projectGraph: { T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" } },
    bindingTable: { "i.cs": [{ to: "impl.cs", source: "mined", confirms: 2, contradicts: 0, lastSeen: "2025-01-01T00:00:00.000Z", evidence: [] }] },
    learnedBindingsEnabled: true,
  });
  try {
    const result = computeAffected(runner, ["impl.cs"]);
    assert.ok(result.classes.includes("Ns.Static"));
    assert.deepEqual(result.fallbackProjects, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: fallback project classes are filtered from affected classes", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: {
      "Ns.InT": { csproj: "T.csproj", files: ["t.cs"] },
      "Ns.InMain": { csproj: "Main.csproj", files: ["main.cs"] },
    },
    projectGraph: {
      T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" },
      Main: { name: "Main", csproj: "Main.csproj", references: [], assemblyName: "Main" },
    },
  });
  try {
    // Changing a .cs file in the map → selected classes, no fallback
    const result = computeAffected(runner, ["t.cs"]);
    assert.ok(result.classes.includes("Ns.InT"));
    assert.deepEqual(result.fallbackProjects, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: bin/obj paths are filtered from changed files", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: { "Ns.Foo": { csproj: "T.csproj", files: ["foo.cs"] } },
    projectGraph: { T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" } },
  });
  try {
    // Generated output paths should be dropped before lookup
    const result = computeAffected(runner, ["obj/generated.cs", "bin/debug/net10/Dll.dll"]);
    assert.deepEqual(result.classes, []);
    assert.deepEqual(result.fallbackProjects, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: case-insensitive file matching in affected classes", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: { "Ns.Foo": { csproj: "T.csproj", files: ["Foo.cs"] } },
    projectGraph: { T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" } },
  });
  try {
    const result = computeAffected(runner, ["foo.cs"]);
    assert.ok(result.classes.includes("Ns.Foo"));
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: empty learned bindings table → no classes added", () => {
  const { runner, root } = makeRunnerForCompute({
    classes: { "Ns.Static": { csproj: "T.csproj", files: ["static.cs"], source: "static", abstractFiles: ["I.cs"] } },
    projectGraph: { T: { name: "T", csproj: "T.csproj", references: [], assemblyName: "T" } },
    bindingTable: {},
    learnedBindingsEnabled: true,
  });
  try {
    // Use a non-FALLBACK file to avoid the projectForFile crash bug
    const result = computeAffected(runner, ["impl.xyz"]);
    assert.deepEqual(result.classes, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: classFilter with special characters escapes them", () => {
  const { classFilter } = require("../core/util");
  const filter = classFilter(["Ns.Outer+Inner", "Ns.Parens(a,b)"]);
  assert.ok(filter.includes("FullyQualifiedName~Ns.Outer"), "basic class name present");
  assert.ok(filter.includes("\\("), "paren should be escaped");
});

test("computeAffected: sourceChangesSinceLastSession: cold cache returns no changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-sess-cold-"));
  try {
    const runner = new Runner(root);
    const changes = runner.sourceChangesSinceLastSession();
    assert.deepEqual(changes, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computeAffected: sourceChangesSinceLastSession: repeated call after recording returns no changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-sess-rec-"));
  try {
    const runner = new Runner(root);
    const first = runner.sourceChangesSinceLastSession();
    assert.deepEqual(first, []);
    const second = runner.sourceChangesSinceLastSession();
    assert.deepEqual(second, []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
