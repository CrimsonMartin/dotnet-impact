import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { HotPatcher } from "../core/hotpatch";
import { mtpOutcomes, parseMtpRunOutput } from "../core/mtp";
import { MtpSessionRunner } from "../core/mtpSession";
import { testProjects, usesMtpRunner } from "../core/projects";
import { AffectedSet, Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { dotnetOrNull } from "./deltas-helper";

/**
 * Microsoft.Testing.Platform projects, end to end through the full pipeline.
 *
 * MTP-native test projects are self-hosting executables that vstest cannot
 * host; impact runs them through their own Testing.Platform surfaces:
 *
 *  - warm server-mode sessions (mtpSession.ts): resident app, discovery with
 *    per-class attribution, uid-filtered runs, per-test outcomes — and, with
 *    the startup hook injected at spawn, a PATCHABLE host, so the hot-patch
 *    fast path works exactly as it does for vstest projects;
 *  - without a warm session, the exec fallback: the app runs per invocation
 *    and outcomes are synthesized from its console output, with the fast
 *    path gated off (a fresh process loads disk assemblies — an "applied"
 *    patch would run stale code green).
 */

const CALC = `namespace Demo;

public static class Calculator
{
    public static decimal ApplyDiscount(decimal price, decimal percent)
    {
        var discount = price * percent / 100m;
        return price - discount;
    }
}
`;

const TESTS = `using Xunit;

namespace Demo.Tests;

public class CalculatorTests
{
    [Fact]
    public void Applies_a_percentage_discount() =>
        Assert.Equal(90m, Demo.Calculator.ApplyDiscount(100m, 10m));
}
`;

const LIB_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup>
</Project>
`;

const MTP_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable>
    <OutputType>Exe</OutputType>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
    <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit.v3" Version="2.0.3" />
    <ProjectReference Include="../../src/Calc/Calc.csproj" />
  </ItemGroup>
</Project>
`;

const MSTEST_TESTS = `using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Demo.MsTests;

[TestClass]
public class DiscountTests
{
    [TestMethod]
    public void Applies_a_percentage_discount() =>
        Assert.AreEqual(90m, Demo.Calculator.ApplyDiscount(100m, 10m));
}
`;

const MSTEST_CSPROJ = `<Project Sdk="MSTest.Sdk/4.1.0">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../../src/Calc/Calc.csproj" />
  </ItemGroup>
</Project>
`;

test("usesMtpRunner: property, SDK, and adapter-less xunit.v3 shapes", () => {
  assert.equal(usesMtpRunner(MTP_CSPROJ), true);
  assert.equal(usesMtpRunner('<Project Sdk="MSTest.Sdk/3.8.3"></Project>'), true);
  assert.equal(usesMtpRunner('<PackageReference Include="xunit.v3" Version="2.0.3" />'), true, "xunit.v3 without adapter is MTP-only");
  assert.equal(
    usesMtpRunner(
      '<PackageReference Include="xunit.v3" /><PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />'
    ),
    false,
    "xunit.v3 WITH the VSTest adapter hosts fine — classic path"
  );
  assert.equal(
    usesMtpRunner('<PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" Version="2.9.0" />'),
    false,
    "classic xunit v2 stays classic"
  );
});

test("parseMtpRunOutput + mtpOutcomes: the exec fallback's synthesized outcomes", () => {
  const out = [
    "xUnit.net v3 Microsoft.Testing.Platform Runner v2.0.3 (64-bit .NET 10.0.11)",
    "",
    "failed Demo.Tests.CalculatorTests.Applies_a_percentage_discount (14ms)",
    "  Assert.Equal() Failure: Values differ",
    "  Expected: 91",
    "  Actual:   90",
    "",
    "Test run summary: Failed! - /x/Demo.Tests.dll (net10.0|x64)",
    "  total: 2",
    "  failed: 1",
    "  succeeded: 1",
    "  skipped: 0",
  ].join("\n");
  const parsed = parseMtpRunOutput(out);
  assert.equal(parsed.failed.length, 1);
  assert.equal(parsed.failed[0].fqn, "Demo.Tests.CalculatorTests.Applies_a_percentage_discount");
  assert.match(parsed.failed[0].message, /Expected: 91/);
  assert.deepEqual(parsed.counts, { total: 2, failed: 1, succeeded: 1, skipped: 0 });

  const outcomes = mtpOutcomes(
    ["Demo.Tests.CalculatorTests.Applies_a_percentage_discount", "Demo.Tests.CalculatorTests.Other"],
    parsed
  );
  assert.deepEqual(
    outcomes.map((o) => `${o.classFqn}.${o.method}:${o.passed ? "pass" : "fail"}`).sort(),
    [
      "Demo.Tests.CalculatorTests.Applies_a_percentage_discount:fail",
      "Demo.Tests.CalculatorTests.Other:pass",
    ]
  );
});

function scaffold(testDirName: string, testCsproj: string, testSource: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-mtp-e2e-"));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", testDirName), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "Calc", "Calc.csproj"), LIB_CSPROJ);
  fs.writeFileSync(path.join(root, "src", "Calc", "Calculator.cs"), CALC);
  fs.writeFileSync(path.join(root, "tests", testDirName, `${testDirName}.csproj`), testCsproj);
  fs.writeFileSync(path.join(root, "tests", testDirName, "Tests.cs"), testSource);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "mtp scaffold");
  return root;
}

