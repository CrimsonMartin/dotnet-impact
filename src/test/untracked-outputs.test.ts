import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { HotPatcher } from "../core/hotpatch";
import { testProjects } from "../core/projects";
import { AffectedSet, Runner } from "../core/runner";
import { cacheDirFor, resolveDotnet } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { ensureShadow, isOverlaySkippedPath, syncOverlay } from "../core/worktree";
import { dotnetOrNull } from "./deltas-helper";

/**
 * Regression tests for #28 — the zero-diagnostic fast-path no-op.
 *
 * In a repo without a .gitignore, builds run in the REAL tree leave untracked
 * bin/obj outputs. syncOverlay (untracked-files=all) used to mirror them into
 * the shadow with fresh mtimes on every prepare; the newest-mtime dll pick
 * then baselined the EnC session on that FOREIGN-build module, whose PDB
 * documents carry real-tree paths. Roslyn found no matching documents and
 * silently skipped every edit (the session runs with reportDiagnostics off),
 * so a breaking save reported `fastpath=hit … applied 0 delta(s)` and stayed
 * GREEN — no diagnostic anywhere, sailing past both v0.2.7 guards.
 *
 * Three layers under test here:
 *   1. the overlay never copies build-output paths (kills the cause);
 *   2. (e2e) the discoverAll-first sequence from the MTP probe's control
 *      scenario — the exact shape that produced the lie — must go red;
 *   3. a load pairing a complog with a foreign build's dll/pdb is refused
 *      up front ("foreign build"), so any OTHER route to the same state
 *      falls to the build path instead of lying.
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

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-untracked-"));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Demo.Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Calc", "Calc.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>'
  );
  fs.writeFileSync(path.join(root, "src", "Calc", "Calculator.cs"), CALC);
  fs.writeFileSync(
    path.join(root, "tests", "Demo.Tests", "Demo.Tests.csproj"),
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
  fs.writeFileSync(path.join(root, "tests", "Demo.Tests", "Tests.cs"), TESTS);
  // Deliberately NO .gitignore — the bug requires untracked build outputs.
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

test("isOverlaySkippedPath: build outputs by segment, sources pass", () => {
  assert.equal(isOverlaySkippedPath("src/Calc/bin/Debug/net10.0/Calc.dll"), true);
  assert.equal(isOverlaySkippedPath("src/Calc/obj/Debug/net10.0/Calc.AssemblyInfo.cs"), true);
  assert.equal(isOverlaySkippedPath("tests\\Demo.Tests\\OBJ\\x.cs"), true); // Windows separators + case
  assert.equal(isOverlaySkippedPath("node_modules/x/y.cs"), true);
  assert.equal(isOverlaySkippedPath("src/Calc/Calculator.cs"), false);
  assert.equal(isOverlaySkippedPath("src/binary/Objects.cs"), false); // whole segments only
});

test("syncOverlay: untracked build outputs never reach the shadow; real edits still do", async () => {
  const root = scaffold();
  try {
    // Untracked junk a real-tree build leaves behind, plus a real edit.
    fs.mkdirSync(path.join(root, "src", "Calc", "bin", "Debug"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "Calc", "obj", "Debug"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "Calc", "bin", "Debug", "Calc.dll"), "STALE BINARY");
    fs.writeFileSync(path.join(root, "src", "Calc", "obj", "Debug", "Calc.AssemblyInfo.cs"), "// generated");
    fs.writeFileSync(path.join(root, "src", "Calc", "Calculator.cs"), CALC.replace("price - discount", "price + discount"));

    const shadow = await ensureShadow(root);
    const synced = await syncOverlay(shadow);

    assert.ok(
      fs.readFileSync(path.join(shadow.dir, "src", "Calc", "Calculator.cs"), "utf8").includes("price + discount"),
      "the real edit must be mirrored"
    );
    assert.ok(
      !fs.existsSync(path.join(shadow.dir, "src", "Calc", "bin", "Debug", "Calc.dll")),
      "an untracked real-tree binary must never be mirrored (#28)"
    );
    assert.ok(
      !fs.existsSync(path.join(shadow.dir, "src", "Calc", "obj", "Debug", "Calc.AssemblyInfo.cs")),
      "untracked obj noise must never be mirrored"
    );
    assert.ok(!synced.some((f) => isOverlaySkippedPath(f)), "the manifest must not track skipped paths");
  } finally {
    cleanup(root);
  }
});

test("#28 e2e: real-tree builds before impact, discoverAll-first — a breaking save still goes red", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against

  const root = scaffold();
  const ext = path.join(__dirname, "..", "..");
  const log = (m: string) => console.log(`   [log] ${m}`);
  const dn = resolveDotnet();
  const env = { ...process.env, DOTNET_ROOT: path.isAbsolute(dn) ? path.dirname(dn) : process.env.DOTNET_ROOT, MSBUILDTERMINALLOGGER: "off" };
  // The trigger: builds + a test run in the REAL tree first (as a user's
  // terminal, CI checkout, or the MTP probe's stage 0 would), leaving
  // untracked bin/obj that the overlay used to mirror.
  execFileSync(dn, ["build", path.join(root, "tests", "Demo.Tests", "Demo.Tests.csproj"), "--nologo", "-v", "quiet"], {
    cwd: root, stdio: "pipe", timeout: 300_000, env,
  });
  execFileSync(dn, ["test", path.join(root, "tests", "Demo.Tests", "Demo.Tests.csproj"), "--no-build", "--nologo", "-v", "quiet"], {
    cwd: root, stdio: "pipe", timeout: 300_000, env,
  });

  const runner = new Runner(root);
  runner.logSink = log;
  const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), log);
  const hookOk = await hot.prepareRunsettings();
  runner.sessions = new SessionRunner(root, path.join(ext, "helper"), log, hookOk ? hot.runsettingsFile : undefined);
  if (hookOk) runner.hotpatch = hot;

  const calc = path.join(root, "src", "Calc", "Calculator.cs");
  const aff: AffectedSet = {
    classes: ["Demo.Tests.CalculatorTests"],
    fallbackProjects: [],
    changedFiles: ["src/Calc/Calculator.cs"],
    classOwners: { "Demo.Tests.CalculatorTests": "tests/Demo.Tests/Demo.Tests.csproj" },
  };
  const run = async (label: string, a?: AffectedSet) => {
    await runner.prepare();
    const affected = a ?? { classes: [], fallbackProjects: testProjects(runner.projectGraph()), changedFiles: [] };
    const res = await runner.runAffected(affected);
    const failed = res.outcomes.filter((o) => !o.passed && !o.skipped).map((o) => `${o.classFqn}.${o.method}`);
    log(`>> ${label}: ok=${res.ok} outcomes=${res.outcomes.length} failed=[${failed.join(", ")}]`);
    return { res, failed };
  };

  try {
    // The exact sequence from the probe's control scenario.
    await runner.prepare();
    await runner.discoverAll({ onPhase: (m) => log(`discover: ${m}`) });
    const all = await run("run all");
    assert.equal(all.failed.length, 0, "baseline suite must be green");

    fs.writeFileSync(calc, CALC.replace("return price - discount;", "return price - discount; "));
    assert.equal((await run("whitespace save", aff)).failed.length, 0);

    fs.writeFileSync(calc, CALC.replace("return price - discount;", "return price + discount; "));
    const broken = await run("breaking save", aff);
    assert.ok(
      broken.failed.some((f) => f.includes("Applies_a_percentage_discount")),
      "the breaking save must go red — a green result here is the #28 zero-diagnostic lie " +
        `(got ok=${broken.res.ok}, failed=[${broken.failed.join(", ")}])`
    );

    fs.writeFileSync(calc, CALC);
    const fixed = await run("revert", aff);
    assert.equal(fixed.failed.length, 0, "the revert must go green again");
  } finally {
    runner.sessions?.dispose?.();
    hot.dispose();
    cleanup(root);
  }
});
