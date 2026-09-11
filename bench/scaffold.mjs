// Large-repo fixture scaffolder for the Impact performance bench.
//
// Design goal: SIMPLE code, COMPLEX impact. Every method is a one-liner, but
// the type-reference graph is deliberately multi-layered so the static map,
// affected-set queries, and coverage closures are stressed like a real large
// .NET repo:
//
//   * deep chains        Work() call chains up to domains*perDomain deep
//   * diamond hubs       high fan-in "god" types that hit the map's
//                        god-percent expansion cap
//   * layered DAG        project graph is a DAG (MSBuild forbids project
//                        cycles): Domain d references Core + domains below it
//   * in-project cycles  the D_i ring inside each domain calls Measure()
//                        statics both directions — a cyclic TYPE graph inside
//                        a single assembly (legal, runtime-safe)
//   * interface fan-out  many classes implement each interface; consumers
//                        program to the interface
//   * inlined enums      enum constants used across scattered files — the
//                        compiler inlines them (no TypeRef), so only the
//                        name-graph union can see the edge
//   * generics           Box<T>/Pair<T,U> instantiations -> MethodSpec edges
//   * reflection DI      Services binds *Svc impls by convention (Activator)
//                        — invisible to any static analysis
//   * hot-edit target    Core.Support.Do: one literal every test class calls
//
// Runtime safety: the IL reference graph is cyclic (Measure() statics,
// generic args, field types), but every RUNTIME call goes Work -> Work of a
// strictly higher rank (own ring, then next domain, then core, then hub), so
// test execution always terminates. Constructors are parameterless and field-
// free, so reflection instantiation is trivial.
//
// Sizes:
//   small  ~60 classes / 5 projects   (sanity + fast debug loop)
//   large  ~1700 classes / 17 projects (the "large dotnet repo" target)
//
// Usage: node bench/scaffold.mjs <outDir> [small|large]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [, , outDir, size = "large"] = process.argv;
if (!outDir) {
  console.error("usage: node bench/scaffold.mjs <outDir> [small|large]");
  process.exit(2);
}
const S = size === "small"
  ? { core: 30, hubs: 3, ifaces: 4, enums: 4, domains: 2, perDomain: 20, services: 10, testProjects: 1, testsPer: 10 }
  : { core: 300, hubs: 30, ifaces: 30, enums: 40, domains: 6, perDomain: 200, services: 100, testProjects: 3, testsPer: 40 };

fs.rmSync(outDir, { recursive: true, force: true });

