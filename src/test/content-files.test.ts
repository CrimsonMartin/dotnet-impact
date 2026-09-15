import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AffectedSet, Runner } from "../core/runner";
import { cacheDirFor, resolveDotnet } from "../core/util";
import { dotnetOrNull } from "./deltas-helper";

/**
 * Regression tests for #43 — shadow copy does not sync modified or new
 * non-source content files.
 *
 * The overlay itself (syncOverlay) mirrored every dirty/untracked file,
 * regardless of extension — the stale content lived one step downstream:
 * the BUILD decision. sourceStamp() stamped code files only (cs/csproj/.../
 * json, no xml), so a content-only edit — a fixture xml under
 * <None CopyToOutputDirectory> — left every project's stamp unchanged.
 * minimalBuild then skipped the test project's rebuild, MSBuild never
 * re-ran its content copy, and the build output kept the OLD fixture while
 * the dependency dll was fresh: the test compared new code against the
 * stale fixture and reported false failures, while a direct `dotnet test`
 * in the working tree (full build, content copied) passed. A NEW untracked
 * fixture suffered the same way — the shadow tree had it, the build output
 * never did, because no rebuild ever ran to copy it.
 *
 * The fix: STAMP_FILE_RE covers content files too, so a content edit
 * invalidates the stamp exactly like a code edit and the project rebuilds.
 *
 * This test drives the real pipeline (no hot patch, no sessions — the pure
 * build path) with a dependency edit as the trigger, so the minimal build
 * rebuilds ONLY the dependency unless the test project's stamp notices the
 * fixture change. Pre-fix: red with stale fixture. Post-fix: green.
 */

const CALC = `namespace Demo;

public static class Fixture
{
    public static string Value => "one";
    public static string Extra => null;
}
`;

