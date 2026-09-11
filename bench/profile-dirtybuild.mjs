// Dirty-buildMap profiler: measures where the real-build time goes.
// Usage: node bench/profile-dirtybuild.mjs --root <fixtureDir> [--ext <repoDir>]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const get = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const root = get("--root", null);
const ext = get("--ext", path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
if (!root) process.exit(2);

const { Runner } = await import(path.join(ext, "out/core/runner.js"));
const { HotPatcher } = await import(path.join(ext, "out/core/hotpatch.js"));

const runner = new Runner(root);
runner.logSink = () => {};
const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), () => {});
await hot.prepareRunsettings();
runner.hotpatch = hot;

const t = (label, fn) => {
  const s = performance.now();
  const v = fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - s).toFixed(0).padStart(7)}ms`);
  return v;
};
const tA = async (label, fn) => {
  const s = performance.now();
  const v = await fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - s).toFixed(0).padStart(7)}ms`);
  return v;
};

await tA("prepare (shadow)", () => runner.prepare());
const graph = runner.projectGraph();
const shadowDir = runner.shadow.dir;
const sln = fs.readdirSync(runner.repoRoot).find((f) => f.toLowerCase().endsWith(".sln"));
const slnPath = path.join(shadowDir, sln);

// A .cs file in a non-leaf project to edit (Core.Support, the hot target).
const supportFile = path.join(shadowDir, "src", "Core", "Support.cs");
const supportRel = "src/Core/Support.cs";
const csprojOfSupport = "src/Core/Core.csproj"; // verify below

console.log("\n--- baseline: no-op solution build (startup + eval floor) ---");
for (let i = 0; i < 3; i++)
  await tA(`dotnet build sln (no-op) #${i + 1}`, () =>
    execFileSync("dotnet", ["build", slnPath, "--nologo", "--verbosity", "quiet"], { cwd: shadowDir, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }));

// Dirty one file in Core, measure full solution build.
console.log("\n--- dirty: one file changed, full solution build ---");
const setLit = (k) => fs.writeFileSync(supportFile, fs.readFileSync(supportFile, "utf8").replace(/x \+ \d+/, `x + ${k}`));
setLit(1);
await tA("dotnet build sln (Core dirty)", () =>
  execFileSync("dotnet", ["build", slnPath, "--nologo", "--verbosity", "quiet"], { cwd: shadowDir, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }));

// Dirty one file, measure targeted single-project build (Core + its deps).
console.log("\n--- dirty: one file changed, TARGETED build (only Core) ---");
setLit(2);
const coreCsproj = path.join(shadowDir, csprojOfSupport);
await tA("dotnet build Core.csproj (Core dirty)", () =>
  execFileSync("dotnet", ["build", coreCsproj, "--nologo", "--verbosity", "quiet"], { cwd: shadowDir, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }));
// and again to confirm Core is now up-to-date
setLit(3);
await tA("dotnet build Core.csproj (Core dirty #2)", () =>
  execFileSync("dotnet", ["build", coreCsproj, "--nologo", "--verbosity", "quiet"], { cwd: shadowDir, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }));

// How many projects depend on Core? (the dependents that a targeted build must also cover)
console.log("\n--- project graph: who depends on Core? ---");
const deps = new Map();
for (const [rel, p] of graph.projects) {
  for (const r of p.references) {
    if (!deps.has(r)) deps.set(r, new Set());
    deps.get(r).add(rel);
  }
}
const coreKey = [...graph.projects.keys()].find((k) => k.toLowerCase().includes("core"));
if (coreKey) {
  const dependents = deps.get(coreKey.toLowerCase()) ?? new Set();
  console.log(`Core key: ${coreKey}`);
  console.log(`Direct dependents of Core: ${[...dependents].join(", ") || "(none)"}`);
}
const total = graph.projects.size;
console.log(`Total projects: ${total}`);
