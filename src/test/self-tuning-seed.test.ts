import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { dotnetOrNull, scaffoldDiRepo } from "./di-fixture";

/**
 * #31 step 3 end to end: the registration-parser seed path with ZERO test
 * runs. The fixture's CompositionRoot carries the classic typed
 * registration `AddScoped<IService, ServiceImpl>()` in source (no test
 * class calls it, so no closure contains the impl). buildMap alone must
 * seed the binding from source, and an edit to the impl must then select
 * both test classes — without any coverage run ever happening.
 */
test("parser seed: zero coverage runs still transfer the binding", { timeout: 900_000 }, () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK: nothing to test against
  const root = scaffoldDiRepo({ withTypedRegistration: true });
  const runner = new Runner(root);
  return (async () => {
    await runner.prepare();
    const discovered = await runner.discoverAll({});
    const res = await runner.buildMap({
      discovered,
      onPhase: (m) => process.stderr.write(`[phase] ${m}\n`),
    });
    assert.equal(res.failed.length, 0, `buildMap failures: ${res.failed.join(", ")}`);

    // No coverage run happened — every row is static.
    for (const cls of runner.map.classes()) {
      assert.equal(runner.map.entry(cls)!.source, "static", `${cls} still static`);
    }

    // The parser seeded the binding from CompositionRoot's source.
    const edges = runner.bindings.bindingsFor("src/Lib/IService.cs");
    assert.equal(edges.length, 1, `exactly one seeded edge (got ${JSON.stringify(edges)})`);
    assert.equal(edges[0].to, "src/Lib/ServiceImpl.cs");
    assert.equal(edges[0].source, "parsed");

    // The transfer works with zero runs: an impl edit selects both classes
    // (neither's static closure contains the impl), and no fallback.
    const affected = runner.computeAffected(["src/Lib/ServiceImpl.cs"]);
    assert.deepEqual(
      affected.classes.sort(),
      ["Demo.Tests.ATests", "Demo.Tests.BTests"],
      "both classes selected via the parsed binding"
    );
    assert.equal(affected.fallbackProjects.length, 0, "seeded file is not unknown");
  })().finally(() => {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
