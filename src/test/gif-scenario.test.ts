import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { HotPatcher } from "../core/hotpatch";
import { testProjects } from "../core/projects";
import { Runner, AffectedSet } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { dotnetOrNull } from "./deltas-helper";

/**
 * The README-gif scenario as an end-to-end regression test: the exact repo
 * and edit sequence the demo records (activation build → warm-up saves →
 * break ApplyDiscount → fix it), driven through the full production pipeline
 * (Runner + HotPatcher + SessionRunner, real git repo, real builds, real
 * testhosts).
 *
 * The invariant under test is the product's one promise: a breaking edit
 * turns the affected test RED, whichever path the save takes. v0.2.4 broke
 * it silently — an out-of-band build (test discovery's solution build here)
 * rewrote the shadow dll+pdb without refreshing the complog baseline, the
 * EnC session then held every document out-of-sync and reported each edit as
 * a benign no-op, and saves stayed "fast-path hit, 0 deltas" while the warm
 * testhosts kept running the pre-edit assembly green. This test fails on
 * that build and must keep failing on any future way the pipeline finds to
 * lie about a broken save.
 */

const CALCULATOR = `namespace Demo;

public static class Calculator
{
    public static decimal Add(decimal a, decimal b) => a + b;

    public static decimal ApplyDiscount(decimal price, decimal percent)
    {
        var discount = price * percent / 100m;
        return price - discount;
    }

    public static decimal Total(decimal[] prices)
    {
        decimal total = 0;
        foreach (var p in prices) total = Add(total, p);
        return total;
    }
}
`;

const TESTS = `using Demo;
using Xunit;

namespace Calculator.Tests;

public class CalculatorTests
{
    [Fact]
    public void Adds_two_numbers() =>
        Assert.Equal(5m, Demo.Calculator.Add(2m, 3m));

    [Fact]
    public void Applies_a_percentage_discount() =>
        Assert.Equal(90m, Demo.Calculator.ApplyDiscount(100m, 10m));

    [Fact]
    public void Totals_a_list_of_prices() =>
        Assert.Equal(60m, Demo.Calculator.Total(new[] { 10m, 20m, 30m }));
}
`;

const LIB_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`;

const TEST_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../../src/Calculator/Calculator.csproj" />
  </ItemGroup>
</Project>
`;

const SLNX = `<Solution>
  <Folder Name="/src/">
    <Project Path="src/Calculator/Calculator.csproj" />
  </Folder>
  <Folder Name="/tests/">
    <Project Path="tests/Calculator.Tests/Calculator.Tests.csproj" />
  </Folder>
</Solution>
`;

function scaffoldGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-gif-scenario-"));
  fs.mkdirSync(path.join(root, "src", "Calculator"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Calculator.Tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "Demo.slnx"), SLNX);
  fs.writeFileSync(path.join(root, "src", "Calculator", "Calculator.csproj"), LIB_CSPROJ);
  fs.writeFileSync(path.join(root, "src", "Calculator", "Calculator.cs"), CALCULATOR);
  fs.writeFileSync(path.join(root, "tests", "Calculator.Tests", "Calculator.Tests.csproj"), TEST_CSPROJ);
  fs.writeFileSync(path.join(root, "tests", "Calculator.Tests", "CalculatorTests.cs"), TESTS);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "demo calculator");
  return root;
}

