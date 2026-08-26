import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";

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
