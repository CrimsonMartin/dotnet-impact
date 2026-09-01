import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AffectedSet, Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { dotnetOrNull } from "./deltas-helper";

/**
 * A failed build must not run tests: the only dlls on disk are from the last
 * successful build, and their results would repaint the explorer with
 * verdicts about code that no longer exists (a stale-green cousin of #28).
 * Instead the broken project's mapped tests report as skipped ("build
 * failed") — grey — while an unrelated project that still builds keeps its
 * real feedback. The next green build runs them for real again.
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

const CALC_TESTS = `using Xunit;

namespace Demo.Tests;

public class CalculatorTests
{
    [Fact]
    public void Applies_a_percentage_discount() =>
        Assert.Equal(90m, Demo.Calculator.ApplyDiscount(100m, 10m));
}
`;

const OTHER_TESTS = `using Xunit;

namespace Other.Tests;

public class StandaloneTests
{
    [Fact]
    public void Arithmetic_still_works() => Assert.Equal(4, 2 + 2);
}
`;

const TEST_CSPROJ = (refCalc: boolean) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    ${refCalc ? '<ProjectReference Include="../../src/Calc/Calc.csproj" />' : ""}
  </ItemGroup>
</Project>`;

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-buildskip-"));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Demo.Tests"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Other.Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Calc", "Calc.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
  );
  fs.writeFileSync(path.join(root, "src", "Calc", "Calculator.cs"), CALC);
  fs.writeFileSync(path.join(root, "tests", "Demo.Tests", "Demo.Tests.csproj"), TEST_CSPROJ(true));
  fs.writeFileSync(path.join(root, "tests", "Demo.Tests", "Tests.cs"), CALC_TESTS);
  fs.writeFileSync(path.join(root, "tests", "Other.Tests", "Other.Tests.csproj"), TEST_CSPROJ(false));
  fs.writeFileSync(path.join(root, "tests", "Other.Tests", "Tests.cs"), OTHER_TESTS);
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

function cleanup(root: string): void {
  fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root });
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

test("build failure: broken project's tests grey out, unrelated project still runs", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against

  const root = scaffold();
  const ext = path.join(__dirname, "..", "..");
  const log = (m: string) => console.log(`   [log] ${m}`);
  const runner = new Runner(root);
  runner.logSink = log;
  runner.sessions = new SessionRunner(root, path.join(ext, "helper"), log, undefined);

  const calc = path.join(root, "src", "Calc", "Calculator.cs");
  const aff: AffectedSet = {
    classes: ["Demo.Tests.CalculatorTests", "Other.Tests.StandaloneTests"],
    fallbackProjects: [],
    changedFiles: ["src/Calc/Calculator.cs"],
    classOwners: {
      "Demo.Tests.CalculatorTests": "tests/Demo.Tests/Demo.Tests.csproj",
      "Other.Tests.StandaloneTests": "tests/Other.Tests/Other.Tests.csproj",
    },
  };
  const run = async (label: string) => {
    await runner.prepare();
    const res = await runner.runAffected(aff);
    log(
      `>> ${label}: ok=${res.ok} ` +
        res.outcomes.map((o) => `${o.classFqn.split(".").pop()}.${o.method.split(".").pop()}=` +
          (o.skipped ? "skipped" : o.passed ? "pass" : "fail")).join(" ")
    );
    return res;
  };

  try {
    const baseline = await run("baseline");
    assert.equal(baseline.ok, true, "baseline must be green");
    assert.ok(baseline.outcomes.some((o) => o.passed && o.classFqn === "Demo.Tests.CalculatorTests"));

    // Break the LIBRARY so Demo.Tests (and only it) cannot build.
    fs.writeFileSync(calc, CALC.replace("return price - discount;", "return price - discount"));
    const broken = await run("broken build");
    assert.equal(broken.ok, false, "a failed build must fail the run");
    const demo = broken.outcomes.filter((o) => o.classFqn === "Demo.Tests.CalculatorTests");
    assert.ok(demo.length > 0, "the broken project's tests must still be reported (as skips)");
    for (const o of demo) {
      assert.equal(o.skipped, true, `${o.method} ran against stale binaries instead of skipping`);
      assert.equal(o.message, "build failed");
    }
    const other = broken.outcomes.filter((o) => o.classFqn === "Other.Tests.StandaloneTests");
    assert.ok(
      other.some((o) => o.passed && !o.skipped),
      "the unrelated project still builds — its tests must run for real"
    );

    // Failure-first bookkeeping must ignore the skips: nothing was learned
    // about these tests, so nothing may be recorded as failing.
    assert.equal(
      (runner as unknown as { lastFailures: Set<string> }).lastFailures.has("Demo.Tests.CalculatorTests"),
      false,
      "a build-failure skip must not be recorded as a test failure"
    );

    // Fix the build: the greyed tests run for real again.
    fs.writeFileSync(calc, CALC);
    const fixed = await run("fixed");
    assert.equal(fixed.ok, true, `fixed run must be green: ${fixed.output.slice(-400)}`);
    assert.ok(
      fixed.outcomes.some((o) => o.passed && !o.skipped && o.classFqn === "Demo.Tests.CalculatorTests"),
      "after a green build the tests must produce real outcomes again"
    );
  } finally {
    runner.sessions?.dispose?.();
    cleanup(root);
  }
});
