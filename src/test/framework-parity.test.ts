import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { HotPatcher } from "../core/hotpatch";
import { testProjects } from "../core/projects";
import { AffectedSet, Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import { SessionRunner } from "../core/vstestSession";
import { dotnetOrNull } from "./deltas-helper";

/**
 * Framework parity: xunit, NUnit, and MSTest (VSTest adapters) must move
 * through the WHOLE pipeline identically — discovery lists the class and its
 * methods, a full run attributes green outcomes to class+method, a breaking
 * edit turns the SPECIFIC test red whichever path the save takes, the fix
 * goes green on the fast path, and a freshly added test method is discovered
 * after its save (the #13 rebuild-so-discovery-sees-it path — which also
 * pins the ApiGuard test-attribute table for all three frameworks).
 *
 * One contract, three scaffolds; a fourth flavor (e.g. an MTP-native runner)
 * is one FLAVORS entry away.
 */

const LIB = `namespace Demo;

public static class Calc
{
    public static int Add(int a, int b)
    {
        return a + b;
    }

    public static int Mul(int a, int b)
    {
        return a * b;
    }
}
`;

const TEST_SDK = `<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />`;

interface Flavor {
  name: string;
  packages: string;
  /** Test source; must contain the __MORE__ marker inside the class body. */
  tests: string;
  /** A passing test method to append at __MORE__ for the discovery check. */
  extraMethod: string;
}

const FLAVORS: Flavor[] = [
  {
    name: "xunit",
    packages: `${TEST_SDK}
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />`,
    tests: `using Xunit;

namespace Demo.Tests;

public class CalcTests
{
    [Fact]
    public void Adds() => Assert.Equal(5, Demo.Calc.Add(2, 3));

    [Fact]
    public void Muls() => Assert.Equal(6, Demo.Calc.Mul(2, 3));
    // __MORE__
}
`,
    extraMethod: `
    [Fact]
    public void Extra() => Assert.True(true);
    // __MORE__`,
  },
  {
    name: "nunit",
    packages: `${TEST_SDK}
    <PackageReference Include="NUnit" Version="4.2.2" />
    <PackageReference Include="NUnit3TestAdapter" Version="4.6.0" />`,
    tests: `using NUnit.Framework;

namespace Demo.Tests;

public class CalcTests
{
    [Test]
    public void Adds() => Assert.That(Demo.Calc.Add(2, 3), Is.EqualTo(5));

    [Test]
    public void Muls() => Assert.That(Demo.Calc.Mul(2, 3), Is.EqualTo(6));
    // __MORE__
}
`,
    extraMethod: `
    [Test]
    public void Extra() => Assert.That(true, Is.True);
    // __MORE__`,
  },
  {
    name: "mstest",
    packages: `${TEST_SDK}
    <PackageReference Include="MSTest.TestFramework" Version="3.6.3" />
    <PackageReference Include="MSTest.TestAdapter" Version="3.6.3" />`,
    tests: `using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Demo.Tests;

[TestClass]
public class CalcTests
{
    [TestMethod]
    public void Adds() => Assert.AreEqual(5, Demo.Calc.Add(2, 3));

    [TestMethod]
    public void Muls() => Assert.AreEqual(6, Demo.Calc.Mul(2, 3));
    // __MORE__
}
`,
    extraMethod: `
    [TestMethod]
    public void Extra() => Assert.IsTrue(true);
    // __MORE__`,
  },
];

function scaffold(flavor: Flavor): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `impact-parity-${flavor.name}-`));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Calc.Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Calc", "Calc.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
  );
  fs.writeFileSync(path.join(root, "src", "Calc", "Calc.cs"), LIB);
  fs.writeFileSync(
    path.join(root, "tests", "Calc.Tests", "Calc.Tests.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>
  <ItemGroup>
    ${flavor.packages}
    <ProjectReference Include="../../src/Calc/Calc.csproj" />
  </ItemGroup>
</Project>`
  );
  fs.writeFileSync(path.join(root, "tests", "Calc.Tests", "CalcTests.cs"), flavor.tests);
  // .gitignore ships in the scaffold: the #28 fix makes its absence safe, but
  // parity here is about frameworks, not the untracked-outputs guard.
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

for (const flavor of FLAVORS) {
  test(`framework parity: ${flavor.name} — discover, attribute, red on break, green on fix, fast path, new-test discovery`, { timeout: 600_000 }, async () => {
    const dotnet = dotnetOrNull();
    if (!dotnet) return; // no SDK on this machine: nothing to test against

    const root = scaffold(flavor);
    const ext = path.join(__dirname, "..", "..");
    const logs: string[] = [];
    const log = (m: string) => {
      logs.push(m);
      console.log(`   [${flavor.name}] ${m}`);
    };
    const runner = new Runner(root);
    runner.logSink = log;
    const hot = new HotPatcher(root, path.join(ext, "helper-deltas"), path.join(ext, "helper-hotpatch"), log);
    const hookOk = await hot.prepareRunsettings();
    runner.sessions = new SessionRunner(root, path.join(ext, "helper"), log, hookOk ? hot.runsettingsFile : undefined);
    if (hookOk) runner.hotpatch = hot;

    const calc = path.join(root, "src", "Calc", "Calc.cs");
    const testsFile = path.join(root, "tests", "Calc.Tests", "CalcTests.cs");
    const testsRel = "tests/Calc.Tests/Calc.Tests.csproj";
    const affectedSave: AffectedSet = {
      classes: ["Demo.Tests.CalcTests"],
      fallbackProjects: [],
      changedFiles: ["src/Calc/Calc.cs"],
      classOwners: { "Demo.Tests.CalcTests": testsRel },
    };
    const run = async (label: string, affected?: AffectedSet) => {
      await runner.prepare();
      const a = affected ?? {
        classes: [],
        fallbackProjects: testProjects(runner.projectGraph()),
        changedFiles: [],
      };
      const res = await runner.runAffected(a);
      const failed = res.outcomes.filter((o) => !o.passed && !o.skipped).map((o) => `${o.classFqn}.${o.method}`);
      log(`>> ${label}: ok=${res.ok} outcomes=${res.outcomes.length} failed=[${failed.join(", ")}]`);
      return { res, failed };
    };

    try {
      // 1. Discovery lists the class and both methods, fully qualified.
      await runner.prepare();
      const discovered = await runner.discoverAll({ onPhase: log });
      const methods = discovered[testsRel] ?? [];
      for (const m of ["Demo.Tests.CalcTests.Adds", "Demo.Tests.CalcTests.Muls"]) {
        assert.ok(methods.includes(m), `${flavor.name}: discovery must list ${m}; got [${methods.join(", ")}]`);
      }

      // 2. Full run: green, attributed to class + method.
      const all = await run("full run");
      assert.equal(all.res.ok, true, `${flavor.name}: full run must be green`);
      assert.equal(all.failed.length, 0);
      const names = all.res.outcomes.map((o) => `${o.classFqn}.${o.method}`).sort();
      assert.equal(names.length, 2, `${flavor.name}: both tests must report; got [${names.join(", ")}]`);
      for (const n of names) {
        assert.match(n, /CalcTests\.(Adds|Muls)$/, `${flavor.name}: attribution must carry class+method, got ${n}`);
      }

      // 3. Breaking edit: the SPECIFIC test goes red, its sibling stays green.
      fs.writeFileSync(calc, LIB.replace("return a + b;", "return a + b + 1;"));
      const broken = await run("breaking edit", affectedSave);
      assert.equal(broken.failed.length, 1, `${flavor.name}: exactly Adds must fail; failed=[${broken.failed.join(", ")}]`);
      assert.match(broken.failed[0], /CalcTests\.Adds$/);
      assert.ok(
        broken.res.outcomes.some((o) => o.method.includes("Muls") && o.passed),
        `${flavor.name}: Muls must still pass in the same run`
      );

      // 4+5. Fix goes green — and by now the baseline exists, so this save
      // must ride the fast path. A framework that silently never fast-paths
      // would break the product's core promise for its users.
      const logMark = logs.length;
      fs.writeFileSync(calc, LIB);
      const fixed = await run("fix edit", affectedSave);
      assert.equal(fixed.failed.length, 0, `${flavor.name}: fix must go green`);
      assert.ok(fixed.res.outcomes.length >= 1);
      assert.ok(
        logs.slice(logMark).some((l) => l.includes("fastpath=hit")),
        `${flavor.name}: the fix save must hot-patch (fastpath=hit); routes: ${logs
          .slice(logMark)
          .filter((l) => l.includes("fastpath"))
          .join(" | ")}`
      );

      // 6. A new test method lands in discovery after its save (#13) — this
      // also pins ApiGuard's test-attribute table per framework: the save must
      // take the build path (new tests are discovered from the dll on disk).
      fs.writeFileSync(testsFile, flavor.tests.replace("    // __MORE__", flavor.extraMethod));
      await run("add test method", {
        classes: ["Demo.Tests.CalcTests"],
        fallbackProjects: [],
        changedFiles: ["tests/Calc.Tests/CalcTests.cs"],
        classOwners: { "Demo.Tests.CalcTests": testsRel },
      });
      await runner.prepare();
      const rediscovered = await runner.discoverAll({ onPhase: log });
      assert.ok(
        (rediscovered[testsRel] ?? []).includes("Demo.Tests.CalcTests.Extra"),
        `${flavor.name}: the new test must be discoverable after its save; got [${(rediscovered[testsRel] ?? []).join(", ")}]`
      );
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
}
