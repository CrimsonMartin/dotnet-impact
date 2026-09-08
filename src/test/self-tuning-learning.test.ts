import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { dotnetOrNull, scaffoldDiRepo } from "./di-fixture";

/**
 * #31 step 4 end to end: the active-learning pass. Nobody queues a refresh;
 * refreshPending drains the (empty) queue, then deliberately samples the
 * unmeasured class whose measurement would teach the most — ATests, the
 * only class referencing the unresolved IService — and the measurement
 * learns the binding. BTests then gets the transfer with the user never
 * having touched a test.
 */
test("active learning: the pass measures the informative class and learns", { timeout: 900_000 }, () => {
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
    assert.equal(runner.pendingRefresh.size, 0, "nobody queued a refresh");
    // Budget 1: before any measurement both classes are equally informative,
    // so a larger budget would sample both. One sample is enough to show
    // the transfer: ATests (FQN-ascending tie-break) gets measured, BTests
    // stays static.
    runner.learningBudget = 1;

    const refreshed = await runner.refreshPending({});
    assert.equal(refreshed, 1, "the pass sampled exactly one class");

    // It sampled ATests (the informative one) and learned from it.
    assert.equal(runner.map.entry("Demo.Tests.ATests")!.source, "coverage");
    const edges = runner.bindings.bindingsFor("src/Lib/IService.cs");
    assert.equal(edges.length, 1, `one learned edge (got ${JSON.stringify(edges)})`);
    assert.equal(edges[0].to, "src/Lib/ServiceImpl.cs");
    assert.deepEqual(edges[0].evidence, ["Demo.Tests.ATests"]);
    // BTests was never measured — its knowledge came from the transfer.
    assert.equal(runner.map.entry("Demo.Tests.BTests")!.source, "static");

    // The transfer works.
    const affected = runner.computeAffected(["src/Lib/ServiceImpl.cs"]);
    assert.ok(affected.classes.includes("Demo.Tests.BTests"), "BTests selected via the learned binding");
    assert.equal(affected.fallbackProjects.length, 0, "learned-covered file is not unknown");

    // The pass is idempotent: a second drain samples nothing (IService is
    // resolved now) and refreshes nothing.
    assert.equal(await runner.refreshPending({}), 0, "no further sampling once resolved");
  })().finally(() => {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
