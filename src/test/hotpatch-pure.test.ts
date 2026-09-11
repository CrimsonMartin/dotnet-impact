import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  apiGuardExemptFor,
  fastPathDiagnosticEvents,
  parseHostRegistration,
  shadowToRepoPath,
} from "../core/hotpatch";

/* ================================================================== */
/*  shadowToRepoPath — path mapping from delta-service shadow worktree */
/*  back into the real repo.                                          */
/* ================================================================== */

test("shadowToRepoPath: strips unix shadow prefix and rejoins onto repo root", () => {
  const shadow = "/tmp/impact-abc123/shadow";
  const repo = "/home/user/my-repo";
  assert.equal(
    shadowToRepoPath(shadow, repo, "/tmp/impact-abc123/shadow/src/Lib/Foo.cs"),
    "/home/user/my-repo/src/Lib/Foo.cs"
  );
});

test("shadowToRepoPath: strips Windows-style shadow prefix", () => {
  const shadow = "C:\\Users\\user\\impact-abc123\\shadow";
  const repo = "C:\\Users\\user\\my-repo";
  // On Linux, path.join preserves backslashes in args but uses unix separators.
  // The key invariant is that the shadow prefix is stripped and repo is prepended.
  const result = shadowToRepoPath(shadow, repo, "C:\\Users\\user\\impact-abc123\\shadow\\src\\Lib\\Foo.cs");
  assert.ok(result.includes("my-repo"), "result contains repo root");
  assert.ok(result.includes("src/Lib/Foo.cs") || result.includes("src\\Lib\\Foo.cs"), "repo-relative path preserved");
});

test("shadowToRepoPath: case-insensitive prefix match (Windows)", () => {
  const shadow = "C:\\Users\\user\\IMPACT-abc123\\shadow";
  const repo = "C:\\Users\\user\\my-repo";
  const result = shadowToRepoPath(shadow, repo, "c:\\users\\user\\impact-abc123\\shadow\\src\\Lib\\Foo.cs");
  assert.ok(result.includes("my-repo"), "result contains repo root");
  assert.ok(result.includes("src/Lib/Foo.cs") || result.includes("src\\Lib\\Foo.cs"), "repo-relative path preserved");
});

test("shadowToRepoPath: trailing slashes in prefix handled", () => {
  assert.equal(
    shadowToRepoPath("/tmp/shadow/", "/repo", "/tmp/shadow//src/Foo.cs"),
    "/repo/src/Foo.cs"
  );
});

test("shadowToRepoPath: paths outside shadow pass through unchanged", () => {
  const shadow = "/tmp/impact-abc123/shadow";
  const repo = "/home/user/my-repo";
  assert.equal(
    shadowToRepoPath(shadow, repo, "/etc/nuget/packages/system.text.json/6.0.0/lib/net6.0/System.Text.Json.dll"),
    "/etc/nuget/packages/system.text.json/6.0.0/lib/net6.0/System.Text.Json.dll"
  );
});

test("shadowToRepoPath: relative paths pass through unchanged", () => {
  assert.equal(
    shadowToRepoPath("/tmp/impact/shadow", "/repo", "src/Lib/Foo.cs"),
    "src/Lib/Foo.cs"
  );
});

test("shadowToRepoPath: nested shadow directory structures preserved", () => {
  assert.equal(
    shadowToRepoPath("/tmp/impact-abc/shadow", "/repo", "/tmp/impact-abc/shadow/src/Lib/Deep/Nested/Foo.cs"),
    "/repo/src/Lib/Deep/Nested/Foo.cs"
  );
});

/* ================================================================== */
/*  apiGuardExemptFor — cross-project API guard BFS over graph        */
/* ================================================================== */

function makeGraph(
  projects: Record<string, { name: string; deps: string[] }>
): import("../core/projects").ProjectGraph {
  const projMap = new Map<string, import("../core/projects").ProjectInfo>();
  const referencedBy = new Map<string, Set<string>>();
  for (const [key, info] of Object.entries(projects)) {
    const resolved = path.resolve(key);
    const norm = resolved.toLowerCase();
    projMap.set(norm, {
      csproj: resolved,
      dir: resolved.replace(/\.csproj$/, ""),
      name: info.name,
      assemblyName: info.name,
      references: info.deps.map((d) => path.resolve(d)),
      isTestProject: key.includes(".Tests"),
      usesMtpRunner: false,
    });
    if (!referencedBy.has(norm)) referencedBy.set(norm, new Set());
    for (const dep of info.deps) {
      const depNorm = path.resolve(dep).toLowerCase();
      if (!referencedBy.has(depNorm)) referencedBy.set(depNorm, new Set());
      referencedBy.get(depNorm)!.add(norm);
    }
  }
  return { root: os.tmpdir(), projects: projMap, referencedBy };
}

