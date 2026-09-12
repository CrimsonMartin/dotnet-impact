// Impact performance bench — drives the real Runner/HotPatcher/SessionRunner
// stack against the scaffolded large fixture and times the operations a user
// feels on a large .NET repo.
//
// Ops (pass 1 is cold; steady-state = median of passes 2..N):
//   prepare            shadow ensure + overlay sync (fresh Runner)
//   projectGraph       first buildProjectGraph
//   discoverAll        solution build + parallel --list-tests
//   buildMap           static IL map (helper run over all assemblies)
//   computeAffected    100 random changed-file queries
//   resync             per-save prepare() on the live runner (1 dirty file)
//   edit_cycle         N method-body edits through the REAL fast path:
//                      write -> prepare -> computeAffected -> runAffected
//                      (per-edit ms + fastpath hit/miss counts)
//   refreshPending     classic-coverage refresh of 2 queued classes
//
// Usage (inside a container with dotnet + node, repo compiled at $EXT):
//   node bench/scaffold.mjs /tmp/fixture large
//   node bench/bench.mjs --root /tmp/fixture --ext /tmp/impact \
//        --label baseline --runs 3 --edits 10 --out /tmp/baseline.json
//
// Compare labels with: node bench/compare.mjs <a.json> <b.json>
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
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
const label = get("--label", "run");
const runs = Number(get("--runs", "3"));
const edits = Number(get("--edits", "10"));
const out = get("--out", null);
if (!root) {
  console.error("usage: node bench/bench.mjs --root <fixtureDir> [--ext <repoDir>] [--label L] [--runs N] [--edits N] [--out file]");
  process.exit(2);
}

const { Runner } = await import(path.join(ext, "out/core/runner.js"));
const { HotPatcher } = await import(path.join(ext, "out/core/hotpatch.js"));
const { SessionRunner } = await import(path.join(ext, "out/core/vstestSession.js"));

const listCs = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "bin" || e.name === "obj") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".cs")) out.push(p);
    }
  };
  walk(dir);
  return out;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Time a sync or async fn; returns { ms, value }. */
async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

const passes = [];
let supportLiteral = 1;
const supportFile = path.join(root, "src/Core/Support.cs");
const supportRel = "src/Core/Support.cs";

const setLiteral = (k) => {
  fs.writeFileSync(supportFile, fs.readFileSync(supportFile, "utf8").replace(/x \+ \d+/, `x + ${k}`));
};