const TESTS = `using System;
using System.IO;
using System.Xml.Linq;
using Xunit;

namespace Demo.Tests;

public class FixtureTests
{
    private static string ReadFixture(string name)
    {
        var p = Path.Combine(AppContext.BaseDirectory, "Fixtures", name);
        if (!File.Exists(p)) return null;
        return XDocument.Load(p).Root.Value;
    }

    [Fact]
    public void Data_matches_code() =>
        Assert.Equal(Demo.Fixture.Value, ReadFixture("data.xml"));

    [Fact]
    public void Extra_matches_code() =>
        Assert.Equal(Demo.Fixture.Extra, ReadFixture("extra.xml"));
}
`;

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-content-"));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Demo.Tests", "Fixtures"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Calc", "Calc.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>'
  );
  fs.writeFileSync(path.join(root, "src", "Calc", "Calculator.cs"), CALC);
  fs.writeFileSync(
    path.join(root, "tests", "Demo.Tests", "Demo.Tests.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable><Nullable>enable</Nullable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <ProjectReference Include="../../src/Calc/Calc.csproj" />
    <None Include="Fixtures/**" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>
</Project>`
  );
  fs.writeFileSync(path.join(root, "tests", "Demo.Tests", "Tests.cs"), TESTS);
  // Tracked content file the test reads from the build output.
  fs.writeFileSync(
    path.join(root, "tests", "Demo.Tests", "Fixtures", "data.xml"),
    "<value>one</value>"
  );
  const git = (...a: string[]) =>
    execFileSync("git", a, {
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

test("#43: content edit + new untracked fixture reach the build output", { timeout: 900_000 }, async (t) => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  t.diagnostic?.("dotnet available: " + dotnet);

  const root = scaffold();
  const log = (m: string) => console.log(`   [log] ${m}`);
  const runner = new Runner(root);
  runner.logSink = log;
  const aff: AffectedSet = {
    classes: ["Demo.Tests.FixtureTests"],
    fallbackProjects: [],
    changedFiles: ["src/Calc/Calculator.cs"],
    classOwners: { "Demo.Tests.FixtureTests": "tests/Demo.Tests/Demo.Tests.csproj" },
  };
  const run = async (label: string) => {
    await runner.prepare();
    const res = await runner.runAffected(aff);
    const failed = res.outcomes.filter((o) => !o.passed && !o.skipped).map((o) => o.method);
    log(`>> ${label}: ok=${res.ok} outcomes=${res.outcomes.length} failed=[${failed.join(", ")}]`);
    return res;
  };

  try {
    // Baseline: committed fixture "one" matches code "one" — green.
    // Run 1 restores+builds everything (the first minimalBuild attempt falls
    // back to full builds on an unrestored shadow). Run 2 is what a user's
    // next save sees: the stamp-recording minimalBuild path — the one #43
    // broke. Both must be green before we edit.
    const baseline = await run("baseline");
    assert.equal(
      baseline.outcomes.length,
      2,
      `both fixture tests must have run (ok=${baseline.ok}, out: ${baseline.output.slice(-400)})`
    );
    assert.equal(baseline.ok, true, `baseline must be green: ${baseline.output.slice(-400)}`);
    const warm = await run("warm");
    assert.equal(
      warm.ok,
      true,
      `warm run (minimalBuild path) must be green: ${warm.output.slice(-400)}`
    );

    // The issue's repro: modify the tracked content file, add a new untracked
    // one in the same folder, and edit the dependency the test depends on.
    fs.writeFileSync(
      path.join(root, "tests", "Demo.Tests", "Fixtures", "data.xml"),
      "<value>two</value>"
    );
    fs.writeFileSync(
      path.join(root, "tests", "Demo.Tests", "Fixtures", "extra.xml"),
      "<value>three</value>"
    );
    fs.writeFileSync(
      path.join(root, "src", "Calc", "Calculator.cs"),
      CALC.replace('Value => "one"', 'Value => "two"').replace("Extra => null", 'Extra => "three"')
    );

    const res = await run("content edit + new fixture");
    // The shadow tree must mirror both content files (the overlay half).
    const shadow = await runner.prepare();
    assert.equal(
      fs.readFileSync(path.join(shadow.dir, "tests", "Demo.Tests", "Fixtures", "data.xml"), "utf8"),
      "<value>two</value>",
      "shadow must hold the modified tracked fixture"
    );
    assert.equal(
      fs.readFileSync(path.join(shadow.dir, "tests", "Demo.Tests", "Fixtures", "extra.xml"), "utf8"),
      "<value>three</value>",
      "shadow must hold the new untracked fixture"
    );
    // And the build output must have them too: the test reads from there.
    // Pre-fix the test project's stamp never changed (no .cs edit in it), the
    // minimal build skipped it, and the output kept the stale fixture —
    // Data_matches_code compared "two" (fresh dll) against "one" (stale xml)
    // and Extra_matches_code compared "three" against missing.
    const outDir = path.join(shadow.dir, "tests", "Demo.Tests", "bin", "Debug", "net10.0");
    assert.equal(
      fs.readFileSync(path.join(outDir, "Fixtures", "data.xml"), "utf8"),
      "<value>two</value>",
      "the build output must hold the modified tracked fixture"
    );
    assert.equal(
      fs.readFileSync(path.join(outDir, "Fixtures", "extra.xml"), "utf8"),
      "<value>three</value>",
      "the build output must hold the new untracked fixture"
    );
    assert.equal(
      res.outcomes.length,
      2,
      `both fixture tests must have run (ok=${res.ok}, out: ${res.output.slice(-400)})`
    );
    const failed = res.outcomes.filter((o) => !o.passed && !o.skipped).map((o) => o.method);
    assert.equal(
      failed.length,
      0,
      `content files must reach the build output — stale-fixture failures: [${failed.join(", ")}]\n` +
        `output: ${res.output.slice(-600)}`
    );
  } finally {
    runner.sessions?.dispose?.();
    cleanup(root);
  }
});
