import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { buildProjectGraph } from "../core/projects";
import { StaticMapper } from "../core/staticmap";
import { cacheDirFor, setDotnetPath } from "../core/util";
import { dotnetOrNull, scaffoldDiRepo } from "./di-fixture";

/**
 * H12: the resident static-map helper. One long-lived `dotnet` process per
 * repo serves line-JSON map requests; per-assembly parse results are cached
 * by (path, mtime, size), so a partial rebuild re-parses only the assemblies
 * that changed. These tests cover: resident == one-shot equivalence, cache
 * warm behavior, mtime-based invalidation, crash recovery, the one-shot
 * fallback, serialization of concurrent requests, and dispose.
 *
 * Tests share one mapper (and thus one resident process) in order; the final
 * test disposes it.
 */

interface Fixture {
  root: string;
  mapper: StaticMapper;
  logs: string[];
}

let fx: Fixture | undefined;

function fixture(): Fixture {
  if (fx) return fx;
  const dotnet = dotnetOrNull();
  if (!dotnet) throw new Error("no dotnet SDK");
  const root = scaffoldDiRepo();
  execFileSync(dotnet, ["build", "tests/T/T.csproj", "--nologo", "-v", "quiet"], {
    cwd: root,
    stdio: "pipe",
    timeout: 300_000,
    env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
  });
  const logs: string[] = [];
  const mapper = new StaticMapper(root, path.join(__dirname, "../../helper-static"), (m) => logs.push(m));
  fx = { root, mapper, logs };
  return fx;
}

after(() => {
  setDotnetPath(undefined);
  try {
    fx?.mapper.dispose();
  } catch {
    /* already gone */
  }
});

const helperDll = (root: string): string => path.join(cacheDirFor(root), "staticmap-bin", "ImpactStaticMap.dll");

/** Direct one-shot run of the helper (the pre-H12 code path). */
function oneShot(root: string): Record<string, unknown> {
  const dotnet = dotnetOrNull()!;
  const assemblies = [
    { csproj: "src/Lib/Lib.csproj", dll: libDll(root), isTest: false },
    { csproj: "src/FakeDi/FakeDi.csproj", dll: fakeDiDll(root), isTest: false },
    { csproj: "tests/T/T.csproj", dll: tDll(root), isTest: true },
  ];
  const inp = path.join(root, "resident-test-assemblies.json");
  fs.writeFileSync(inp, JSON.stringify(assemblies));
  const out = execFileSync(dotnet, [helperDll(root), "--repo-root", root, "--assemblies", inp], {
    cwd: root,
    stdio: "pipe",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
  }).toString();
  return JSON.parse(out);
}

test("resident: cold map equals the one-shot map", { timeout: 900_000 }, () => {
  const f = fixture();
  return f.mapper.compute(f.root, buildProjectGraph(f.root)).then((residentMap) => {
    assert.ok(residentMap, `compute failed; logs: ${f.logs.join(" | ")}`);
    // The DI fixture has exactly two test classes.
    const classes = Object.keys(residentMap.classes).sort();
    assert.deepEqual(classes, ["Demo.Tests.ATests", "Demo.Tests.BTests"]);
    const direct = oneShot(f.root);
    assert.deepEqual(residentMap.classes, direct.classes);
    assert.deepEqual(residentMap.types, direct.types);
    const stats = f.mapper.residentHelper?.lastStats;
    assert.equal(
      stats?.parsed,
      3,
      `cold: all three assemblies parsed (stats=${JSON.stringify(stats)}; logs: ${f.logs.slice(-8).join(" | ")})`
    );
    assert.equal(stats?.cached, 0, `cold: nothing cached (stats=${JSON.stringify(stats)})`);
  });
});

test("resident: second request is fully served from the parse cache", { timeout: 600_000 }, () => {
  const f = fixture();
  return f.mapper.compute(f.root, buildProjectGraph(f.root)).then((again) => {
    assert.ok(again);
    assert.deepEqual(Object.keys(again.classes).sort(), ["Demo.Tests.ATests", "Demo.Tests.BTests"]);
    const stats = f.mapper.residentHelper?.lastStats;
    assert.equal(stats?.parsed, 0, "warm: nothing re-parsed");
    assert.equal(stats?.cached, 3, "warm: all three assemblies from cache");
  });
});

test("resident: rebuilding one assembly re-parses only that one", { timeout: 600_000 }, () => {
  const f = fixture();
  const dotnet = dotnetOrNull()!;
  // Add a type to Lib and rebuild Lib only (nothing else's DLL changes).
  fs.writeFileSync(
    path.join(f.root, "src/Lib/ServiceExtra.cs"),
    "namespace Demo;\n\npublic class ServiceExtra\n{\n    public int Tag() => 42;\n}\n"
  );
  execFileSync(dotnet, ["build", "src/Lib/Lib.csproj", "--nologo", "-v", "quiet"], {
    cwd: f.root,
    stdio: "pipe",
    timeout: 300_000,
    env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
  });
  return f.mapper.compute(f.root, buildProjectGraph(f.root)).then((updated) => {
    assert.ok(updated);
    const stats = f.mapper.residentHelper?.lastStats;
    assert.equal(stats?.parsed, 1, `only Lib re-parsed (got ${JSON.stringify(stats)})`);
    assert.equal(stats?.cached, 2);
    // The new type is in the types map and its file is resolvable.
    assert.ok(updated.types?.["Demo.ServiceExtra"], "new type present in the types map");
    assert.deepEqual(updated.types!["Demo.ServiceExtra"], ["src/Lib/ServiceExtra.cs"]);
  });
});