function cleanup(root: string, runner: Runner): void {
  runner.mtpSessions?.dispose?.();
  runner.sessions?.dispose?.();
  runner.hotpatch?.dispose?.();
  fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root });
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

test("MTP xunit v3: warm sessions, per-test outcomes, and a hot-patched breaking edit", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against

  const root = scaffold("Demo.Tests", MTP_CSPROJ, TESTS);
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const runner = new Runner(root);
  runner.logSink = log;
  const ext = path.join(__dirname, "..", "..");
  const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), log);
  const hookOk = await hot.prepareRunsettings();
  assert.equal(hookOk, true, "hook helper must build");
  runner.sessions = new SessionRunner(root, path.join(ext, "helper"), log, hot.runsettingsFile);
  runner.hotpatch = hot;
  runner.mtpSessions = new MtpSessionRunner(log, hot.hookEnv() ?? {});

  try {
    await runner.prepare();
    const graph = runner.projectGraph();
    const testProj = testProjects(graph).find((p) => p.name === "Demo.Tests");
    assert.ok(testProj, "MTP project must be recognized as a test project");
    assert.equal(testProj!.usesMtpRunner, true, "MTP project must be flagged");

    // Discovery through the warm session's node stream.
    const discovered = await runner.discoverAll({ onPhase: log });
    assert.deepEqual(discovered["tests/Demo.Tests/Demo.Tests.csproj"], [
      "Demo.Tests.CalculatorTests.Applies_a_percentage_discount",
    ]);

    // Baseline run: warm session, per-test outcomes, and — because the hook
    // env rode along on the spawn — a registered patchable host.
    const all = await runner.runAffected({ classes: [], fallbackProjects: testProjects(graph), changedFiles: [] });
    assert.equal(all.ok, true, `baseline must be green: ${all.output.slice(0, 300)}`);
    assert.equal(all.outcomes.filter((o) => o.passed).length, 1, "the passing test must report as an outcome");
    assert.ok(logs.some((l) => l.includes("mtp session ready")), `warm session must be used, logs: ${logs.slice(-8).join(" | ")}`);
    const hostDir = path.join(cacheDirFor(root), "hotpatch-hosts");
    assert.ok(
      fs.existsSync(hostDir) && fs.readdirSync(hostDir).length > 0,
      "the resident MTP app must register as a patchable host"
    );

    const affectedSave: AffectedSet = {
      classes: ["Demo.Tests.CalculatorTests"],
      fallbackProjects: [],
      changedFiles: ["src/Calc/Calculator.cs"],
      classOwners: { "Demo.Tests.CalculatorTests": "tests/Demo.Tests/Demo.Tests.csproj" },
    };

    // Warm-up save on the build path establishes the hot-patch baseline
    // (first save has no complog yet), exactly like the vstest flow.
    const calc = path.join(root, "src", "Calc", "Calculator.cs");
    fs.writeFileSync(calc, CALC.replace("return price - discount;", "return price - discount; "));
    await runner.prepare();
    const warm = await runner.runAffected(affectedSave);
    assert.equal(warm.ok, true, `warm-up save must stay green: ${warm.output.slice(0, 300)}`);

    // The breaking edit must HOT-PATCH the resident MTP app and go red.
    fs.writeFileSync(calc, CALC.replace("price - discount", "price + discount"));
    await runner.prepare();
    logs.length = 0;
    const broken = await runner.runAffected(affectedSave);
    const failed = broken.outcomes.filter((o) => !o.passed && !o.skipped);
    assert.equal(broken.ok, false, "run must report failure");
    assert.equal(failed.length, 1, `the breaking edit must attribute the failing test: ${broken.output.slice(0, 400)}`);
    assert.equal(failed[0].classFqn, "Demo.Tests.CalculatorTests");
    assert.equal(failed[0].method, "Applies_a_percentage_discount");
    assert.ok(
      logs.some((l) => /applied 1 delta\(s\)/.test(l)),
      `the breaking edit must reach the resident app as a hot patch, logs: ${logs.join(" | ")}`
    );
    assert.ok(
      logs.some((l) => l.includes("fastpath=hit")),
      `the save must stay on the fast path, logs: ${logs.join(" | ")}`
    );

    // And the fix goes green again through the same patched host.
    fs.writeFileSync(calc, CALC);
    await runner.prepare();
    const fixed = await runner.runAffected(affectedSave);
    assert.equal(fixed.ok, true, `the fix must go green: ${fixed.output.slice(0, 300)}`);
  } finally {
    cleanup(root, runner);
  }
});

