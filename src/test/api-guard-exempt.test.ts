import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { apiGuardExemptFor } from "../core/hotpatch";
import { ProjectGraph, ProjectInfo } from "../core/projects";

/**
 * #22 exemption rule, pure half: a changed project may skip the cross-project
 * API-surface guard only when EVERY transitive dependent has a baseline —
 * anything less and the guard behaves exactly as before the solution-wide
 * session existed.
 */

function fakeGraph(edges: Record<string, string[]>): ProjectGraph {
  // edges: project -> projects it references (like csproj ProjectReference).
  const projects = new Map<string, ProjectInfo>();
  const referencedBy = new Map<string, Set<string>>();
  const abs = (n: string) => path.resolve(`/repo/src/${n}/${n}.csproj`);
  const key = (n: string) => abs(n).toLowerCase();
  for (const name of Object.keys(edges)) {
    projects.set(key(name), {
      csproj: abs(name),
      dir: path.resolve(`/repo/src/${name}`),
      name,
      assemblyName: name,
      references: edges[name].map(abs),
      isTestProject: name.endsWith("Tests"),
    });
  }
  for (const [name, refs] of Object.entries(edges)) {
    for (const ref of refs) {
      const rk = key(ref);
      if (!referencedBy.has(rk)) referencedBy.set(rk, new Set());
      referencedBy.get(rk)!.add(key(name));
    }
  }
  return { root: "/repo", projects, referencedBy };
}

const A = path.resolve("/repo/src/Lib/Lib.csproj");

test("all transitive dependents baselined: owner exempt, dependents queued for loading", () => {
  const graph = fakeGraph({ Lib: [], Mid: ["Lib"], MidTests: ["Mid"], LibTests: ["Lib"] });
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(graph, [A], () => true);
  assert.deepEqual(exemptAbs, [A]);
  assert.deepEqual(
    loadAlsoAbs.map((p) => path.basename(p)).sort(),
    ["LibTests.csproj", "Mid.csproj", "MidTests.csproj"],
    "every transitive dependent joins the session"
  );
});

test("one dependent without a baseline anywhere in the chain kills the exemption", () => {
  const graph = fakeGraph({ Lib: [], Mid: ["Lib"], MidTests: ["Mid"] });
  const noMidTests = (csprojAbs: string) => !csprojAbs.includes("MidTests");
  const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(graph, [A], noMidTests);
  assert.deepEqual(exemptAbs, [], "an unbaselined TRANSITIVE dependent (MidTests) blocks exemption");
  assert.deepEqual(
    loadAlsoAbs.map((p) => path.basename(p)),
    ["Mid.csproj"],
    "dependents that DO have baselines still load — body edits benefit regardless"
  );
});

test("a leaf with no dependents is trivially exempt; owners are judged independently", () => {
  const graph = fakeGraph({ Lib: [], Standalone: [], StandaloneTests: ["Standalone"] });
  const standalone = path.resolve("/repo/src/Standalone/Standalone.csproj");
  const noBaselines = () => false;
  const { exemptAbs } = apiGuardExemptFor(graph, [A, standalone], noBaselines);
  assert.deepEqual(exemptAbs, [A], "Lib has no dependents → exempt; Standalone's dependent lacks a baseline → not");
});