test("resident: a crashed helper recovers transparently", { timeout: 600_000 }, () => {
  const f = fixture();
  return f.mapper.compute(f.root, buildProjectGraph(f.root)).then(async () => {
    const helper = f.mapper.residentHelper;
    assert.ok(helper?.pid, "resident process is running");
    const oldPid = helper.pid;
    process.kill(oldPid!, 9); // SIGKILL: no shutdown, no exit-code ceremony
    await sleep(500); // let the exit event drain
    // Next compute must still succeed (respawn or one-shot; either is fine).
    const recovered = await f.mapper.compute(f.root, buildProjectGraph(f.root));
    assert.ok(recovered, "map computed after the helper crashed");
    assert.deepEqual(Object.keys(recovered!.classes).sort(), ["Demo.Tests.ATests", "Demo.Tests.BTests"]);
    // And the resident path is usable again (a different process is serving).
    const revived = await f.mapper.compute(f.root, buildProjectGraph(f.root));
    assert.ok(revived);
    const pid = f.mapper.residentHelper?.pid;
    assert.ok(pid && pid !== oldPid, "a fresh resident process is serving");
  });
});

test("resident disabled: the one-shot fallback maps correctly and spawns nothing", { timeout: 600_000 }, async () => {
  const f = fixture();
  f.mapper.dispose(); // drop the resident so a spawn would be observable
  f.mapper.residentDisabled = true;
  try {
    const map = await f.mapper.compute(f.root, buildProjectGraph(f.root));
    assert.ok(map, "one-shot fallback produced a map");
    assert.deepEqual(Object.keys(map!.classes).sort(), ["Demo.Tests.ATests", "Demo.Tests.BTests"]);
    assert.equal(f.mapper.residentHelper, undefined, "no resident was spawned");
  } finally {
    f.mapper.residentDisabled = false;
  }
});

test("resident: concurrent requests are serialized and both correct", { timeout: 600_000 }, async () => {
  const f = fixture();
  const graph = buildProjectGraph(f.root);
  const [a, b] = await Promise.all([
    f.mapper.compute(f.root, graph),
    f.mapper.compute(f.root, graph),
  ]);
  assert.ok(a && b);
  assert.deepEqual(a!.classes, b!.classes);
  assert.equal(f.mapper.residentHelper?.lastStats?.cached, 3, "second request served from cache");
});

test("resident: an idle helper retires itself and the next request respawns", { timeout: 600_000 }, async () => {
  const f = fixture();
  const first = await f.mapper.compute(f.root, buildProjectGraph(f.root));
  assert.ok(first);
  const helper = f.mapper.residentHelper!;
  const pid = helper.pid!;
  helper.idleTimeoutMs = 700; // shorten the retirement window for the test
  const rearmed = await f.mapper.compute(f.root, buildProjectGraph(f.root)); // re-arms the reaper
  assert.ok(rearmed);
  await sleep(1500);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "idle helper retired after the quiet window");
  // The next request transparently respawns a fresh process.
  const revived = await f.mapper.compute(f.root, buildProjectGraph(f.root));
  assert.ok(revived);
  assert.deepEqual(Object.keys(revived!.classes).sort(), ["Demo.Tests.ATests", "Demo.Tests.BTests"]);
  assert.notEqual(f.mapper.residentHelper?.pid, pid, "a fresh process serves the next request");
});

test("resident: dispose kills the helper process", { timeout: 600_000 }, () => {
  const f = fixture();
  return f.mapper.compute(f.root, buildProjectGraph(f.root)).then(async () => {
    const pid = f.mapper.residentHelper?.pid;
    assert.ok(pid, "resident process is running");
    f.mapper.dispose(); // final test: tears down the shared resident
    await sleep(300);
    let alive = true;
    try {
      process.kill(pid!, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "helper process is gone after dispose");
  });
});

/* The DI fixture's built dll paths. */
function findDll(binDir: string, name: string): string {
  const p = path.join(binDir, "Debug", "net10.0", name);
  if (fs.existsSync(p)) return p;
  throw new Error(`built dll not found: ${p}`);
}
function libDll(root: string): string {
  return findDll(path.join(root, "src", "Lib", "bin"), "Lib.dll");
}
function fakeDiDll(root: string): string {
  return findDll(path.join(root, "src", "FakeDi", "bin"), "FakeDi.dll");
}
function tDll(root: string): string {
  return findDll(path.join(root, "tests", "T", "bin"), "T.dll");
}