test("apiGuardExemptFor: owner with no dependents is always exempt", () => {
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
  });
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(graph, [path.resolve("A.csproj")], () => false);
  assert.deepEqual(exemptAbs, [path.resolve("A.csproj")]);
  assert.deepEqual(loadAlsoAbs, []);
});

test("apiGuardExemptFor: all dependents have baselines → exempt + load also", () => {
  // B → A (B depends on A); A is the owner.
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
    "B.Tests.csproj": { name: "B.Tests", deps: ["A.csproj"] },
  });
  const aAbs = path.resolve("A.csproj");
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [aAbs],
    (csproj) => csproj.toLowerCase() === path.resolve("B.Tests.csproj").toLowerCase()
  );
  assert.deepEqual(exemptAbs, [aAbs]);
  assert.deepEqual(loadAlsoAbs, [path.resolve("B.Tests.csproj")]);
});

test("apiGuardExemptFor: missing baseline blocks exemption", () => {
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
    "B.Tests.csproj": { name: "B.Tests", deps: ["A.csproj"] },
    "C.Tests.csproj": { name: "C.Tests", deps: ["A.csproj"] },
  });
  // B has baseline, C does not → A is NOT exempt
  // loadAlso only includes baseline-having deps (B), not C (no baseline)
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [path.resolve("A.csproj")],
    (csproj) => csproj.toLowerCase() === path.resolve("B.Tests.csproj").toLowerCase()
  );
  assert.deepEqual(exemptAbs, []);
  assert.deepEqual(loadAlsoAbs, [path.resolve("B.Tests.csproj")]);
});

test("apiGuardExemptFor: transitive dependents tracked (A → B → C)", () => {
  // C → B → A (C depends on B, B depends on A). Owner is A.
  // Only C has baseline, B does not → A is NOT exempt.
  // loadAlso = [C] only (B has no baseline).
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
    "B.csproj": { name: "B", deps: ["A.csproj"] },
    "C.Tests.csproj": { name: "C.Tests", deps: ["B.csproj"] },
  });
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [path.resolve("A.csproj")],
    (csproj) => csproj.toLowerCase() === path.resolve("C.Tests.csproj").toLowerCase()
  );
  assert.deepEqual(exemptAbs, []); // B has no baseline
  assert.deepEqual(loadAlsoAbs, [path.resolve("C.Tests.csproj")]); // only C has baseline
});

test("apiGuardExemptFor: multiple owners tracked independently", () => {
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
    "B.csproj": { name: "B", deps: [] },
    "T.Tests.csproj": { name: "T.Tests", deps: ["A.csproj", "B.csproj"] },
  });
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [path.resolve("A.csproj"), path.resolve("B.csproj")],
    (csproj) => csproj.toLowerCase() === path.resolve("T.Tests.csproj").toLowerCase()
  );
  assert.deepEqual(exemptAbs.sort(), [path.resolve("A.csproj"), path.resolve("B.csproj")].sort());
  assert.deepEqual(loadAlsoAbs, [path.resolve("T.Tests.csproj")]);
});

test("apiGuardExemptFor: owner with no baseline dependents loads nothing extra", () => {
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
    "T.Tests.csproj": { name: "T.Tests", deps: ["A.csproj"] },
  });
  // No deps have baselines → not exempt, nothing to load
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [path.resolve("A.csproj")],
    () => false
  );
  assert.deepEqual(exemptAbs, []);
  assert.deepEqual(loadAlsoAbs, []);
});

test("apiGuardExemptFor: owner not in graph still processed", () => {
  const graph = makeGraph({
    "B.csproj": { name: "B", deps: [] },
  });
  // "A.csproj" is not in the graph but should still be processed
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [path.resolve("A.csproj")],
    () => false
  );
  assert.deepEqual(exemptAbs, [path.resolve("A.csproj")]); // no deps, no dependents → exempt
  assert.deepEqual(loadAlsoAbs, []);
});

test("apiGuardExemptFor: diamond dependency resolved", () => {
  // C → A, D → A, C → B → A (diamond)
  // Only C has baseline, B and D do not → not exempt.
  // loadAlso = [C] only.
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
    "B.csproj": { name: "B", deps: ["A.csproj"] },
    "C.Tests.csproj": { name: "C.Tests", deps: ["A.csproj", "B.csproj"] },
    "D.Tests.csproj": { name: "D.Tests", deps: ["A.csproj"] },
  });
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [path.resolve("A.csproj")],
    (csproj) => csproj.toLowerCase() === path.resolve("C.Tests.csproj").toLowerCase()
  );
  assert.deepEqual(exemptAbs, []); // B and D have no baselines
  assert.deepEqual(loadAlsoAbs, [path.resolve("C.Tests.csproj")]); // only C has baseline
});

