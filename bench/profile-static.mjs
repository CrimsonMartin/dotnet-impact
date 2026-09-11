// One-shot phase profiler for the static-map helper (H1).
// Sets up shadow + discovery like bench.mjs, then runs the helper directly
// with IMPACT_STATIC_PHASES=1 and prints the stderr phase breakdown.
// Usage: node bench/profile-static.mjs --root <fixtureDir> [--ext <repoDir>]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const get = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const root = get("--root", null);
const ext = get("--ext", path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
if (!root) {
  console.error("usage: node bench/profile-static.mjs --root <fixtureDir> [--ext <repoDir>]");
  process.exit(2);
}

const { Runner } = await import(path.join(ext, "out/core/runner.js"));
const { HotPatcher } = await import(path.join(ext, "out/core/hotpatch.js"));
const { cacheDirFor } = await import(path.join(ext, "out/core/util.js"));

const runner = new Runner(root);
runner.logSink = () => {};
const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), () => {});
await hot.prepareRunsettings();
runner.hotpatch = hot;

console.log("prepare + graph + discover + buildMap (warm shadow)...");
await runner.prepare();
await runner.projectGraph();
await runner.discoverAll({});
await runner.buildMap({ discovered: {} });

// Now the helper is built and the shadow has assemblies. Re-run the helper
// directly with phase timers, several times.
const cacheDir = cacheDirFor(root);
const dll = path.join(cacheDir, "staticmap-bin", "ImpactStaticMap.dll");
const input = path.join(cacheDir, "staticmap-input.json");
if (!fs.existsSync(dll) || !fs.existsSync(input)) {
  console.error(`helper/input not found: ${dll} / ${input}`);
  process.exit(1);
}
const shadowDir = runner.shadow?.dir ?? cacheDir;
for (let i = 0; i < 3; i++) {
  const err = execFileSync("dotnet", [dll, "--repo-root", shadowDir, "--assemblies", input], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, IMPACT_STATIC_PHASES: "1", MSBUILDTERMINALLOGGER: "off" },
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log(`\n=== run ${i + 1} ===`);
  console.log(err.toString().split("\n").filter((l) => l.startsWith("[phase]")).join("\n"));
}