const write = (rel, text) => {
  const p = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

const csproj = (refs = []) =>
  `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>disable</Nullable></PropertyGroup>
  ${refs.length ? `<ItemGroup>\n${[...new Set(refs)].map((r) => `    <ProjectReference Include="${r}" />`).join("\n")}\n  </ItemGroup>` : ""}
</Project>`;

const testCsproj = (refs = []) =>
  `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable><ImplicitUsings>enable</ImplicitUsings><Nullable>disable</Nullable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
${refs.map((r) => `    <ProjectReference Include="${r}" />`).join("\n")}
  </ItemGroup>
</Project>`;

// ---------------- Core ----------------
write("src/Core/Core.csproj", csproj());

// Interfaces: consumers program to them; implementers span Core + domains, so
// each interface file sits in hundreds of closures.
for (let i = 0; i < S.ifaces; i++) {
  write(`src/Core/I${i}.cs`, `namespace Core;

public interface I${i}
{
    int Run(int x);
}
`);
}

// Enums: members are inlined as constants by the compiler — consumers' IL has
// NO TypeRef to the enum, so the defining file is reachable only via the
// name-graph union. Each enum is sprinkled across many files.
for (let i = 0; i < S.enums; i++) {
  write(`src/Core/E${i}.cs`, `namespace Core;

public enum E${i}
{
    Alpha = ${i},
    Beta = ${i + 1},
    Gamma = ${i + 2},
    Delta = ${i + 3}
}
`);
}

// Generic containers: instantiations emit MethodSpec rows — a distinct edge
// kind; the type arguments add TypeRefs to two more classes per use site.
write("src/Core/Boxes.cs", `namespace Core;

public class Box<T>
{
    public T Value { get; set; }
    public static int Measure(int x) => x + 1;
}

public class Pair<T, U>
{
    public T A { get; set; }
    public U B { get; set; }
    public static int Measure(int x) => x + 2;
}
`);

// Hub ("god") classes: referenced by a large fraction of all types — these
// dominate fan-in and trip the map's god-percent expansion cap.
for (let i = 0; i < S.hubs; i++) {
  write(`src/Core/H${i}.cs`, `namespace Core;

public class H${i}
{
    public static int Hub(int x) => x + ${i};
}
`);
}

// Regular Core classes: implement one interface; the body calls its hub and
// inlines an enum constant. IL density to other core classes comes from the
// Pair<C_a, C_b> generic instantiation (TypeRefs + MethodSpec) — dense, but
// Measure is a static leaf so the runtime stays a flat star into hubs.
const coreIface = (i) => i % S.ifaces;
for (let i = 0; i < S.core; i++) {
  const a = (i * 3 + 1) % S.core;
  const b = (i * 7 + 2) % S.core;
  const hub = i % S.hubs;
  const e = i % S.enums;
  write(`src/Core/C${i}.cs`, `namespace Core;

public class C${i} : I${coreIface(i)}
{
    public int Run(int x) => Work(x);

    public static int Work(int x) =>
        H${hub}.Hub(x) + Pair<C${a}, C${b}>.Measure(x) + (int)Core.E${e}.Beta + ${i};
}
`);
}

// Hot-edit target: trivial method-body, referenced by EVERY test class — the
// bench rewrites the literal below each cycle, so its file lands in every
// affected set while staying hot-patchable (method-body edit).
write("src/Core/Support.cs", `namespace Core;

public static class Support
{
    /// Hot-edit target: the bench rewrites the literal below each cycle.
    public static int Do(int x)
    {
        int n = x + 1;
        return n;
    }
}
`);

// ---------------- Domains ----------------
// Project graph is a layered DAG (MSBuild forbids project cycles): Domain d
// references Core + every domain below it. The TYPE graph is still cyclic —
// inside each domain the D_i ring calls Measure() statics both directions
// (Measure bodies call nothing, so it's runtime-safe), and the Work() call
// chain walks the own ring, then down one domain at the tail: depth is
// bounded by domains*perDomain and always terminates.
const domainPaths = [];
for (let d = 0; d < S.domains; d++) {
  const refs = ["../../src/Core/Core.csproj"]
    .concat([...Array(d).keys()].map((k) => `../../src/Domain${k}/Domain${k}.csproj`));
  write(`src/Domain${d}/Domain${d}.csproj`, csproj(refs));
  domainPaths.push(`src/Domain${d}`);
  for (let i = 0; i < S.perDomain; i++) {
    // Cross-domain IL edges go DOWN the DAG (d-1, d-2). For d < 2 both
    // collapse onto Domain0 with different peers.
    const dFwd = Math.max(0, d - 1), dBwd = Math.max(0, d - 2);
    const peerF = (i * 3 + 1) % S.perDomain, peerB = (i * 5 + 2) % S.perDomain;
    const coreA = (i * 7 + 1) % S.core, coreB = (i * 13 + 5) % S.core;
    const hub = (i + d) % S.hubs;
    const e = (i + 2 * d) % S.enums;
    const iface = (i + d) % S.ifaces;
    // Own-ring next (runtime); the ring TAIL breaks down one domain (or into
    // core for the bottom domain) — never wraps back (would recurse).
    const selfCall = i + 1 < S.perDomain
      ? `D${d}_${i + 1}.Work(x)`
      : (d > 0
        ? `Domain${d - 1}.D${d - 1}_${peerF}.Work(x)`
        : `Core.C${coreA}.Work(x)`);
    write(`src/Domain${d}/D${d}_${i}.cs`, `namespace Domain${d};

public class D${d}_${i} : Core.I${iface}
{
    public int Run(int x) => Work(x);

    public static int Work(int x) =>
        ${selfCall} + Domain${dFwd}.D${dFwd}_${peerF}.Measure(x) +
        Domain${dBwd}.D${dBwd}_${peerB}.Measure(x + 1) +
        Core.Pair<Core.C${coreA}, Core.C${coreB}>.Measure(x) +
        Core.H${hub}.Hub(x) + (int)Core.E${e}.Gamma + ${i};

    public static int Measure(int x) => x + ${i};
}
`);
  }
}

// ---------------- Services (reflection DI) ----------------
write("src/Services/Services.csproj", csproj(domainPaths.map((dp) => `../../${dp}/${dp.split("/").pop()}.csproj`)));
write("src/Services/Container.cs", `namespace Services;

public static class Container
{
    private static readonly System.Collections.Generic.Dictionary<string, object> Registrations = new();

    /// Convention-based registration: bind every *Svc type that implements
    /// IResolvable. The implementation is discovered at runtime by reflection —
    /// no IL token ever names it (like Scrutor/AutoMapper-style containers).
    public static void Register()
    {
        foreach (var t in typeof(IResolvable).Assembly.GetTypes())
        {
            if (!t.IsInterface && t.Name.EndsWith("Svc") && typeof(IResolvable).IsAssignableFrom(t))
                Registrations[t.Name] = Activator.CreateInstance(t);
        }
    }

    public static IResolvable Get(string name) => (IResolvable)Registrations[name];
}
`);
write("src/Services/IResolvable.cs", `namespace Services;

public interface IResolvable
{
    int Resolve(int x);
}
`);
for (let i = 0; i < S.services; i++) {
  const d = i % S.domains;
  const j = (i * 7 + 3) % S.perDomain;
  const k = (i + 1) % S.domains;
  const l = (i * 3 + 1) % S.perDomain;
  write(`src/Services/S${i}.cs`, `namespace Services;

public class S${i}Svc : IResolvable
{
    public int Resolve(int x) =>
        Domain${d}.D${d}_${j}.Work(x) + Domain${k}.D${k}_${l}.Measure(x + 1) + Core.Support.Do(x);
}
`);
}

// ---------------- Test projects ----------------
// Each test class: direct Work() calls across two domains (deep runtime
// chains), a hub, the hot-edit Support.Do, and one resolve through the
// reflection container (the static-analysis blind spot). A leaf-domain file
// change therefore crosses domain -> core -> interface/enum -> tests.
const slnProjects = ["src/Core/Core.csproj", ...domainPaths.map((dp) => `${dp}/${dp.split("/").pop()}.csproj`), "src/Services/Services.csproj"];
for (let t = 0; t < S.testProjects; t++) {
  const dA = t % S.domains, dB = (t + 1) % S.domains;
  const refs = [
    "../../src/Core/Core.csproj",
    `../../src/Domain${dA}/Domain${dA}.csproj`,
    `../../src/Domain${dB}/Domain${dB}.csproj`,
    "../../src/Services/Services.csproj",
  ];
  write(`tests/T${t}/T${t}.csproj`, testCsproj(refs));
  for (let i = 0; i < S.testsPer; i++) {
    const jA1 = (i * 3) % S.perDomain, jA2 = (i * 7 + 1) % S.perDomain;
    const jB = (i * 5 + 2) % S.perDomain;
    const hub = (t + i) % S.hubs;
    const svc = (t * S.testsPer + i) % S.services;
    write(`tests/T${t}/T${t}_${i}Tests.cs`, `using Xunit;

namespace T${t};

public class T${t}_${i}Tests
{
    [Fact]
    public void Works()
    {
        Services.Container.Register();
        int a = Domain${dA}.D${dA}_${jA1}.Work(1);
        int b = Domain${dA}.D${dA}_${jA2}.Measure(2);
        int c = Domain${dB}.D${dB}_${jB}.Work(3);
        int d = Core.H${hub}.Hub(4);
        int e = Core.Support.Do(5);
        int f = Services.Container.Get("S${svc}Svc").Resolve(6);
        Assert.True(a + b + c + d + e + f > int.MinValue);
    }
}
`);
  }
  slnProjects.push(`tests/T${t}/T${t}.csproj`);
}

// Proper solution file (VS header + Project/EndProject + config sections) —
// MSBuild rejects the headerless minimal form.
const projLines = [];
const cfgLines = [];
for (const p of slnProjects) {
  const name = p.split("/").pop().replace(".csproj", "");
  let h = 0;
  for (const ch of p + "guid") h = (h * 31 + ch.charCodeAt(0)) | 0;
  let g = "";
  for (let i = 0; i < 32; i++) { g += (Math.abs(h) % 16).toString(16); h = (h * 33 + 7) | 0; }
  const guid = g.toUpperCase().replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  projLines.push(`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${name}", "${p}", "{${guid}}"\nEndProject`);
  cfgLines.push(`\t\t${guid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`, `\t\t${guid}.Debug|Any CPU.Build.0 = Debug|Any CPU`);
}
write("Bench.sln", [
  "Microsoft Visual Studio Solution File, Format Version 12.00",
  "# Visual Studio Version 17",
  ...projLines,
  "Global",
  "\tGlobalSection(SolutionConfigurationPlatforms) = preSolution",
  "\t\tDebug|Any CPU = Debug|Any CPU",
  "\tEndGlobalSection",
  "\tGlobalSection(ProjectConfigurationPlatforms) = postSolution",
  ...cfgLines,
  "\tEndGlobalSection",
  "EndGlobal",
  "",
].join("\n"));

for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=bench", "-c", "user.email=bench@bench", "commit", "-qm", "fixture"]]) {
  execFileSync("git", args, { cwd: outDir });
}
console.log(`scaffolded ${size} fixture at ${outDir}`);