test("apiGuardExemptFor: all dependents have baselines in diamond", () => {
  const graph = makeGraph({
    "A.csproj": { name: "A", deps: [] },
    "B.csproj": { name: "B", deps: ["A.csproj"] },
    "C.Tests.csproj": { name: "C.Tests", deps: ["A.csproj", "B.csproj"] },
    "D.Tests.csproj": { name: "D.Tests", deps: ["A.csproj"] },
  });
  // All have baselines → exempt, all in loadAlso
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(
    graph,
    [path.resolve("A.csproj")],
    () => true
  );
  assert.deepEqual(exemptAbs, [path.resolve("A.csproj")]);
  assert.equal(loadAlsoAbs.length, 3);
  assert.ok(loadAlsoAbs.includes(path.resolve("B.csproj")));
  assert.ok(loadAlsoAbs.includes(path.resolve("C.Tests.csproj")));
  assert.ok(loadAlsoAbs.includes(path.resolve("D.Tests.csproj")));
});

/* ================================================================== */
/*  fastPathDiagnosticEvents — map refused delta diagnostics to        */
/*  per-project "set" events.                                         */
/* ================================================================== */

test("fastPathDiagnosticEvents: groups diagnostics by owning project", () => {
  const shadow = "/tmp/shadow";
  const repo = "/repo";
  const diagnostics = [
    { id: "CS0103", severity: "error", message: "The name 'foo' does not exist", file: `${shadow}/src/A/Foo.cs`, startLine: 5, startCol: 10 },
    { id: "CS0103", severity: "error", message: "The name 'bar' does not exist", file: `${shadow}/src/A/Bar.cs`, startLine: 3, startCol: 1 },
    { id: "CS0103", severity: "error", message: "The name 'baz' does not exist", file: `${shadow}/src/B/Qux.cs`, startLine: 1, startCol: 1 },
  ];
  const projectRelFor = (abs: string) => {
    if (abs.includes("/src/A/")) return "A.csproj";
    if (abs.includes("/src/B/")) return "B.csproj";
    return undefined;
  };
  const events = fastPathDiagnosticEvents(diagnostics, shadow, repo, projectRelFor);
  assert.equal(events.length, 2);
  const aEvent = events.find((e) => e.projectRel === "A.csproj")!;
  assert.equal(aEvent.kind, "set");
  const aDiags = (aEvent as { kind: "set"; projectRel: string; diagnostics: unknown[] }).diagnostics;
  assert.equal(aDiags!.length, 2);
  const bEvent = events.find((e) => e.projectRel === "B.csproj")!;
  const bDiags = (bEvent as { kind: "set"; projectRel: string; diagnostics: unknown[] }).diagnostics;
  assert.equal(bDiags!.length, 1);
});

test("fastPathDiagnosticEvents: drops orphan diagnostics with no owner", () => {
  const diagnostics = [
    { id: "CS0103", severity: "error", message: "x", file: "/tmp/shadow/nuget/packages/lib.cs", startLine: 1, startCol: 1 },
  ];
  const projectRelFor = () => undefined;
  const events = fastPathDiagnosticEvents(diagnostics, "/tmp/shadow", "/repo", projectRelFor);
  assert.equal(events.length, 0);
});

test("fastPathDiagnosticEvents: maps shadow paths to repo paths in diagnostics", () => {
  const diagnostics = [
    { id: "CS0103", severity: "error", message: "x", file: "/tmp/shadow/src/Lib/Foo.cs", startLine: 5, startCol: 10 },
  ];
  const projectRelFor = (abs: string) => (abs.includes("/src/Lib/") ? "Lib.csproj" : undefined);
  const events = fastPathDiagnosticEvents(diagnostics, "/tmp/shadow", "/repo", projectRelFor);
  assert.equal(events.length, 1);
  const ev = events[0] as { kind: "set"; projectRel: string; diagnostics: Array<{ file: string }> };
  assert.equal(ev.diagnostics[0].file, "/repo/src/Lib/Foo.cs");
});

test("fastPathDiagnosticEvents: empty diagnostics produces no events", () => {
  const events = fastPathDiagnosticEvents([], "/tmp/shadow", "/repo", () => undefined);
  assert.equal(events.length, 0);
});

/* ================================================================== */
/*  parseHostRegistration — edge cases                                */
/* ================================================================== */

test("parseHostRegistration: empty string yields empty pipe name", () => {
  assert.deepEqual(parseHostRegistration(""), { pipeName: "" });
});

test("parseHostRegistration: null-like content", () => {
  assert.deepEqual(parseHostRegistration("\n\n"), { pipeName: "" });
});

test("parseHostRegistration: single pipe name with no second line", () => {
  assert.deepEqual(parseHostRegistration("impact-abc"), { pipeName: "impact-abc" });
});

test("parseHostRegistration: trailing newline only", () => {
  assert.deepEqual(parseHostRegistration("\n"), { pipeName: "" });
});

test("parseHostRegistration: pipe name with special characters preserved", () => {
  assert.deepEqual(parseHostRegistration("impact-abc123-def-4567"), {
    pipeName: "impact-abc123-def-4567",
  });
});
