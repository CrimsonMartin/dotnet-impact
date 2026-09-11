import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { HotPatcher, DEFAULT_HOST_CAPABILITIES, intersectCapabilities } from "../core/hotpatch";

/* ================================================================== */
/*  HotPatcher — error paths and edge cases (unit tests, no dotnet).  */
/*  We test the pure-logic and mockable paths by accessing private    */
/*  fields via type-assertion.                                        */
/* ================================================================== */

function makeHotPatcher(): HotPatcher {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "impact-hotpatch-test-"));
  return new HotPatcher(
    tmp,
    path.join(tmp, "deltas"),
    path.join(tmp, "hook"),
    () => undefined
  );
}

test("HotPatcher: hookEnv returns null before prepareRunsettings", () => {
  const hp = makeHotPatcher();
  assert.equal(hp.hookEnv(), null);
});

test("HotPatcher: prepareRunsettings returns false when no helper dirs exist", async () => {
  const hp = makeHotPatcher();
  const ok = await hp.prepareRunsettings();
  assert.equal(ok, false);
});

test("HotPatcher: prepareRunsettings never throws — wraps inner in try/catch", async () => {
  const hp = makeHotPatcher();
  const result = await hp.prepareRunsettings();
  assert.equal(typeof result, "boolean");
});

test("HotPatcher: dispose is safe to call multiple times", () => {
  const hp = makeHotPatcher();
  hp.dispose();
  hp.dispose();
  hp.dispose();
});

test("HotPatcher: reset clears state without starting the service", () => {
  const hp = makeHotPatcher();
  hp.reset();
});

test("HotPatcher: tryFastPath returns false with non-dotnet changes", async () => {
  const hp = makeHotPatcher();
  const result = await hp.tryFastPath(
    ["src/Lib/Program.cshtml"],
    { projects: new Map() } as any,
    {}
  );
  assert.equal(result, false);
});

test("HotPatcher: tryFastPath returns false with empty changed array", async () => {
  const hp = makeHotPatcher();
  const result = await hp.tryFastPath([], { projects: new Map() } as any, {});
  assert.equal(result, false);
});

test("HotPatcher: tryFastPath returns false when broken", async () => {
  const hp = makeHotPatcher();
  (hp as unknown as { broken: boolean }).broken = true;
  const result = await hp.tryFastPath(["src/Lib/Foo.cs"], { projects: new Map() } as any, {});
  assert.equal(result, false);
});

/* ================================================================== */
/*  intersectCapabilities — edge cases beyond existing tests          */
/* ================================================================== */

test("intersectCapabilities: single unknown host returns full default", () => {
  assert.deepEqual(intersectCapabilities([undefined]), DEFAULT_HOST_CAPABILITIES);
});

test("intersectCapabilities: empty reported array returns null", () => {
  assert.equal(intersectCapabilities([]), null);
});

test("intersectCapabilities: one host with full set, one with subset", () => {
  assert.deepEqual(
    intersectCapabilities([DEFAULT_HOST_CAPABILITIES, ["Baseline"]]),
    ["Baseline"]
  );
});

test("intersectCapabilities: all hosts report same custom set", () => {
  const custom = ["Baseline", "CustomFeature"];
  assert.deepEqual(
    intersectCapabilities([custom, custom, custom]),
    custom
  );
});

test("intersectCapabilities: mixed known+unknown yields intersection", () => {
  const known = ["Baseline", "AddMethodToExistingType"];
  const result = intersectCapabilities([undefined, known]);
  assert.ok(result!.includes("Baseline"));
  assert.ok(result!.includes("AddMethodToExistingType"));
});

test("intersectCapabilities: completely disjoint sets yield empty", () => {
  assert.deepEqual(
    intersectCapabilities([["FeatureA", "FeatureB"], ["FeatureC", "FeatureD"]]),
    []
  );
});

test("intersectCapabilities: four-host intersection narrows correctly", () => {
  const caps = [
    ["Baseline", "A", "B", "C"],
    ["Baseline", "A", "B"],
    ["Baseline", "A", "D"],
    ["Baseline", "A", "B", "C"],
  ];
  assert.deepEqual(intersectCapabilities(caps), ["Baseline", "A"]);
});

/* ================================================================== */
/*  liveHosts stale PID cleanup                                       */
/* ================================================================== */

test("liveHosts: stale PID file is cleaned up", { timeout: 30_000 }, async () => {
  const hp = makeHotPatcher();
  const hotDir = (hp as unknown as { hotDir: string }).hotDir;
  fs.mkdirSync(hotDir, { recursive: true });

  const pidFile = path.join(hotDir, "999999");
  fs.writeFileSync(pidFile, "impact-test-pipe\nBaseline");

  const hosts = (hp as unknown as { liveHosts: () => any[] }).liveHosts();
  assert.equal(hosts.length, 0);
  assert.equal(fs.existsSync(pidFile), false);

  hp.dispose();
});

test("liveHosts: empty hotDir returns empty array", async () => {
  const hp = makeHotPatcher();
  const hotDir = (hp as unknown as { hotDir: string }).hotDir;
  fs.mkdirSync(hotDir, { recursive: true });

  const hosts = (hp as unknown as { liveHosts: () => any[] }).liveHosts();
  assert.equal(hosts.length, 0);

  hp.dispose();
});
