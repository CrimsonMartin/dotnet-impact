import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WarmCoverage } from "../core/coverageSession";
import { cacheDirFor } from "../core/util";
import { dotnetOrNull } from "./deltas-helper";

/**
 * Warm coverage pipeline (#3) end to end: real build, real instrumented
 * copies, real warm testhosts, real dotnet-coverage session + snapshots.
 *
 * The contract under test is what live map refresh depends on:
 *   1. per-class attribution — a class's collection lists the files ITS
 *      tests execute, not its neighbor's (snapshot --reset isolation);
 *   2. rebuild freshness — after outputs are rebuilt, collection reflects
 *      the NEW code (the instrumented mirror re-copies, the warm host that
 *      held the old copy is released first).
 *
 * Requires the dotnet-coverage tool (auto-installed on first use); when the
 * pipeline can't come up (no network for the tool install), the module's
 * contract is to return null — asserted as a soft skip so offline machines
 * don't fail, while CI (with network) exercises the whole path.
 */

const LIB_A = `namespace Lib;

public static class Alpha
{
    public static int Twice(int v)
    {
        return v * 2;
    }
}
`;

const LIB_B = `namespace Lib;

public static class Beta
{
    public static int Thrice(int v)
    {
        return v * 3;
    }
}
`;

const TESTS = `using Xunit;

namespace Lib.Tests;

public class AlphaTests
{
    [Fact] public void Doubles() => Assert.Equal(4, Lib.Alpha.Twice(2));
}

public class BetaTests
{
    [Fact] public void Triples() => Assert.Equal(6, Lib.Beta.Thrice(2));
}
`;

test("warm coverage: per-class attribution, and freshness across a rebuild", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-warmcov-"));
  fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Lib.Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Lib", "Lib.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
  );
  fs.writeFileSync(path.join(root, "src", "Lib", "LibA.cs"), LIB_A);
  fs.writeFileSync(path.join(root, "src", "Lib", "LibB.cs"), LIB_B);
  fs.writeFileSync(
    path.join(root, "tests", "Lib.Tests", "Lib.Tests.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <ProjectReference Include="../../src/Lib/Lib.csproj" />
  </ItemGroup>
</Project>`
  );
  fs.writeFileSync(path.join(root, "tests", "Lib.Tests", "Tests.cs"), TESTS);

  const build = () =>
    execFileSync(dotnet, ["build", path.join(root, "tests", "Lib.Tests", "Lib.Tests.csproj"), "--nologo", "-v", "quiet"], {
      cwd: root,
      stdio: "pipe",
      timeout: 300_000,
      env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
    });
  build();
  const testDll = path.join(root, "tests", "Lib.Tests", "bin", "Debug", "net10.0", "Lib.Tests.dll");
  assert.ok(fs.existsSync(testDll), "scaffold build produced Lib.Tests.dll");

  const warm = new WarmCoverage(root, path.join(__dirname, "..", "..", "helper"), (m) => console.log(`   [log] ${m}`));
  const firstParty = ["Lib", "Lib.Tests"];
  try {
    const alpha = await warm.collectClass(root, firstParty, [testDll], "Lib.Tests.AlphaTests");
    if (alpha === null) {
      // Pipeline unavailable (typically: no network for the one-time tool
      // install). The contract IS the null fallback; nothing more to assert.
      console.log("   [skip] warm pipeline unavailable on this machine — fallback contract returned null");
      return;
    }
    assert.equal(alpha.passed, true, `alpha run must pass: ${alpha.output.slice(0, 300)}`);
    assert.ok(
      alpha.files.some((f) => f.endsWith("LibA.cs")),
      `AlphaTests must cover LibA.cs, got: ${alpha.files.join(", ")}`
    );
    assert.ok(
      !alpha.files.some((f) => f.endsWith("LibB.cs")),
      `AlphaTests must NOT cover LibB.cs (snapshot isolation), got: ${alpha.files.join(", ")}`
    );

    const beta = await warm.collectClass(root, firstParty, [testDll], "Lib.Tests.BetaTests");
    assert.notEqual(beta, null, "second class must reuse the warm pipeline");
    assert.ok(beta!.files.some((f) => f.endsWith("LibB.cs")), `BetaTests must cover LibB.cs, got: ${beta!.files.join(", ")}`);
    assert.ok(
      !beta!.files.some((f) => f.endsWith("LibA.cs")),
      `BetaTests must NOT cover LibA.cs (reset isolation), got: ${beta!.files.join(", ")}`
    );

    // Rebuild freshness: move Beta's implementation into LibA.cs (call
    // through), rebuild, and collect again — the instrumented mirror must be
    // refreshed (stale stamp), the old warm host released, and the coverage
    // now reflect the NEW code shape by pulling LibA.cs into Beta's set.
    fs.writeFileSync(path.join(root, "src", "Lib", "LibA.cs"), LIB_A.replace(
      "    public static int Twice(int v)",
      "    public static int ThriceViaAlpha(int v) => Lib.Beta.Thrice(v);\n\n    public static int Twice(int v)"
    ));
    fs.writeFileSync(path.join(root, "tests", "Lib.Tests", "Tests.cs"), TESTS.replace(
      "Assert.Equal(6, Lib.Beta.Thrice(2));",
      "Assert.Equal(6, Lib.Alpha.ThriceViaAlpha(2));"
    ));
    build();
    const beta2 = await warm.collectClass(root, firstParty, [testDll], "Lib.Tests.BetaTests");
    assert.notEqual(beta2, null, "collection after a rebuild must succeed (fresh instrumented mirror)");
    assert.ok(
      beta2!.files.some((f) => f.endsWith("LibA.cs")),
      `after the rebuild BetaTests routes through LibA.cs — stale mirror would miss it; got: ${beta2!.files.join(", ")}`
    );
  } finally {
    warm.dispose();
    await new Promise((r) => setTimeout(r, 1500)); // let hosts/session wind down
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