for (let pass = 1; pass <= runs; pass++) {
  const rec = { pass };
  const logs = [];
  const runner = new Runner(root);
  runner.logSink = (m) => logs.push(m);
  const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), (m) => logs.push(m));
  try {
    await hot.prepareRunsettings();
    runner.hotpatch = hot;
    // The runsettings file is what loads the hot-patch StartupHook into the
    // test hosts — must be handed to the session runner before the first run.
    runner.sessions = new SessionRunner(root, path.join(ext, "helper"), (m) => logs.push(m), hot.runsettingsFile);

    rec["prepare"] = (await timed(() => runner.prepare())).ms;
    rec["projectGraph"] = (await timed(() => runner.projectGraph())).ms;
    const disc = await timed(() => runner.discoverAll({}));
    rec["discoverAll"] = disc.ms;
    const mapRes = await timed(() => runner.buildMap({ discovered: disc.value }));
    rec["buildMap"] = mapRes.ms;
    // Second buildMap with no source change in between: the steady-state
    // refresh / extension-reload path (up-to-date assemblies).
    rec["buildMap_warm"] = (await timed(() => runner.buildMap({ discovered: disc.value }))).ms;

    // buildMap_dirty_leaf: the per-save map-refresh flow for a LEAF test
    // project (nothing references the test projects): file saved -> prepare()
    // resyncs the one changed file into the shadow -> buildMap() sees the new
    // source stamp, rebuilds only T2, and recomputes the map. The resident
    // static-map helper (H12) re-parses just T2 and reuses the other ten's
    // cached parsed graphs. (Placed before edit_cycle so no Core edit is
    // pending.)
    {
      const leafFile = path.join(root, "tests/T2/T2_5Tests.cs");
      fs.appendFileSync(leafFile, `\n// impact-bench-leaf-${pass}-${Date.now()}\n`);
      const leaf = await timed(async () => {
        await runner.prepare(); // per-save resync (changed file -> shadow)
        return runner.buildMap({ discovered: disc.value });
      });
      rec["buildMap_dirty_leaf"] = leaf.ms;
    }

    // computeAffected: 100 random queries
    const csFiles = listCs(root);
    const files = Array.from({ length: 100 }, () => csFiles[Math.floor(Math.random() * csFiles.length)]);
    rec["computeAffected"] = (await timed(async () => {
      for (const f of files) runner.computeAffected([f]);
    })).ms;

    // per-save resync (one changed file)
    setLiteral(++supportLiteral);
    rec["resync"] = (await timed(() => runner.prepare())).ms;

    // edit cycle: warmup edit establishes the EnC baseline + resident host.
    const doEdit = async (k) => {
      setLiteral(k);
      await runner.prepare();
      const affected = runner.computeAffected([supportRel]);
      return runner.runAffected(affected);
    };
    const warmup = await doEdit(++supportLiteral);
    rec["warmup_ok"] = warmup.ok;
    if (!warmup.ok) rec["warmup_output_tail"] = (warmup.output || "").slice(-500);
    const perEdit = [];
    for (let i = 0; i < edits; i++) {
      const mark = logs.length;
      const r = await timed(() => doEdit(++supportLiteral));
      perEdit.push({ ms: r.ms, ok: r.value.ok, fastpathHit: logs.slice(mark).some((m) => m.includes("fastpath=hit")) });
    }
    rec["edit_cycle"] = perEdit.map((e) => e.ms);
    rec["edit_cycle_median_ms"] = median(rec["edit_cycle"]);
    rec["edit_ok"] = perEdit.filter((e) => e.ok).length;
    rec["fastpath_hits"] = perEdit.filter((e) => e.fastpathHit).length;

    // refreshPending: queue two mapped test classes, drain via classic coverage.
    const fqns = runner.map.classes().filter((f) => (runner.map.entry(f)?.csproj ?? "").endsWith(".csproj"));
    const two = fqns.slice(0, 2);
    for (const fqn of two) runner.pendingRefresh.set(fqn, runner.map.entry(fqn).csproj);
    rec["refresh_classes"] = two;
    const ref = await timed(() => runner.refreshPending({}));
    rec["refreshed"] = ref.value;
    rec["refreshPending"] = ref.ms;
  } finally {
    try { runner.sessions?.dispose(); } catch { /* already gone */ }
    // Retire the resident static-map helper (H12) so it does not accumulate
    // across passes — mirrors the extension's deactivate().
    try { runner.staticMapper?.dispose?.(); } catch { /* already gone */ }
    try { hot.dispose(); } catch { /* already gone */ }
  }
  passes.push(rec);
  const flat = Object.fromEntries(Object.entries(rec).filter(([, v]) => typeof v === "number"));
  console.log(`pass ${pass}: ${JSON.stringify(flat)}`);
}

const summary = (name) => {
  const all = passes.map((p) => (Array.isArray(p[name]) ? median(p[name]) : p[name])).filter((v) => typeof v === "number");
  const steady = all.slice(1);
  return {
    cold_ms: Math.round(all[0] ?? -1),
    steady_median_ms: Math.round(median(steady.length ? steady : all)),
    runs_ms: all.map((v) => Math.round(v)),
  };
};

const gitRev = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ext }).toString().trim(); } catch { return "noc"; } })();
const coreClasses = fs.readdirSync(path.join(root, "src/Core")).filter((f) => /^C\d+\.cs$/.test(f)).length;

const result = {
  label,
  root,
  git: gitRev,
  timestamp: new Date().toISOString(),
  fixture: { coreClasses, projects: fs.readdirSync(path.join(root, "src")).length + fs.readdirSync(path.join(root, "tests")).length },
  edit_cycle: {
    hits: passes.map((p) => p["fastpath_hits"]),
    ok: passes.map((p) => p["edit_ok"]),
    cold_median_ms: Math.round(passes[0]["edit_cycle_median_ms"] ?? -1),
    steady_median_ms: Math.round(median(passes.slice(1).map((p) => p["edit_cycle_median_ms"]).filter((v) => v > 0))) || null,
  },
  ops: {
    prepare: summary("prepare"),
    projectGraph: summary("projectGraph"),
    discoverAll: summary("discoverAll"),
    buildMap: summary("buildMap"),
    buildMap_warm: summary("buildMap_warm"),
    buildMap_dirty_leaf: summary("buildMap_dirty_leaf"),
    computeAffected_100: summary("computeAffected"),
    resync: summary("resync"),
    refreshPending_2: summary("refreshPending"),
  },
  passes,
};

console.log("\n=== summary ===");
for (const [k, v] of Object.entries(result.ops)) console.log(`${k.padEnd(18)} cold=${String(v.cold_ms).padStart(8)}ms steady=${String(v.steady_median_ms).padStart(8)}ms`);
console.log(`edit_cycle         cold=${String(result.edit_cycle.cold_median_ms).padStart(8)}ms steady=${String(result.edit_cycle.steady_median_ms).padStart(8)}ms (fastpath hits ${result.edit_cycle.hits.join("/")}/${edits})`);

if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${out}`);
}
