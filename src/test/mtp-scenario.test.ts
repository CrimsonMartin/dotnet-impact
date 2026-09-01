import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { mtpOutcomes, parseMtpRunOutput } from "../core/mtp";
import { testProjects, usesMtpRunner } from "../core/projects";
import { AffectedSet, Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { dotnetOrNull } from "./deltas-helper";

/**
 * #23 Phase 1: an MTP-native test project (xunit v3, no VSTest adapter) must
 * work end to end through the degraded-but-correct path — discovery through
 * the app's own --list-tests, runs through the app with synthesized
 * per-method outcomes, hot patch and warm sessions skipped loudly
 * (fastpath=off(mtp-project)) so a fresh MTP process never runs stale
 * assemblies green.
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

test("parseMtpRunOutput + mtpOutcomes: failures from output, passes from the listing", () => {
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

test("MTP scenario: discovery, green run, red break — all through the MTP app", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-mtp-e2e-"));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Demo.Tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "Calc", "Calc.csproj"), LIB_CSPROJ);
  fs.writeFileSync(path.join(root, "src", "Calc", "Calculator.cs"), CALC);
  fs.writeFileSync(path.join(root, "tests", "Demo.Tests", "Demo.Tests.csproj"), MTP_CSPROJ);
  fs.writeFileSync(path.join(root, "tests", "Demo.Tests", "Tests.cs"), TESTS);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "mtp scaffold");

  const logs: string[] = [];
  const runner = new Runner(root);
  runner.logSink = (m) => logs.push(m);
  runner.sessions = new SessionRunner(root, path.join(__dirname, "..", "..", "helper"), (m) => logs.push(m));

  try {
    await runner.prepare();
    const graph = runner.projectGraph();
    const testProj = testProjects(graph).find((p) => p.name === "Demo.Tests");
    assert.ok(testProj, "MTP project must be recognized as a test project");
    assert.equal(testProj!.usesMtpRunner, true, "MTP project must be flagged");

    // Discovery through the app's own --list-tests.
    const discovered = await runner.discoverAll({ onPhase: (m) => logs.push(m) });
    assert.deepEqual(discovered["tests/Demo.Tests/Demo.Tests.csproj"], [
      "Demo.Tests.CalculatorTests.Applies_a_percentage_discount",
    ]);

    const affectedSave: AffectedSet = {
      classes: ["Demo.Tests.CalculatorTests"],
      fallbackProjects: [],
      changedFiles: ["src/Calc/Calculator.cs"],
      classOwners: { "Demo.Tests.CalculatorTests": "tests/Demo.Tests/Demo.Tests.csproj" },
    };

    // Green run with real per-method outcomes.
    const all = await runner.runAffected({ classes: [], fallbackProjects: testProjects(graph), changedFiles: [] });
    assert.equal(all.ok, true, `baseline must be green: ${all.output.slice(0, 300)}`);
    assert.equal(all.outcomes.filter((o) => o.passed).length, 1, "the passing test must report as an outcome");

    // Breaking edit: MUST go red through the MTP app, with the hot-patch
    // fast path explicitly refusing MTP projects (fresh processes would run
    // stale assemblies green if a patch "succeeded").
    const calc = path.join(root, "src", "Calc", "Calculator.cs");
    fs.writeFileSync(calc, CALC.replace("price - discount", "price + discount"));
    await runner.prepare();
    logs.length = 0;
    const broken = await runner.runAffected(affectedSave);
    const failed = broken.outcomes.filter((o) => !o.passed && !o.skipped);
    assert.equal(broken.ok, false, "run must report failure");
    assert.equal(failed.length, 1, `the breaking edit must attribute the failing test: ${broken.output.slice(0, 300)}`);
    assert.equal(failed[0].classFqn, "Demo.Tests.CalculatorTests");
    assert.equal(failed[0].method, "Applies_a_percentage_discount");
    assert.ok(
      logs.some((l) => l.includes("fastpath=off(mtp-project)")),
      `hot patch must be skipped for MTP projects, logs: ${logs.join(" | ")}`
    );

    // And the fix goes green again.
    fs.writeFileSync(calc, CALC);
    await runner.prepare();
    const fixed = await runner.runAffected(affectedSave);
    assert.equal(fixed.ok, true);
    assert.equal(fixed.outcomes.filter((o) => o.passed).length, 1);
  } finally {
    runner.sessions?.dispose?.();
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
