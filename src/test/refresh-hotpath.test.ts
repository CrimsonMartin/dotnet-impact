import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { HotPatcher } from "../core/hotpatch";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { DI_FILES, dotnetOrNull, scaffoldDiRepo } from "./di-fixture";

test("body edits stay hot after active learning uses the classic coverage collector", { timeout: 600_000 }, async (t) => {
  if (!dotnetOrNull()) return t.skip("requires the .NET SDK");
  const root = scaffoldDiRepo();
  const extension = path.join(__dirname, "../..");
  const logs: string[] = [];
  const runner = new Runner(root);
  const log = (message: string) => { logs.push(message); };
  runner.logSink = log;
  const hot = new HotPatcher(root, path.join(extension, "helper-deltas"), path.join(extension, "helper-hotpatch"), log);
  try {
    assert.equal(await hot.prepareRunsettings(), true, logs.join("\n"));
    runner.hotpatch = hot;
    runner.sessions = new SessionRunner(root, path.join(extension, "helper"), log, hot.runsettingsFile);
    await runner.prepare();
    const discovered = await runner.discoverAll({});
    assert.deepEqual((await runner.buildMap({ discovered })).failed, []);
    const file = "src/Lib/ServiceImpl.cs";
    const save = async (value: string) => {
      fs.writeFileSync(path.join(root, file), DI_FILES[file].replace('"impl"', JSON.stringify(value)));
      await runner.prepare();
      return runner.runAffected(runner.computeAffected([file]));
    };
    // Establish a real compilation baseline and a resident foreground host.
    const warm = await save("warm");
    assert.equal(warm.ok, true, warm.output);
    assert.equal(warm.outcomes.length, 2);
    // No explicitly queued classes: the new active-learning pass samples
    // the static map using classic coverage when warm coverage is unavailable.
    assert.equal(runner.pendingRefresh.size, 0);
    assert.equal(await runner.refreshPending(), 2, logs.join("\n"));
    for (const value of ["", "fixed"]) {
      const mark = logs.length;
      const result = await save(value);
      assert.equal(result.outcomes.length, 2, result.output);
      assert.equal(result.ok, value !== "", result.output);
      assert.ok(logs.slice(mark).some((m) => m.includes("fastpath=hit")), logs.slice(mark).join("\n"));
    }
  } finally {
    runner.sessions?.dispose();
    hot.dispose();
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
