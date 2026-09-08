import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { dotnetOrNull, scaffoldDiRepo } from "./di-fixture";

/**
 * #31 step 1+2 end to end: the Δ-mining hook in live map refresh.
 *
 * On the DI fixture the static closure misses ServiceImpl.cs (the
 * convention-based registration names it in no IL token) while a coverage
 * run of ATests executes it. The refresh pipeline must — before the static
 * row is overwritten — attribute that gap to the abstraction ATests
 * references and record the binding IService.cs ⇒ ServiceImpl.cs in the
 * per-repo store, with ATests as evidence. BTests is left untouched (its
 * transfer to is PR3's job).
 */
test("Δ-mining: coverage refresh of one class learns the binding edge", { timeout: 900_000 }, () => {
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

    const aEntry = runner.map.entry("Demo.Tests.ATests");
    assert.ok(aEntry, "ATests mapped");
    assert.equal(aEntry!.source, "static");
    assert.ok(
      aEntry!.files.includes("src/Lib/IService.cs"),
      `premise: closure sees the abstraction (${aEntry!.files})`
    );
    assert.ok(
      !aEntry!.files.includes("src/Lib/ServiceImpl.cs"),
      `premise: closure misses the impl (${aEntry!.files})`
    );
    assert.ok(aEntry!.abstractFiles?.includes("src/Lib/IService.cs"), "abstractFiles present");
    assert.equal(runner.bindings.count, 0, "nothing learned before any measurement");

    runner.pendingRefresh.set("Demo.Tests.ATests", "tests/T/T.csproj");
    const refreshed = await runner.refreshPending({});
    assert.equal(refreshed, 1, "one class refreshed");

    // The row is now measured and includes the impl…
    const aAfter = runner.map.entry("Demo.Tests.ATests")!;
    assert.equal(aAfter.source, "coverage");
    assert.ok(aAfter.files.includes("src/Lib/ServiceImpl.cs"), `measured row sees the impl (${aAfter.files})`);
    // …and the binding was learned from the Δ.
    const edges = runner.bindings.bindingsFor("src/Lib/IService.cs");
    assert.equal(edges.length, 1, `exactly one learned edge (got ${JSON.stringify(edges)})`);
    assert.equal(edges[0].to, "src/Lib/ServiceImpl.cs");
    assert.equal(edges[0].source, "mined");
    assert.equal(edges[0].confirms, 1);
    assert.deepEqual(edges[0].evidence, ["Demo.Tests.ATests"]);
    // BTests is untouched: still static, still blind to the impl (PR3 transfers).
    const bAfter = runner.map.entry("Demo.Tests.BTests")!;
    assert.equal(bAfter.source, "static");
    assert.ok(!bAfter.files.includes("src/Lib/ServiceImpl.cs"));
    // abstractFiles survive the static → coverage replacement (static fact).
    assert.ok(aAfter.abstractFiles?.includes("src/Lib/IService.cs"));
  })().finally(() => {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
