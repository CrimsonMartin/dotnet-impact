import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { dotnetOrNull, scaffoldDiRepo } from "./di-fixture";

/**
 * #31 step 4 end to end — THE marquee test: the transfer effect today's
 * hybrid cannot produce.
 *
 * DI fixture: ATests is coverage-refreshed (learning
 * IService.cs ⇒ ServiceImpl.cs). BTests is NEVER measured. An edit to
 * ServiceImpl.cs must then select BTests as a mapped class via the learned
 * binding — and the changed file must stop triggering project-level
 * fallback (its effective closure now touches it). Controls: an unrelated
 * edit selects nothing, and the kill switch reverts to pre-#31 behavior.
 */
test("transfer: a learned binding selects a never-measured class", { timeout: 900_000 }, () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK: nothing to test against
  const root = scaffoldDiRepo();
  const runner = new Runner(root);
  return (async () => {
    await runner.prepare();
    const discovered = await runner.discoverAll({});
    const res = await runner.buildMap({ discovered });
    assert.equal(res.failed.length, 0, `buildMap failures: ${res.failed.join(", ")}`);

    runner.pendingRefresh.set("Demo.Tests.ATests", "tests/T/T.csproj");
    const refreshed = await runner.refreshPending({});
    assert.equal(refreshed, 1, "one class refreshed");
    assert.equal(runner.bindings.count, 1, "one learned edge");

    // Baseline (before the binding existed): editing the impl was a full
    // project fallback with no mapped classes. Now the learned binding
    // selects both static classes that reference IService…
    const affected = runner.computeAffected(["src/Lib/ServiceImpl.cs"]);
    assert.ok(
      affected.classes.includes("Demo.Tests.BTests"),
      `never-measured BTests selected via the learned binding (got ${affected.classes})`
    );
    assert.ok(affected.classes.includes("Demo.Tests.ATests"), "measured ATests still selected");
    // …and the file is no longer "unknown" — no project-level fallback.
    assert.equal(
      affected.fallbackProjects.length,
      0,
      "learned-covered file stops triggering project-level fallback"
    );

    // Control: the abstraction file itself is named by B's static row (A's
    // measured row doesn't include it — an interface has no executable
    // lines) — a normal row match, no binding involved.
    const abstractionEdit = runner.computeAffected(["src/Lib/IService.cs"]);
    assert.deepEqual(abstractionEdit.classes, ["Demo.Tests.BTests"]);
    // A truly unrelated file selects no mapped class (fallback only).
    const stray = runner.computeAffected(["src/Lib/StrayFile.cs"]);
    assert.deepEqual(stray.classes, []);

    // Kill switch: the transfer disappears — B is no longer selected. A is
    // still selected, but by the ordinary measured-row mechanism (its row
    // contains the file), not by the binding.
    runner.learnedBindingsEnabled = false;
    const off = runner.computeAffected(["src/Lib/ServiceImpl.cs"]);
    assert.ok(!off.classes.includes("Demo.Tests.BTests"), "kill switch: no learned selection");
    assert.ok(off.classes.includes("Demo.Tests.ATests"), "measured row still selects A");
    assert.equal(off.fallbackProjects.length, 0, "file mapped by A's row — no fallback either way");
  })().finally(() => {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