test("MTP without warm sessions: exec fallback stays correct and the fast path stays gated", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const root = scaffold("Demo.Tests", MTP_CSPROJ, TESTS);
  const logs: string[] = [];
  const runner = new Runner(root);
  runner.logSink = (m) => logs.push(m);
  runner.sessions = new SessionRunner(root, path.join(__dirname, "..", "..", "helper"), (m) => logs.push(m));
  // Deliberately NO mtpSessions: a fresh MTP process per run would load disk
  // assemblies, so an "applied" hot patch would run stale code green — the
  // gate must hold.

  try {
    await runner.prepare();
    const graph = runner.projectGraph();
    const discovered = await runner.discoverAll({ onPhase: (m) => logs.push(m) });
    assert.deepEqual(discovered["tests/Demo.Tests/Demo.Tests.csproj"], [
      "Demo.Tests.CalculatorTests.Applies_a_percentage_discount",
    ]);

    const all = await runner.runAffected({ classes: [], fallbackProjects: testProjects(graph), changedFiles: [] });
    assert.equal(all.ok, true);
    assert.equal(all.outcomes.filter((o) => o.passed).length, 1);

    const affectedSave: AffectedSet = {
      classes: ["Demo.Tests.CalculatorTests"],
      fallbackProjects: [],
      changedFiles: ["src/Calc/Calculator.cs"],
      classOwners: { "Demo.Tests.CalculatorTests": "tests/Demo.Tests/Demo.Tests.csproj" },
    };
    const calc = path.join(root, "src", "Calc", "Calculator.cs");
    fs.writeFileSync(calc, CALC.replace("price - discount", "price + discount"));
    await runner.prepare();
    logs.length = 0;
    const broken = await runner.runAffected(affectedSave);
    const failed = broken.outcomes.filter((o) => !o.passed && !o.skipped);
    assert.equal(broken.ok, false);
    assert.equal(failed[0]?.method, "Applies_a_percentage_discount");
    assert.ok(
      logs.some((l) => l.includes("fastpath=off(mtp-project)")),
      `without warm sessions the fast path must stay gated, logs: ${logs.join(" | ")}`
    );
  } finally {
    cleanup(root, runner);
  }
});

test("MTP MSTest: per-test attribution through server-mode node locations", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const root = scaffold("Demo.MsTests", MSTEST_CSPROJ, MSTEST_TESTS);
  const logs: string[] = [];
  const runner = new Runner(root);
  runner.logSink = (m) => logs.push(m);
  runner.sessions = new SessionRunner(root, path.join(__dirname, "..", "..", "helper"), (m) => logs.push(m));
  runner.mtpSessions = new MtpSessionRunner((m) => logs.push(m));

  try {
    await runner.prepare();
    const graph = runner.projectGraph();

    // MSTest's console listing prints bare display names; the server-mode
    // node stream carries location.type, so discovery attributes classes.
    const discovered = await runner.discoverAll({ onPhase: (m) => logs.push(m) });
    assert.deepEqual(discovered["tests/Demo.MsTests/Demo.MsTests.csproj"], [
      "Demo.MsTests.DiscountTests.Applies_a_percentage_discount",
    ]);

    const all = await runner.runAffected({ classes: [], fallbackProjects: testProjects(graph), changedFiles: [] });
    assert.equal(all.ok, true, `baseline must be green: ${all.output.slice(0, 300)}`);
    assert.equal(all.outcomes.filter((o) => o.passed).length, 1);

    const affectedSave: AffectedSet = {
      classes: ["Demo.MsTests.DiscountTests"],
      fallbackProjects: [],
      changedFiles: ["src/Calc/Calculator.cs"],
      classOwners: { "Demo.MsTests.DiscountTests": "tests/Demo.MsTests/Demo.MsTests.csproj" },
    };
    const calc = path.join(root, "src", "Calc", "Calculator.cs");
    fs.writeFileSync(calc, CALC.replace("price - discount", "price + discount"));
    await runner.prepare();
    const broken = await runner.runAffected(affectedSave);
    const failed = broken.outcomes.filter((o) => !o.passed && !o.skipped);
    assert.equal(broken.ok, false, "run must report failure");
    assert.equal(failed.length, 1, `MSTest failure must attribute per test: ${broken.output.slice(0, 400)}`);
    assert.equal(failed[0].classFqn, "Demo.MsTests.DiscountTests");
    assert.equal(failed[0].method, "Applies_a_percentage_discount");
    assert.match(failed[0].message ?? "", /AreEqual failed/);
  } finally {
    cleanup(root, runner);
  }
});
