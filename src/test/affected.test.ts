import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildProjectGraph, sourceStamp, transitiveSourceStamp } from "../core/projects";

test("transitiveSourceStamp: dependency edits change the referencing project's stamp", () => {
  const root = scaffoldRepo();
  const graph = buildProjectGraph(root);
  const testCsproj = path.join(root, "tests", "Lib.Tests", "Lib.Tests.csproj");
  const s1 = transitiveSourceStamp(graph, testCsproj);
  assert.ok(s1.length > 0);
  // Touch a file in the REFERENCED project only.
  const dep = path.join(root, "src", "Lib", "Calc.cs");
  fs.utimesSync(dep, new Date(), new Date(Date.now() + 5000));
  const s2 = transitiveSourceStamp(buildProjectGraph(root), testCsproj);
  assert.notEqual(s2, s1);
});
import { Runner } from "../core/runner";

test("sourceStamp: changes on edit and on deletion, skips bin/obj", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impact-stamp-test-"));
  fs.writeFileSync(path.join(dir, "A.cs"), "class A {}");
  fs.writeFileSync(path.join(dir, "B.cs"), "class B {}");
  fs.mkdirSync(path.join(dir, "obj"), { recursive: true });
  fs.writeFileSync(path.join(dir, "obj", "gen.cs"), "");
  const s1 = sourceStamp(dir);
  assert.ok(s1.startsWith("2:")); // obj/gen.cs excluded from the count

  fs.utimesSync(path.join(dir, "A.cs"), new Date(), new Date(Date.now() + 5000));
  const s2 = sourceStamp(dir);
  assert.notEqual(s2, s1);

  fs.rmSync(path.join(dir, "B.cs"));
  const s3 = sourceStamp(dir);
  assert.ok(s3.startsWith("1:"));
  assert.notEqual(s3, s2);
});

/** Scaffold Lib + Lib.Tests (references Lib) in a temp repo root. */
function scaffoldRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-affected-test-"));
  fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Lib.Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Lib", "Lib.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"></Project>`
  );
  fs.writeFileSync(path.join(root, "src", "Lib", "Calc.cs"), "");
  fs.writeFileSync(
    path.join(root, "tests", "Lib.Tests", "Lib.Tests.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" />
    <ProjectReference Include="..\\..\\src\\Lib\\Lib.csproj" />
  </ItemGroup>
</Project>`
  );
  return root;
}

test("mapped .cs file selects its classes, no fallback", () => {
  const root = scaffoldRepo();
  const runner = new Runner(root);
  runner.map.update("Lib.Tests.CalcTests", "tests/Lib.Tests/Lib.Tests.csproj", [
    "src/Lib/Calc.cs",
  ]);
  const a = runner.computeAffected(["src/Lib/Calc.cs"]);
  assert.deepEqual(a.classes, ["Lib.Tests.CalcTests"]);
  assert.equal(a.fallbackProjects.length, 0);
});

test("unmapped .cs file falls back to referencing test projects", () => {
  const root = scaffoldRepo();
  fs.writeFileSync(path.join(root, "src", "Lib", "New.cs"), "");
  const runner = new Runner(root);
  const a = runner.computeAffected(["src/Lib/New.cs"]);
  assert.equal(a.classes.length, 0);
  assert.deepEqual(
    a.fallbackProjects.map((p) => p.name),
    ["Lib.Tests"]
  );
});

test(".csproj edits trigger project-graph fallback (README contract)", () => {
  const root = scaffoldRepo();
  const runner = new Runner(root);
  const a = runner.computeAffected(["src/Lib/Lib.csproj"]);
  assert.deepEqual(
    a.fallbackProjects.map((p) => p.name),
    ["Lib.Tests"]
  );
});

test("config file inside a project dir triggers fallback; stray root file does not", () => {
  const root = scaffoldRepo();
  fs.writeFileSync(path.join(root, "src", "Lib", "appsettings.json"), "{}");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "README.md"), "");
  const runner = new Runner(root);

  const inProject = runner.computeAffected(["src/Lib/appsettings.json"]);
  assert.deepEqual(
    inProject.fallbackProjects.map((p) => p.name),
    ["Lib.Tests"]
  );

  const stray = runner.computeAffected(["package.json", "README.md", ".gitignore"]);
  assert.equal(stray.classes.length, 0);
  assert.equal(stray.fallbackProjects.length, 0);
});

test("build outputs (bin/obj) never drive selection", () => {
  const root = scaffoldRepo();
  fs.mkdirSync(path.join(root, "src", "Lib", "obj", "Debug"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "Lib", "obj", "Debug", "Gen.cs"), "");
  const runner = new Runner(root);
  const a = runner.computeAffected([
    "src/Lib/obj/Debug/Gen.cs",
    "src/Lib/bin/Debug/net10.0/Lib.deps.json",
  ]);
  assert.equal(a.classes.length, 0);
  assert.equal(a.fallbackProjects.length, 0);
});

test("queueRefreshFromOutcomes: only static, missing, or stale rows queue", () => {
  const root = scaffoldRepo();
  const runner = new Runner(root);
  const rel = "tests/Lib.Tests/Lib.Tests.csproj";
  runner.map.update("Ns.Fresh", rel, ["a.cs"]); // fresh coverage
  runner.map.updateStatic("Ns.Static", rel, ["b.cs"]); // static
  runner.map.update("Ns.Stale", rel, ["c.cs"]);
  // Age the Stale row past the freshness horizon.
  (runner.map.entry("Ns.Stale") as { updatedAt: string }).updatedAt = new Date(
    Date.now() - Runner.COVERAGE_FRESH_MS - 1000
  ).toISOString();

  const mk = (cls: string) => ({ classFqn: cls, method: cls + ".M", passed: true, skipped: false });
  runner.queueRefreshFromOutcomes(
    [mk("Ns.Fresh"), mk("Ns.Static"), mk("Ns.Stale"), mk("Ns.New"),
     { classFqn: "Ns.Skipped", method: "m", passed: false, skipped: true }],
    { "Ns.New": rel, "Ns.Skipped": rel }
  );
  assert.deepEqual([...runner.pendingRefresh.keys()].sort(), ["Ns.New", "Ns.Stale", "Ns.Static"]);
});

test("fallback project's mapped classes are not double-run", () => {
  const root = scaffoldRepo();
  fs.writeFileSync(path.join(root, "src", "Lib", "New.cs"), "");
  const runner = new Runner(root);
  runner.map.update("Lib.Tests.CalcTests", "tests/Lib.Tests/Lib.Tests.csproj", [
    "src/Lib/Calc.cs",
  ]);
  const a = runner.computeAffected(["src/Lib/Calc.cs", "src/Lib/New.cs"]);
  assert.equal(a.classes.length, 0); // whole project runs anyway
  assert.deepEqual(
    a.fallbackProjects.map((p) => p.name),
    ["Lib.Tests"]
  );
});
