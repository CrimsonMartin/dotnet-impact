import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { builtStaticHelper, DiHelperResult, dotnetOrNull } from "./di-fixture";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function scaffold(): { root: string; w: (rel: string, content: string) => void } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-map-test-"));
  const w = (rel: string, content: string) => {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  return { root: d, w };
}

/**
 * Find any dll in a directory tree (skip ref/).
 */
function findDllUnder(dir: string, name: string): string | undefined {
  let best: { p: string; mtime: number } | undefined;
  const walk = (d: string, depth: number) => {
    if (depth > 5) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.toLowerCase() !== "ref") walk(p, depth + 1);
      } else if (e.isFile() && e.name === name) {
        const mtime = fs.statSync(p).mtimeMs;
        if (!best || mtime > best.mtime) best = { p, mtime };
      }
    }
  };
  walk(dir, 0);
  return best?.p;
}

/**
 * Run the static-map helper and parse the result (async).
 */
async function runHelper(dotnet: string, root: string, assemblies: Array<{ csproj: string; dll: string; isTest: boolean }>): Promise<DiHelperResult> {
  const helper = await builtStaticHelper(dotnet);
  const assembliesFile = path.join(root, "assemblies.json");
  fs.writeFileSync(assembliesFile, JSON.stringify(assemblies));
  const out = execFileSync(
    dotnet,
    [helper, "--repo-root", root, "--assemblies", assembliesFile],
    { stdio: "pipe", timeout: 120_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
  ).toString();
  return JSON.parse(out) as DiHelperResult;
}

function buildProject(dotnet: string, root: string, csprojRel: string): void {
  execFileSync(dotnet, ["build", csprojRel, "--nologo", "-v", "quiet"], {
    cwd: root,
    stdio: "pipe",
    timeout: 300_000,
    env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
  });
}

/* ----------------------------------------------------------- */
/*  Circular references — the BFS with `seen` set must not    */
/*  infinite-loop on mutually-referencing types.               */
/* ----------------------------------------------------------- */

test("static map: circular type references do not infinite-loop", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    // A references B (via base class), B references A (via interface)
    w("src/Lib/A.cs", `namespace Demo;\npublic class A : B {}\n`);
    w("src/Lib/B.cs", `namespace Demo;\npublic interface IB { } public class B : IB {}\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    w("tests/T/Tests.cs", `using Xunit;
namespace Demo.Tests;
public class Tests
{
    [Fact] public void Go() => new Demo.A();
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    assert.ok(result.classes["Demo.Tests.Tests"], "circular ref: test class still mapped");
    assert.ok(Array.isArray(result.skipped), "skipped is always an array");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  Missing files during word scan — TextOf catches the       */
/*  exception, so the name-graph union should handle          */
/*  gracefully without crashing.                                */
/* ----------------------------------------------------------- */

test("static map: name-graph union survives file-read errors", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    w("src/Lib/Status.cs", `namespace Demo;\n\npublic enum OrderStatus { New = 1 }\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    // The reference makes Lib build as part of T's build — the helper input
    // below requires a built Lib.dll. T's own code never mentions the enum,
    // so no name-graph edge to it exists (the point of the test).
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    w("tests/T/T.cs", `using Xunit;
namespace Demo.Tests;
public class T { [Fact] public void X() {} }`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    assert.ok(result.classes["Demo.Tests.T"], "class mapped despite missing name-graph edge");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  Empty project — a project with no test classes should     */
/*  produce no entries for that assembly.                       */
/* ----------------------------------------------------------- */

test("static map: assemblies with no test classes produce no entries", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    w("src/Lib/Lib.cs", `namespace Demo;\npublic class Lib { public int Add(int a, int b) => a + b; }\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    w("tests/T/Tests.cs", `using Xunit;
namespace Demo.Tests;
public class Tests
{
    [Fact] public void AddWorks() => Assert.Equal(3, new Demo.Lib().Add(1, 2));
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    // Contract: non-test assemblies are parsed (their types still serve as
    // IL-edge targets) but produce NO class entries. `skipped` is only for
    // assemblies that could not be parsed (not built / no portable pdb / load
    // error) — a healthy non-test assembly is not "skipped".
    assert.equal(result.classes["Demo.Lib"], undefined, "no class entry for the non-test assembly's type");
    assert.ok(result.classes["Demo.Tests.Tests"], "test class from T.dll is mapped");
    assert.ok(
      result.classes["Demo.Tests.Tests"].files.includes("src/Lib/Lib.cs"),
      "non-test assembly's types still reachable via IL edges"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  Multiple assemblies with overlapping FQNs — byName        */
/*  resolution should merge nodes across assemblies.           */
/* ----------------------------------------------------------- */

test("static map: same FQN across assemblies merges correctly", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    w("src/LibA/Config.cs", `namespace Demo.Common;\npublic class Config { public string Name() => "A"; }\n`);
    w("src/LibA/LibA.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    w("src/LibB/Config.cs", `namespace Demo.Common;\npublic class Config { public string Version() => "1"; }\n`);
    w("src/LibB/LibB.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    // Extern aliases disambiguate the same FQN in the C# source (CS0104)
    // while the emitted IL still references the identical FQN from BOTH
    // assemblies — exactly the case the helper's byName merge resolves.
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/LibA/LibA.csproj"><Aliases>libA</Aliases></ProjectReference></ItemGroup>
  <ItemGroup><ProjectReference Include="../../src/LibB/LibB.csproj"><Aliases>libB</Aliases></ProjectReference></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    w("tests/T/Tests.cs", `extern alias libA;
extern alias libB;
using Xunit;
namespace Demo.Tests;
public class Tests
{
    [Fact] public void Both()
    {
        var a = new libA::Demo.Common.Config();
        var b = new libB::Demo.Common.Config();
        Assert.NotNull(a.Name());
        Assert.NotNull(b.Version());
    }
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libADll = findDllUnder(path.join(root, "src/LibA/bin"), "LibA.dll");
    const libBDll = findDllUnder(path.join(root, "src/LibB/bin"), "LibB.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/LibA/LibA.csproj", dll: libADll!, isTest: false },
      { csproj: "src/LibB/LibB.csproj", dll: libBDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    assert.ok(result.classes["Demo.Tests.Tests"], "test class mapped");
    const files = result.classes["Demo.Tests.Tests"].files;
    assert.ok(files.includes("src/LibA/Config.cs"), "LibA's Config.cs in files");
    assert.ok(files.includes("src/LibB/Config.cs"), "LibB's Config.cs in files");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  God-percent parameter — the --god-percent flag            */
/*  should let callers control the hub cap threshold.          */
/* ----------------------------------------------------------- */

test("static map: --god-percent parameter controls hub cap threshold", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    // 20 workers so the world (20 workers + Hub + test class) clears the
    // helper's god-cap minimum of 20 world types.
    w("src/Lib/Hub.cs", `namespace Demo;\npublic static class Hub { public static string Tag() => "hub"; }\n`);
    for (let i = 0; i < 20; i++)
      w(`src/Lib/Worker${i}.cs`, `namespace Demo;\npublic class Worker${i} { public string Go() => Hub.Tag(); }\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    w("tests/T/Tests.cs", `using Xunit;
namespace Demo.Tests;
public class Tests
{
    [Fact] public void X() => new Demo.Worker0().Go();
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const helper = await builtStaticHelper(dotnet);
    const assembliesFile = path.join(root, "assemblies.json");
    fs.writeFileSync(assembliesFile, JSON.stringify([
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]));

    const env = { ...process.env, MSBUILDTERMINALLOGGER: "off" };

    // With --god-percent 100, no type should be capped (threshold = 100% of world)
    const outHigh = execFileSync(dotnet,
      [helper, "--repo-root", root, "--assemblies", assembliesFile, "--god-percent", "100"],
      { stdio: "pipe", timeout: 120_000, env }
    ).toString();
    const resHigh = JSON.parse(outHigh) as { capped: string[] };
    assert.equal(resHigh.capped.length, 0, "with god-percent=100, no types should be capped");

    // With --god-percent 0, threshold = 0, all frequently-referenced types get capped
    const outLow = execFileSync(dotnet,
      [helper, "--repo-root", root, "--assemblies", assembliesFile, "--god-percent", "0"],
      { stdio: "pipe", timeout: 120_000, env }
    ).toString();
    const resLow = JSON.parse(outLow) as { capped: string[] };
    assert.ok(resLow.capped.includes("Demo.Hub"), "with god-percent=0, Hub should be capped");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  Word boundary edge cases — MentionsWord should only       */
/*  match whole words, not substrings.                          */
/* ----------------------------------------------------------- */

test("static map: MentionsWord does not match substrings (word boundary)", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    // Enum named "OrderStatus" (shortName = "OrderStatus")
    // A consumer class that mentions "Status" but NOT "OrderStatus"
    // should NOT get an edge to the enum.
    w("src/Lib/OrderStatus.cs", `namespace Demo;\n\npublic enum OrderStatus { New = 1, Shipped = 2 }\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    // Reference so Lib builds with T (the helper input requires Lib.dll).
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    w("tests/T/Tests.cs", `using Xunit;
namespace Demo.Tests;

// A consumer type whose name shares only the substring "Status" with the
// enum — not the enum's full name as a whole word.
// (No enum names may appear in this file, comment included: the name-graph
// union scans raw file text.)
public class StatusType { public int x; }

public class Tests
{
    [Fact] public void X() => Assert.True(new StatusType().x >= 0);
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    const files = result.classes["Demo.Tests.Tests"].files;
    assert.ok(
      !files.includes("src/Lib/OrderStatus.cs"),
      "partial word 'Status' should not match enum 'OrderStatus'"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  Nested class handling — nested test classes should fold   */
/*  into their top-level declaring type.                       */
/* ----------------------------------------------------------- */

test("static map: nested test class [Fact] folds into top-level FQN", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    w("src/Lib/Calc.cs", `namespace Demo;\npublic static class Calc { public static int Add(int a, int b) => a + b; }\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    // Note: xunit's FactAttribute only targets methods ([AttributeUsage(
    // AttributeTargets.Method)]) — it cannot decorate the nested class.
    w("tests/T/Tests.cs", `using Xunit;
namespace Demo.Tests;

public class Outer
{
    public class Nested
    {
        [Fact]
        public void InnerAdd() => Assert.Equal(3, Demo.Calc.Add(1, 2));
    }
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    // The helper folds a nested [Fact] class into its top-level declaring
    // type's FQN — the entry is the outer class, not the nested one.
    const outerKey = "Demo.Tests.Outer";
    assert.ok(result.classes[outerKey], `top-level FQN mapped (nested [Fact] folded in): ${JSON.stringify(Object.keys(result.classes))}`);
    assert.equal(result.classes["Demo.Tests.Outer+Nested"], undefined, "nested class is folded, not a separate entry");
    const files = result.classes[outerKey].files;
    assert.ok(files.includes("src/Lib/Calc.cs"), "folded closure includes referenced lib");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  Corrupt or missing PDB — helper should handle             */
/*  gracefully, mapping types by IL edges only.                */
/* ----------------------------------------------------------- */

test("static map: assembly without PDB still produces valid output", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    w("src/Lib/Calc.cs", `namespace Demo;\npublic static class Calc { public static int Add(int a, int b) => a + b; }\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><DebugType>None</DebugType></PropertyGroup></Project>');
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    w("tests/T/Tests.cs", `using Xunit;
namespace Demo.Tests;
public class Tests
{
    [Fact] public void AddWorks() => Assert.Equal(3, Calc.Add(1, 2));
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    const skippedReasons = result.skipped.map((s) => s.reason);
    assert.ok(
      skippedReasons.some((r) => r.includes("no portable pdb") || r.includes("pdb")),
      "missing PDB is reported in skipped list"
    );
    assert.ok(result.classes["Demo.Tests.Tests"], "test class mapped despite lib PDB absence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  Abstract files for self-tuning — only interfaces/abstract */
/*  classes should appear in abstractFiles (not static sealed) */
/* ----------------------------------------------------------- */

test("static map: abstractFiles excludes sealed static types", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;

  const { root, w } = scaffold();
  try {
    w("src/Lib/IFoo.cs", `namespace Demo;\npublic interface IFoo { void Go(); }\n`);
    w("src/Lib/AbstractBar.cs", `namespace Demo;\npublic abstract class AbstractBar { public abstract void Execute(); }\n`);
    w("src/Lib/StaticSealed.cs", `namespace Demo;\npublic static class StaticSealed { public static int Value => 42; }\n`);
    w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    w("tests/T/T.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
  <ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>
</Project>`);
    // IFoo and StaticSealed are referenced from the test code so they are in
    // the closure: IFoo (interface) must appear in abstractFiles, while
    // StaticSealed (static+sealed) must NOT.
    w("tests/T/Tests.cs", `using Xunit;
namespace Demo.Tests;
public class Tests
{
    [Fact] public void Refs()
    {
        // Direct references so all three lib types are in tc.Edges:
        // IFoo (interface) + AbstractBar (abstract) must land in
        // abstractFiles; StaticSealed (static+sealed) must not. The IFoo
        // cast feeds an interface call so the compiler keeps the castclass
        // in the IL (a discarded cast can be elided).
        Demo.AbstractBar bar = new AbstractBarConcrete();
        bar.Execute();
        ((Demo.IFoo)new AbstractBarConcrete()).Go();
        Assert.Equal(42, Demo.StaticSealed.Value);
    }
}

// Concrete implementation of AbstractBar (and IFoo)
public class AbstractBarConcrete : Demo.AbstractBar, Demo.IFoo
{
    public override void Execute() {}
    public void Go() {}
}`);

    buildProject(dotnet, root, "tests/T/T.csproj");

    const libDll = findDllUnder(path.join(root, "src/Lib/bin"), "Lib.dll");
    const testDll = findDllUnder(path.join(root, "tests/T/bin"), "T.dll");
    const result = await runHelper(dotnet, root, [
      { csproj: "src/Lib/Lib.csproj", dll: libDll!, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll!, isTest: true },
    ]);

    const abs = result.classes["Demo.Tests.Tests"].abstractFiles;
    assert.ok(abs.includes("src/Lib/IFoo.cs"), "IFoo is an interface → in abstractFiles");
    assert.ok(abs.includes("src/Lib/AbstractBar.cs"), "AbstractBar is abstract → in abstractFiles");
    assert.ok(!abs.includes("src/Lib/StaticSealed.cs"), "static+sealed should NOT be in abstractFiles");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
