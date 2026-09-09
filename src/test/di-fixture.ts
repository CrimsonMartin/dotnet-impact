import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveDotnet } from "../core/util";

/** Shared DI-shaped fixture for the self-tuning map tests (#31).
 *
 * (Not a test file itself — the runner's glob only picks up *.test.js, so
 * utilities exported here are importable without double-registering tests.) */

/**
 * Shared DI-shaped fixture for the self-tuning map tests (#31).
 *
 * The repo models the blind spot the static IL map cannot see:
 *   - `IService` (interface) and `ServiceImpl` (implementation) are in the
 *     library;
 *   - `Container` mimics a DI container's API and resolves implementations
 *     via `Activator.CreateInstance(Type)` at RUNTIME;
 *   - the composition root (`App.Register`) registers `IService ⇒ ServiceImpl`
 *     CONVENTION-BASED: it scans the assembly with reflection and binds every
 *     `*Impl` type that implements `IService` — the implementation is never
 *     named in any IL token, exactly like the convention-based/attribute-
 *     scanning registrations (AutoMapper, Scrutor, …) that no static analysis
 *     can see;
 *   - test classes A and B both resolve `IService` through the container.
 *
 * Toolchain note: the edge is deliberately reflection-based rather than a
 * typed `AddScoped<IService, ServiceImpl>()` call. Modern Roslyn (SDK 10)
 * emits MethodSpec rows with the full generic instantiation even for
 * CROSS-assembly generic calls, and the static-map helper's RefCollector
 * decodes them — so a typed registration is visible to the static map on
 * recent toolchains (older ones didn't emit the MethodSpec; the map must
 * work on both). Reflection-by-name is invisible on every toolchain, which
 * is what keeps the fixture's premise stable.
 *
 * `withTypedRegistration` (parser-seed tests) adds a CompositionRoot with a
 * classic two-generic `AddScoped<IService, ServiceImpl>()` call: the
 * registration parser reads it from source text (no build required), and no
 * test class references CompositionRoot, so the typed edge stays out of the
 * test classes' closures regardless of toolchain.
 */

