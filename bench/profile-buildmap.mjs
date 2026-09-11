// Sub-step profiler for runner.buildMap (H1). Times each phase separately.
import { execFileSync, spawnSync } from "node:child_process";
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
const { cacheDirFor } = await import(path.join(ext, "out/core/util.js"));
const { exec } = await import(path.join(ext, "out/core/util.js"));

const runner = new Runner(root);
runner.logSink = () => {};
const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), () => {});
await hot.prepareRunsettings();
runner.hotpatch = hot;

const t = (label, fn) => {
  const s = performance.now();
  return Promise.resolve(fn()).then((v) => {
    console.log(`${label.padEnd(28)} ${(performance.now() - s).toFixed(0).padStart(7)}ms`);
    return v;
  });
};

await t("prepare", () => runner.prepare());
await t("projectGraph", () => runner.projectGraph());
await t("discoverAll", () => runner.discoverAll({}));
await t("buildMap (full, 1st)", () => runner.buildMap({ discovered: {} }));
await t("buildMap (full, 2nd)", () => runner.buildMap({ discovered: {} }));

// Now the sub-steps, on the warm shadow:
const shadowDir = runner.shadow.dir;
const sln = fs.readdirSync(runner.repoRoot).find((f) => f.toLowerCase().endsWith(".sln"));
await t("dotnet build sln (up-to-date)", async () => {
  await exec("dotnet", ["build", path.join(shadowDir, sln), "--nologo", "--verbosity", "quiet"], shadowDir, 15 * 60 * 1000);
});
await t("staticMapper.compute", async () => {
  const graph = runner.projectGraph();
  await runner.staticMapper.compute(shadowDir, graph);
});
const { collectCsFiles, parseRegistrations, resolveSeeds } = await import(path.join(ext, "out/core/registrations.js"));
let csFiles;
await t("collectCsFiles (read all)", () => (csFiles = collectCsFiles(runner.repoRoot)));
await t("parseRegistrations", () => parseRegistrations(csFiles));
await t("full buildMap (3rd, warm)", () => runner.buildMap({ discovered: {} }));
