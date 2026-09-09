import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { pruneBindings } from "../core/bindings";
import { Runner } from "../core/runner";
import { cacheDirFor, toRepoRelative } from "../core/util";
import { dotnetOrNull, scaffoldDiRepo } from "./di-fixture";

/**
 * #31 step 5 end to end: contradiction + staleness + the safety-net rule.
 * A learned edge is evidence, not a fact — when the world changes (the
 * convention now binds a different implementation), enough contradicting
 * measurements must drop it and selection must revert. Also pins the
 * MINED_CONFIRM_TO_COVER safety net: once the impl file leaves every row,
 * a single-evidence edge must NOT suppress the project-level fallback (a
 * one-measurement edge may be attributed to the wrong abstraction, and
 * suppressing the fallback on it is the only way a learned edge could
 * shrink selection). Also pins the buildMap-time decay/prune maintenance.
 */
test("contradictions drop learned edges; decay and prune maintain the store", {
  timeout: 1200_000,
}, () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK: nothing to test against
  const root = scaffoldDiRepo();
  const runner = new Runner(root);
  return (async () => {
    await runner.prepare();
    const discovered = await runner.discoverAll({});
    const res = await runner.buildMap({
      discovered,
      onPhase: (m) => process.stderr.write(`[phase] ${m}\n`),
    });
    assert.equal(res.failed.length, 0, `buildMap failures: ${res.failed.join(", ")}`);

    // Phase 1: measure A once — the convention registers ServiceImpl, the
    // edge is learned. The impl file is named by A's measured row, so the
    // transfer is precise from the first confirmation: ATests via its row,
    // never-measured BTests via the binding, no fallback (file is known).
    runner.pendingRefresh.set("Demo.Tests.ATests", "tests/T/T.csproj");
    await runner.refreshPending({});
    let edges = runner.bindings.bindingsFor("src/Lib/IService.cs");
    assert.equal(edges.length, 1, `one edge (got ${JSON.stringify(edges)})`);
    assert.equal(edges[0].to, "src/Lib/ServiceImpl.cs");
    assert.equal(edges[0].confirms, 1);
    assert.equal(edges[0].contradicts, 0);
    const one = runner.computeAffected(["src/Lib/ServiceImpl.cs"]);
    assert.ok(one.classes.includes("Demo.Tests.ATests"), "measured ATests selected via its row");
    assert.ok(one.classes.includes("Demo.Tests.BTests"), "never-measured BTests via the binding");
    assert.equal(one.fallbackProjects.length, 0, "impl file is in A's measured row: no fallback");

    // Phase 2: the convention flips to ServiceOther; A's re-measure loses
    // the impl file, so ServiceImpl.cs is now in NO row (B's static closure
    // never had it). The edge survives (confirms=1, contradicts=1) but is
    // still one-evidence — and therefore must NOT cover: the project-level
    // fallback still runs (the safety net; BTests's tests run via the
    // project, never under-selected). A direct re-measure models "the user
    // re-ran after the refactor" (a fresh coverage row would skip
    // queueRefreshFromOutcomes).
    const appCs = path.join(root, "tests/T/App.cs");
    const flipped = fs
      .readFileSync(appCs, "utf8")
      .replace('t.Name.EndsWith("Impl")', 't.Name == "ServiceOther"');
    assert.notEqual(flipped, fs.readFileSync(appCs, "utf8"), "fixture flipped");
    fs.writeFileSync(appCs, flipped);
    await runner.resyncShadow(); // the shadow must see the out-of-band edit
    // Foreground runs build the shadow before measuring; the background
    // refresh assumes that happened, so the test does it too.
    const built = await runner.buildShadowProjects(["tests/T/T.csproj"]);
    assert.equal(built.ok, true, `shadow rebuild after the flip: ${built.failedRels.join(", ")}`);
    runner.pendingRefresh.set("Demo.Tests.ATests", "tests/T/T.csproj");
    await runner.refreshPending({});
    edges = runner.bindings.bindingsFor("src/Lib/IService.cs");
    const implEdge = edges.find((b) => b.to === "src/Lib/ServiceImpl.cs")!;
    assert.equal(implEdge.confirms, 1);
    assert.equal(implEdge.contradicts, 1, "the flip's re-measure contradicted the edge");
    const net = runner.computeAffected(["src/Lib/ServiceImpl.cs"]);
    assert.deepEqual(
      net.fallbackProjects.map((p) => toRepoRelative(root, p.csproj)).sort(),
      ["tests/T/T.csproj"],
      "one-evidence edge does not cover: project-level fallback still runs"
    );
    assert.deepEqual(net.classes, [], "fallback subsumes the mapped classes (no double-run)");

    // Phase 3: three more re-measurements push the edge past the drop
    // threshold (each contradicts — its target is no longer touched — while
    // confirming the fresh ServiceOther edge).
    for (let i = 0; i < 3; i++) {
      runner.pendingRefresh.set("Demo.Tests.ATests", "tests/T/T.csproj");
      await runner.refreshPending({});
    }

    // contradicts=4 >= CONTRADICT_MIN(4) and 4 > 2*confirms(1): dropped.
    edges = runner.bindings.bindingsFor("src/Lib/IService.cs");
    assert.equal(
      edges.filter((b) => b.to === "src/Lib/ServiceImpl.cs").length,
      0,
      `ServiceImpl edge dropped (got ${JSON.stringify(edges)})`
    );
    assert.ok(
      edges.some((b) => b.to === "src/Lib/ServiceOther.cs"),
      "the new reality was learned in the same measurements"
    );

    // Selection reverted: ServiceImpl.cs is in no row anymore (A's fresh
    // coverage row carries ServiceOther instead) → no class, project fallback.
    const affected = runner.computeAffected(["src/Lib/ServiceImpl.cs"]);
    assert.deepEqual(affected.classes, []);
    assert.deepEqual(
      affected.fallbackProjects.map((p) => toRepoRelative(root, p.csproj)).sort(),
      ["tests/T/T.csproj"]
    );

    // Phase 4: maintenance. Staleness decay drops edges unseen for >30 days.
    const before = runner.bindings.count;
    assert.ok(before > 0);
    runner.bindings.decay(Date.now() + 31 * 24 * 3600 * 1000);
    assert.equal(runner.bindings.count, 0, "all edges decayed past staleness");

    // And the path prune drops edges whose target or abstraction file is gone
    // (pure function; buildMap runs it against the live tree).
    const now = new Date().toISOString();
    const table = {
      "src/lib/iservice.cs": [
        { to: "src/Lib/ServiceImpl.cs", source: "mined" as const, confirms: 5, contradicts: 0, lastSeen: now, evidence: [] },
        { to: "src/Lib/Gone.cs", source: "mined" as const, confirms: 5, contradicts: 0, lastSeen: now, evidence: [] },
        { to: "src/Lib/ServiceOther.cs", source: "mined" as const, confirms: 5, contradicts: 0, lastSeen: now, evidence: [] },
      ],
      "src/lib/goneinterface.cs": [
        { to: "src/Lib/ServiceImpl.cs", source: "mined" as const, confirms: 5, contradicts: 0, lastSeen: now, evidence: [] },
      ],
    };
    const tree = new Set(
      ["src/Lib/IService.cs", "src/Lib/ServiceImpl.cs", "src/Lib/ServiceOther.cs", "tests/T/App.cs"].map(
        (f) => f.toLowerCase()
      )
    );
    const pruned = pruneBindings(table, tree);
    const kept = (pruned["src/lib/iservice.cs"] ?? []).map((b) => b.to).sort();
    assert.deepEqual(
      kept,
      ["src/Lib/ServiceImpl.cs", "src/Lib/ServiceOther.cs"],
      "dead targets pruned, live pairs kept"
    );
    assert.equal(pruned["src/lib/goneinterface.cs"]?.length ?? 0, 0, "dead abstraction row pruned");
  })().finally(() => {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