export const DI_FILES: Record<string, string> = {
  "src/Lib/Lib.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
  "src/Lib/IService.cs": `namespace Demo;

public interface IService
{
    string Do();
}
`,
  // NOTE: keep ServiceImpl.cs free of any type that other implementations
  // call (a shared helper here would be covered by every impl's run and the
  // "impl file" would never leave a measurement's file set).
  "src/Lib/ServiceImpl.cs": `namespace Demo;

public class ServiceImpl : IService
{
    public string Do() => "impl";
}
`,
  "src/Lib/ServiceOther.cs": `namespace Demo;

/// Alternate implementation of IService. The contradiction tests flip
/// App.Register's convention to this type, so the learned ServiceImpl edge
/// starts getting contradicted (and a fresh ServiceOther edge confirmed).
public class ServiceOther : IService
{
    public string Do() => "other";
}
`,
  "src/FakeDi/FakeDi.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
  "src/FakeDi/Container.cs": `namespace Demo.FakeDi;

public static class Container
{
    private static readonly System.Collections.Generic.Dictionary<Type, Type> Registrations = new();

    public static void Add(Type service, Type impl) => Registrations[service] = impl;

    /// Typed registration idiom (Microsoft DI shape). Used only by the
    /// parser-seed fixture's CompositionRoot; the runtime tests resolve via
    /// the convention-based path above.
    public static void AddScoped<TService, TImpl>()
        where TService : class
        where TImpl : class, TService
        => Add(typeof(TService), typeof(TImpl));

    public static object Get(Type service) => Activator.CreateInstance(Registrations[service])!;
}
`,
  "tests/T/T.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../../src/Lib/Lib.csproj" />
    <ProjectReference Include="../../src/FakeDi/FakeDi.csproj" />
  </ItemGroup>
</Project>`,
  "tests/T/App.cs": `namespace Demo;

public static class App
{
    /// Convention-based registration: bind every *Impl type that implements
    /// IService. The implementation is discovered at runtime by reflection —
    /// no IL token ever names it.
    public static void Register()
    {
        foreach (var t in typeof(IService).Assembly.GetTypes())
        {
            if (!t.IsInterface && t.Name.EndsWith("Impl") && typeof(IService).IsAssignableFrom(t))
                Demo.FakeDi.Container.Add(typeof(IService), t);
        }
    }
}
`,
  "tests/T/ATests.cs": `using Xunit;
namespace Demo.Tests;

public class ATests
{
    [Fact]
    public void Resolves_and_runs()
    {
        App.Register();
        IService svc = (IService)Demo.FakeDi.Container.Get(typeof(IService));
        Assert.False(string.IsNullOrEmpty(svc.Do()));
    }
}
`,
  "tests/T/BTests.cs": `using Xunit;
namespace Demo.Tests;

public class BTests
{
    [Fact]
    public void Resolves_too()
    {
        App.Register();
        IService svc = (IService)Demo.FakeDi.Container.Get(typeof(IService));
        Assert.False(string.IsNullOrEmpty(svc.Do()));
    }
}
`,
};

/**
 * The registration-parser seed variant (#31 step 3): a composition root with
 * the classic two-generic typed registration, present in SOURCE only (no test
 * class calls it, so its MethodSpec-visible edge never reaches a test class).
 */
export const TYPED_REGISTRATION_FILE = {
  rel: "tests/T/CompositionRoot.cs",
  content: `namespace Demo;

public static class CompositionRoot
{
    public static void RegisterTyped()
        => Demo.FakeDi.Container.AddScoped<IService, ServiceImpl>();
}
`,
};

/** Write the fixture as a committed git repo; returns the repo root. */
export function scaffoldDiRepo(opts: { withTypedRegistration?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-di-fixture-"));
  const files: Record<string, string> = { ...DI_FILES };
  if (opts.withTypedRegistration) files[TYPED_REGISTRATION_FILE.rel] = TYPED_REGISTRATION_FILE.content;
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "pipe",
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
  git("commit", "-qm", "di fixture");
  return root;
}

export function dotnetOrNull(): string | null {
  try {
    const dotnet = resolveDotnet();
    execFileSync(dotnet, ["--version"], { stdio: "pipe", timeout: 30_000 });
    return dotnet;
  } catch {
    return null;
  }
}

const HELPER_SRC = path.join(__dirname, "../../helper-static");

/**
 * Build the static-map helper into a shared tmp cache (rebuilt only when the
 * source changes). Several #31 test files run the same helper; the stamp
 * makes the second one free, and a build lock keeps parallel test processes
 * from racing on the output dir.
 */
export async function builtStaticHelper(dotnet: string): Promise<string> {
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
  const fresh = (): boolean => {
    try {
      return fs.existsSync(dll) && fs.readFileSync(stampFile, "utf8") === want;
    } catch {
      return false;
    }
  };
  if (fresh()) return dll;

  // node --test runs files in parallel processes sharing this cache: a mkdir
  // lock serializes the build; the loser re-checks the stamp and reuses it
  // (same pattern as deltas-helper.ts).
  const lock = bin + ".build-lock";
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      fs.mkdirSync(lock, { recursive: false });
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60_000) {
          fs.rmdirSync(lock);
          continue; // stale lock from a crashed builder: steal it
        }
      } catch {
        continue; // lock vanished between mkdir and stat: retry immediately
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the static-map helper build lock");
      await sleep(500);
    }
  }
  try {
    if (fresh()) return dll; // the other process built it while we waited
    execFileSync(
      dotnet,
      ["build", path.join(HELPER_SRC, "ImpactStaticMap.csproj"), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
      { stdio: "pipe", timeout: 300_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
    );
    fs.writeFileSync(stampFile, want);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  return dll;
}

export interface DiHelperResult {
  classes: Record<string, { csproj: string; files: string[]; abstractFiles: string[] }>;
  types: Record<string, string[]>;
  skipped: Array<{ assembly: string; reason: string }>;
}

/** Build the DI fixture repo and run the static-map helper over it. */
export async function runStaticHelperOnDiRepo(dotnet: string, root: string): Promise<DiHelperResult> {
  const env = { ...process.env, MSBUILDTERMINALLOGGER: "off" };
  execFileSync(dotnet, ["build", "tests/T/T.csproj", "--nologo", "-v", "quiet"], {
    cwd: root,
    stdio: "pipe",
    timeout: 300_000,
    env,
  });
  const helper = await builtStaticHelper(dotnet);
  const libDll = findBuiltDllUnder(path.join(root, "src", "Lib", "bin"), "Lib.dll");
  const fakeDiDll = findBuiltDllUnder(path.join(root, "src", "FakeDi", "bin"), "FakeDi.dll");
  const testDll = findBuiltDllUnder(path.join(root, "tests", "T", "bin"), "T.dll");
  if (!libDll || !fakeDiDll || !testDll) throw new Error("fixture did not build all assemblies");
  const assemblies = path.join(root, "assemblies.json");
  fs.writeFileSync(
    assemblies,
    JSON.stringify([
      { csproj: "src/Lib/Lib.csproj", dll: libDll, isTest: false },
      { csproj: "src/FakeDi/FakeDi.csproj", dll: fakeDiDll, isTest: false },
      { csproj: "tests/T/T.csproj", dll: testDll, isTest: true },
    ])
  );
  const out = execFileSync(
    dotnet,
    [helper, "--repo-root", root, "--assemblies", assemblies],
    { stdio: "pipe", timeout: 120_000, env }
  ).toString();
  return JSON.parse(out) as DiHelperResult;
}

/** Find the newest built copy of a dll under a bin dir (skips ref/). */
export function findBuiltDllUnder(binDir: string, dllName: string): string | undefined {
  let best: { p: string; mtime: number } | undefined;
  const walk = (d: string, depth: number) => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.toLowerCase() !== "ref") walk(p, depth + 1);
      } else if (e.name.toLowerCase() === dllName.toLowerCase()) {
        let mtime: number;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          continue;
        }
        if (!best || mtime > best.mtime) best = { p, mtime };
      }
    }
  };
  walk(binDir, 0);
  return best?.p;
}
