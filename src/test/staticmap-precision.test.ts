import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveDotnet } from "../core/util";

/**
 * Issue #2 regressions for the static map's precision improvements:
 *
 * - Name-graph union: enum and const-holder types are invisible in consumer
 *   IL (their values inline), and having no method bodies they also carry no
 *   sequence points — their files come from the portable PDB's
 *   TypeDefinitionDocuments record, and consumers that mention their name in
 *   source get the edge.
 * - God-type cap: a hub type referenced by most of the world keeps its OWN
 *   files in closures but stops transitive fan-out, so hub dependencies stop
 *   inflating every test class's file set.
 */

const HELPER_SRC = path.join(__dirname, "../../helper-static");

function dotnetOrNull(): string | null {
  try {
    const dotnet = resolveDotnet();
    execFileSync(dotnet, ["--version"], { stdio: "pipe", timeout: 30_000 });
    return dotnet;
  } catch {
    return null;
  }
}

function builtHelper(dotnet: string): string {
  const bin = path.join(os.tmpdir(), "impact-staticmap-test-bin");
  const dll = path.join(bin, "ImpactStaticMap.dll");
  const stampFile = path.join(bin, ".source-stamp");
  const src = fs
    .readdirSync(HELPER_SRC)
    .filter((f) => f.endsWith(".cs") || f.endsWith(".csproj"))
    .sort()
    .map((f) => fs.readFileSync(path.join(HELPER_SRC, f), "utf8"))
    .join("\n");
  const want = crypto.createHash("sha1").update(src).digest("hex");
  try {
    if (fs.existsSync(dll) && fs.readFileSync(stampFile, "utf8") === want) return dll;
  } catch {
    /* rebuild */
  }
  execFileSync(
    dotnet,
    ["build", path.join(HELPER_SRC, "ImpactStaticMap.csproj"), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
    { stdio: "pipe", timeout: 300_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
  );
  fs.writeFileSync(stampFile, want);
  return dll;
}

function scaffold(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-map-test-"));
  const w = (rel: string, content: string) => {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  w("src/Lib/OrderStatus.cs", "namespace Demo;\n\npublic enum OrderStatus { New = 1, Shipped = 2 }\n");
  w("src/Lib/Limits.cs", "namespace Demo;\n\npublic static class Limits\n{\n    public const int MaxRetries = 5;\n}\n");
  w("src/Lib/Hub.cs", 'namespace Demo;\n\npublic static class Hub\n{\n    public static string Tag() => Leaf.Name();\n}\n');
  w("src/Lib/Leaf.cs", 'namespace Demo;\n\npublic static class Leaf\n{\n    public static string Name() => "leaf";\n}\n');
  for (let i = 0; i < 24; i++)
    w(`src/Lib/Worker${i}.cs`, `namespace Demo;\n\npublic class Worker${i}\n{\n    public string Go() => Hub.Tag();\n}\n`);
  w("src/Lib/Plain.cs", "namespace Demo;\n\npublic static class Plain\n{\n    public static int Two() => 2;\n}\n");
  w("src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  w(
    "tests/T/T.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="xunit" Version="2.9.0" />
  </ItemGroup>
  <ItemGroup><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup>
</Project>`
  );
  w(
    "tests/T/InlineTests.cs",
    `using Xunit;
namespace Demo.Tests;

public class InlineTests
{
    [Fact]
    public void Status_is_inlined() => Assert.Equal(2, (int)OrderStatus.Shipped);

    [Fact]
    public void Retries_are_inlined() => Assert.Equal(5, Limits.MaxRetries);
}
`
  );
  w(
    "tests/T/PlainTests.cs",
    `using Xunit;
namespace Demo.Tests;

public class PlainTests
{
    [Fact]
    public void Plain_only() => Assert.Equal(2, Plain.Two());
}
`
  );
  return d;
}

test("static map: name union for enum/const files, god-type cap", { timeout: 600_000 }, () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK: nothing to test against
  const helper = builtHelper(dotnet);
  const d = scaffold();
  try {
    const env = { ...process.env, MSBUILDTERMINALLOGGER: "off" };
    execFileSync(dotnet, ["build", "tests/T/T.csproj", "--nologo", "-v", "quiet"], {
      cwd: d,
      stdio: "pipe",
      timeout: 300_000,
      env,
    });
    const find = (dir: string, name: string): string => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== "ref") {
          const r = find(p, name);
          if (r) return r;
        } else if (e.name === name) return p;
      }
      return "";
    };
    const libDll = find(path.join(d, "src/Lib/bin"), "Lib.dll");
    const testDll = find(path.join(d, "tests/T/bin"), "T.dll");
    const assemblies = path.join(d, "assemblies.json");
    fs.writeFileSync(
      assemblies,
      JSON.stringify([
        { csproj: "src/Lib/Lib.csproj", dll: libDll, isTest: false },
        { csproj: "tests/T/T.csproj", dll: testDll, isTest: true },
      ])
    );
    const out = execFileSync(
      dotnet,
      [helper, "--repo-root", d, "--assemblies", assemblies],
      { stdio: "pipe", timeout: 120_000, env }
    ).toString();
    const result = JSON.parse(out) as {
      classes: Record<string, { files: string[] }>;
      capped: string[];
    };
    const files = (cls: string) => result.classes[`Demo.Tests.${cls}`].files;

    // Name-graph union: inlined enum/const values still map their files.
    assert.ok(files("InlineTests").includes("src/Lib/OrderStatus.cs"), "enum file via name union");
    assert.ok(files("InlineTests").includes("src/Lib/Limits.cs"), "const file via name union");
    // ...and only for classes whose source mentions them.
    assert.ok(!files("PlainTests").includes("src/Lib/OrderStatus.cs"), "no enum pollution");
    assert.ok(!files("PlainTests").includes("src/Lib/Limits.cs"), "no const pollution");

    // God cap: Hub (referenced by 24 workers) stops fan-out but keeps itself.
    assert.ok(result.capped.includes("Demo.Hub"), `Hub capped (got ${JSON.stringify(result.capped)})`);
    assert.ok(!files("PlainTests").includes("src/Lib/Leaf.cs"), "hub fan-out trimmed");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
