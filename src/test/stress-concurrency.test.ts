import * as assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { HotPatcher } from "../core/hotpatch";
import { testProjects } from "../core/projects";
import { AffectedSet, Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { dotnetOrNull } from "./deltas-helper";

const execFileAsync = promisify(execFile);

/**
 * Real-repo stress: the pipeline's state machines under the loads that
 * actually break them.
 *
 *  - A seeded save-cycle soak with a VERDICT ORACLE: the test derives what
 *    every run's outcomes MUST be from the code it just wrote, so any silent
 *    stale state anywhere in the fast path (generation chaining, baselines,
 *    warm hosts) surfaces as an oracle mismatch — the anti-green-lie soak.
 *    Every cycle logs its route (fastpath/build) for diagnosability, and the
 *    PRNG seed is fixed so a failure replays exactly.
 *  - Mid-flight supersede: aborted runs (a newer save preempting) must leak
 *    nothing — the next clean run's verdict stays correct.
 *  - Cross-process lock contention: concurrent CLI invocations (lint-staged
 *    style) all exit with documented codes and leave the shadow usable.
 */

/** Deterministic PRNG (mulberry32) so failures reproduce from the logged seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** LibA/LibB sources derived from semantic state — the oracle's ground truth. */
function renderLibA(s: { brokenA: boolean; styleA: boolean; padA: boolean }): string {
  const body = s.brokenA ? "return a + b + 1;" : s.styleA ? "return b + a;" : "return a + b;";
  return `namespace Demo.LibA;

public static class Core
{
    public static int Add(int a, int b)
    {
        ${body}
    }
}
${s.padA ? "// pad\n" : ""}`;
}

function renderLibB(s: { brokenB: boolean; styleB: boolean; padB: boolean }): string {
  const body = s.brokenB
    ? "return Demo.LibA.Core.Add(x, x) + 1;"
    : s.styleB
      ? "return Demo.LibA.Core.Add(x, x) + 0;"
      : "return Demo.LibA.Core.Add(x, x);";
  return `namespace Demo.LibB;

public static class Combo
{
    public static int Twice(int x)
    {
        ${body}
    }
}
${s.padB ? "// pad\n" : ""}`;
}

function scaffoldStressRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-stress-"));
  const lib = (name: string) =>
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>' +
    (name === "LibB"
      ? '<ItemGroup><ProjectReference Include="../LibA/LibA.csproj" /></ItemGroup>'
      : "") +
    "</Project>";
  const testProj = (dep: string) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <ProjectReference Include="../../src/${dep}/${dep}.csproj" />
  </ItemGroup>
</Project>`;
  fs.mkdirSync(path.join(root, "src", "LibA"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "LibB"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "A.Tests"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "B.Tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "LibA", "LibA.csproj"), lib("LibA"));
  fs.writeFileSync(path.join(root, "src", "LibB", "LibB.csproj"), lib("LibB"));
  fs.writeFileSync(
    path.join(root, "src", "LibA", "Core.cs"),
    renderLibA({ brokenA: false, styleA: false, padA: false })
  );
  fs.writeFileSync(
    path.join(root, "src", "LibB", "Combo.cs"),
    renderLibB({ brokenB: false, styleB: false, padB: false })
  );
  fs.writeFileSync(path.join(root, "tests", "A.Tests", "A.Tests.csproj"), testProj("LibA"));
  fs.writeFileSync(
    path.join(root, "tests", "A.Tests", "ATests.cs"),
    'using Xunit;\n\nnamespace Demo.ATests;\n\npublic class CoreTests\n{\n    [Fact] public void Adds() => Assert.Equal(5, Demo.LibA.Core.Add(2, 3));\n}\n'
  );
  fs.writeFileSync(path.join(root, "tests", "B.Tests", "B.Tests.csproj"), testProj("LibB"));
  fs.writeFileSync(
    path.join(root, "tests", "B.Tests", "BTests.cs"),
    'using Xunit;\n\nnamespace Demo.BTests;\n\npublic class ComboTests\n{\n    [Fact] public void Twices() => Assert.Equal(8, Demo.LibB.Combo.Twice(4));\n}\n'
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "bin/\nobj/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

const A_CLASS = "Demo.ATests.CoreTests";
const B_CLASS = "Demo.BTests.ComboTests";
const OWNERS = {
  [A_CLASS]: "tests/A.Tests/A.Tests.csproj",
  [B_CLASS]: "tests/B.Tests/B.Tests.csproj",
};

test("stress soak: seeded save cycles never diverge from the verdict oracle; superseded runs leak nothing", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against

  const root = scaffoldStressRepo();
  const ext = path.join(__dirname, "..", "..");
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
    console.log(`   [stress] ${m}`);
  };
  const runner = new Runner(root);
  runner.logSink = log;
  const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), log);
  const hookOk = await hot.prepareRunsettings();
  runner.sessions = new SessionRunner(root, path.join(ext, "helper"), log, hookOk ? hot.runsettingsFile : undefined);
  if (hookOk) runner.hotpatch = hot;

  const state = { brokenA: false, styleA: false, padA: false, brokenB: false, styleB: false, padB: false };
  const writeA = () => fs.writeFileSync(path.join(root, "src", "LibA", "Core.cs"), renderLibA(state));
  const writeB = () => fs.writeFileSync(path.join(root, "src", "LibB", "Combo.cs"), renderLibB(state));

  /** What the code on disk implies each class's verdict must be. */
  const expectFail = (cls: string): boolean =>
    cls === A_CLASS ? state.brokenA : state.brokenA || state.brokenB;

  const runAndCheck = async (label: string, affected: AffectedSet, signal?: AbortSignal) => {
    await runner.prepare();
    const res = await runner.runAffected(affected, signal);
    if (res.cancelled) {
      log(`>> ${label}: cancelled`);
      return res;
    }
    const route = logs
      .slice()
      .reverse()
      .find((l) => l.startsWith("timing:"));
    const failedClasses = new Set(
      res.outcomes.filter((o) => !o.passed && !o.skipped).map((o) => o.classFqn)
    );
    log(`>> ${label}: route=[${route}] failed=[${[...failedClasses].join(", ")}]`);
    for (const cls of affected.classes) {
      const ran = res.outcomes.some((o) => o.classFqn === cls);
      assert.ok(ran, `${label}: ${cls} must report an outcome`);
      assert.equal(
        failedClasses.has(cls),
        expectFail(cls),
        `${label}: ORACLE MISMATCH for ${cls} — state=${JSON.stringify(state)}; route=[${route}] — ` +
          "a wrong verdict here means the pipeline ran stale code"
      );
    }
    return res;
  };

  const affectedFor = (target: "A" | "B"): AffectedSet =>
    target === "A"
      ? { classes: [A_CLASS, B_CLASS], fallbackProjects: [], changedFiles: ["src/LibA/Core.cs"], classOwners: OWNERS }
      : { classes: [B_CLASS], fallbackProjects: [], changedFiles: ["src/LibB/Combo.cs"], classOwners: OWNERS };

  try {
    // Baseline: full green run (also builds + snapshots the fast-path baseline).
    await runner.prepare();
    const full = await runner.runAffected({
      classes: [],
      fallbackProjects: testProjects(runner.projectGraph()),
      changedFiles: [],
      classOwners: OWNERS,
    });
    assert.equal(full.ok, true, "baseline suite must be green");
    assert.ok(full.outcomes.length >= 2, "both test projects must report");

    // --- (a) seeded soak ---
    const SEED = 0xc0ffee;
    const rand = prng(SEED);
    log(`soak seed: 0x${SEED.toString(16)}`);
    const CYCLES = 12;
    for (let i = 0; i < CYCLES; i++) {
      const target: "A" | "B" = rand() < 0.5 ? "A" : "B";
      const roll = rand();
      if (target === "A") {
        if (roll < 0.35) state.brokenA = !state.brokenA;
        else if (roll < 0.6) state.styleA = !state.styleA;
        else if (roll < 0.85) state.padA = !state.padA;
        else state.brokenA = false;
        writeA();
      } else {
        if (roll < 0.35) state.brokenB = !state.brokenB;
        else if (roll < 0.6) state.styleB = !state.styleB;
        else if (roll < 0.85) state.padB = !state.padB;
        else state.brokenB = false;
        writeB();
      }
      await runAndCheck(`cycle ${i + 1}/${CYCLES} (${target})`, affectedFor(target));
    }

    // --- (b) supersede: abort mid-flight, immediately save again ---
    for (let i = 0; i < 3; i++) {
      state.brokenA = true;
      writeA();
      const ctrl = new AbortController();
      await runner.prepare();
      const inFlight = runner.runAffected(affectedFor("A"), ctrl.signal);
      setTimeout(() => ctrl.abort(), 150);
      await inFlight.catch(() => undefined); // superseded — result irrelevant
      state.brokenA = false;
      writeA();
      await runAndCheck(`post-supersede ${i + 1}/3`, affectedFor("A"));
    }

    // Final clean sweep: nothing leaked, whole suite green.
    state.brokenA = state.brokenB = false;
    writeA();
    writeB();
    await runner.prepare();
    const final = await runner.runAffected({
      classes: [],
      fallbackProjects: testProjects(runner.projectGraph()),
      changedFiles: [],
      classOwners: OWNERS,
    });
    assert.equal(final.ok, true, "final full run must be green — anything else is leaked state");
  } finally {
    runner.sessions?.dispose?.();
    hot.dispose();
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stress contention: concurrent CLI runs exit with documented codes and leave the shadow usable", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const CLI = path.join(__dirname, "..", "cli.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-contend-"));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Calc.Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Calc", "Calc.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
  );
  fs.writeFileSync(
    path.join(root, "src", "Calc", "Calc.cs"),
    "namespace Demo;\n\npublic static class Calc\n{\n    public static int Add(int a, int b)\n    {\n        return a + b;\n    }\n}\n"
  );
  fs.writeFileSync(
    path.join(root, "tests", "Calc.Tests", "Calc.Tests.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <ProjectReference Include="../../src/Calc/Calc.csproj" />
  </ItemGroup>
</Project>`
  );
  fs.writeFileSync(
    path.join(root, "tests", "Calc.Tests", "CalcTests.cs"),
    'using Xunit;\n\nnamespace Demo.Tests;\n\npublic class CalcTests\n{\n    [Fact] public void Adds() => Assert.Equal(5, Demo.Calc.Add(2, 3));\n}\n'
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "bin/\nobj/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  fs.mkdirSync(cacheDirFor(root), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDirFor(root), "impact-map.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "Demo.Tests.CalcTests": {
          csproj: "tests/Calc.Tests/Calc.Tests.csproj",
          files: ["src/Calc/Calc.cs"],
          source: "coverage",
          updatedAt: new Date().toISOString(),
        },
      },
    })
  );

  const cli = async (...args: string[]) => {
    try {
      const r = await execFileAsync(process.execPath, [CLI, ...args], { cwd: root, timeout: 240_000 });
      return { code: 0, out: r.stdout + r.stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  };

  try {
    // lint-staged shape: several hook invocations at once. Exactly one wins
    // the shadow lock and runs; the rest wait up to 10s and soft-skip with
    // exit 0 (#7 hook safety) — never crash, never corrupt.
    const results = await Promise.all([
      cli("run", "src/Calc/Calc.cs"),
      cli("run", "src/Calc/Calc.cs"),
      cli("run", "src/Calc/Calc.cs"),
      cli("run", "src/Calc/Calc.cs"),
    ]);
    for (const [i, r] of results.entries()) {
      assert.equal(r.code, 0, `contender ${i}: undocumented exit ${r.code}; output: ${r.out.slice(0, 400)}`);
    }
    const ran = results.filter((r) => /passed/.test(r.out));
    const skipped = results.filter((r) => /skipped|holds the shadow/.test(r.out));
    assert.ok(ran.length >= 1, `at least one contender must actually run tests; outputs: ${results.map((r) => r.out.slice(0, 120)).join(" || ")}`);
    assert.equal(ran.length + skipped.length, results.length, "every contender either ran or skipped — nothing else");

    // The shadow survived: a follow-up lone run is green...
    const after = await cli("run", "src/Calc/Calc.cs");
    assert.equal(after.code, 0, `post-contention run must be green: ${after.out.slice(0, 400)}`);
    assert.match(after.out, /passed/);

    // ...and still reports honestly: a breaking edit fails the follow-up run.
    const calc = path.join(root, "src", "Calc", "Calc.cs");
    fs.writeFileSync(calc, fs.readFileSync(calc, "utf8").replace("return a + b;", "return a + b + 1;"));
    const red = await cli("run", "src/Calc/Calc.cs");
    assert.equal(red.code, 1, `post-contention breaking run must exit 1: ${red.out.slice(0, 400)}`);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