test("gif scenario: a breaking edit goes red even after an out-of-band build", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against

  const root = scaffoldGitRepo();
  const ext = path.join(__dirname, "..", "..");
  const log = (m: string) => console.log(`   [log] ${m}`);
  const runner = new Runner(root);
  runner.logSink = log;
  let hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), log);
  const hookOk = await hot.prepareRunsettings();
  runner.sessions = new SessionRunner(root, path.join(ext, "helper"), log, hookOk ? hot.runsettingsFile : undefined);
  if (hookOk) runner.hotpatch = hot;

  const calc = path.join(root, "src", "Calculator", "Calculator.cs");
  const calcRel = "src/Calculator/Calculator.cs";
  const affectedSave: AffectedSet = {
    classes: ["Calculator.Tests.CalculatorTests"],
    fallbackProjects: [],
    changedFiles: [calcRel],
    classOwners: { "Calculator.Tests.CalculatorTests": "tests/Calculator.Tests/Calculator.Tests.csproj" },
  };
  const run = async (label: string, affected?: AffectedSet) => {
    await runner.prepare();
    const a = affected ?? {
      classes: [],
      fallbackProjects: testProjects(runner.projectGraph()),
      changedFiles: [],
    };
    const res = await runner.runAffected(a);
    const failed = res.outcomes
      .filter((o) => !o.passed && !o.skipped)
      .map((o) => `${o.classFqn}.${o.method}`);
    log(`>> ${label}: ok=${res.ok} outcomes=${res.outcomes.length} failed=[${failed.join(", ")}]`);
    return { res, failed };
  };

  try {
    const shadow = await runner.prepare();
    // Activation-time discovery builds the shadow solution with no snapshot;
    // in v0.2.4 this is one of the builds that poisoned the baseline.
    execFileSync(dotnet, ["build", path.join(shadow.dir, "Demo.slnx"), "--nologo", "-v", "quiet"], {
      cwd: shadow.dir,
      stdio: "pipe",
      timeout: 300_000,
      env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
    });

    const all = await run("run all (baseline)");
    assert.equal(all.res.ok, true, "baseline suite must be green");
    assert.equal(all.failed.length, 0);
    assert.ok(all.res.outcomes.length >= 3, "all three calculator tests must report");

    // Gif warm-up: a whitespace save, then its revert — both stay green and
    // establish the hot-patch baseline for the calculator project.
    fs.writeFileSync(calc, CALCULATOR.replace("return price - discount;", "return price - discount; "));
    assert.equal((await run("warm-up save", affectedSave)).failed.length, 0);
    fs.writeFileSync(calc, CALCULATOR);
    assert.equal((await run("warm-up revert", affectedSave)).failed.length, 0);

    // Out-of-band rebuild of the calculator project: no snapshot, and the
    // same MSBuild shape minimalBuild uses, so the next impact build sees
    // the outputs as up to date (a 0-call binlog keeps the previous complog)
    // and the divergence SURVIVES. The comment changes the source checksum,
    // so the shadow dll+pdb no longer match the complog the fast path loads.
    const commented = CALCULATOR.replace("namespace Demo;", "namespace Demo; // demo");
    fs.writeFileSync(calc, commented);
    await runner.prepare(); // sync the edit into the shadow, as activation would
    execFileSync(
      dotnet,
      [
        "msbuild",
        path.join(shadow.dir, "src", "Calculator", "Calculator.csproj"),
        "-t:Build",
        "-p:BuildProjectReferences=false",
        "-restore:false",
        "-nologo",
        "-v:q",
      ],
      { cwd: shadow.dir, stdio: "pipe", timeout: 300_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
    );

    // Extension restart (the recording session's shape): a fresh delta
    // service and fresh testhosts now meet the divergence cold — the next
    // load pairs the OLD complog with the rebuilt dll. On v0.2.4 that pair
    // loaded fine, the session held every document out-of-sync, and each
    // save answered "no changes to apply".
    runner.sessions.dispose();
    hot.dispose();
    hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), log);
    assert.equal(await hot.prepareRunsettings(), true);
    runner.sessions = new SessionRunner(root, path.join(ext, "helper"), log, hot.runsettingsFile);
    runner.hotpatch = hot;
    // Post-restart warm run: cold hosts force the build path (up-to-date, so
    // the stale complog survives) and spin warm testhosts back up.
    assert.equal((await run("post-restart warm run", affectedSave)).failed.length, 0);

    // The gif's breaking edit. This is the product's promise: RED, whatever
    // path the save takes. On v0.2.4 the stale baseline no-op'd the delta and
    // this stayed green while the testhosts ran the old assembly.
    fs.writeFileSync(calc, commented.replace("return price - discount;", "return price + discount;"));
    const broken = await run("breaking edit", affectedSave);
    assert.ok(
      broken.failed.some((fqn) => fqn.includes("Applies_a_percentage_discount")),
      "the breaking edit must turn Applies_a_percentage_discount red " +
        `(got ok=${broken.res.ok}, failed=[${broken.failed.join(", ")}]) — ` +
        "a green result here means the pipeline ran stale code"
    );

    // #11 P2: live testhosts must register with their runtime capability
    // line (pipe name on line 1, capabilities on line 2) — the fast path
    // gates delta generation on this handshake.
    const hotDir = path.join(cacheDirFor(root), "hotpatch-hosts");
    const regs = fs.readdirSync(hotDir).map((f) => fs.readFileSync(path.join(hotDir, f), "utf8"));
    assert.ok(regs.length > 0, "a warm testhost must be registered");
    for (const reg of regs) {
      const caps = (reg.split(/\r?\n/)[1] ?? "").trim();
      assert.ok(
        caps.split(/\s+/).includes("Baseline"),
        `host registration must report runtime capabilities, got: ${JSON.stringify(reg)}`
      );
    }

    // And the fix goes green again, like the gif's second half.
    fs.writeFileSync(calc, commented);
    const fixed = await run("fix edit", affectedSave);
    assert.equal(fixed.failed.length, 0, "the fix must go green again");
    assert.ok(fixed.res.outcomes.length > 0, "the fix run must actually report outcomes");
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
