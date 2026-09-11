import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildProjectGraph,
  projectForFile,
  usesMtpRunner,
  transitiveSourceStamp,
  sourceStamp,
  sourceFingerprints,
  testProjects,
  ProjectGraph,
} from "../core/projects";

function scaffoldDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "impact-proj-"));
}

/* ------------------------------------------------------------------ */
/*  usesMtpRunner — MTP detection edge cases                          */
/* ------------------------------------------------------------------ */

test("usesMtpRunner: MSTest.Sdk marks as MTP", () => {
  assert.equal(
    usesMtpRunner('<Project Sdk="MSTest.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'),
    true
  );
});

test("usesMtpRunner: UseMicrosoftTestingPlatformRunner marks as MTP", () => {
  assert.equal(
    usesMtpRunner('<PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup>'),
    true
  );
});

test("usesMtpRunner: TestingPlatformDotnetTestSupport marks as MTP", () => {
  assert.equal(
    usesMtpRunner('<PropertyGroup><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport></PropertyGroup>'),
    true
  );
});

test("usesMtpRunner: EnableNUnitRunner marks as MTP", () => {
  assert.equal(
    usesMtpRunner('<PropertyGroup><EnableNUnitRunner>true</EnableNUnitRunner></PropertyGroup>'),
    true
  );
});

test("usesMtpRunner: EnableAspireTestingPlatform marks as MTP", () => {
  assert.equal(
    usesMtpRunner('<PropertyGroup><EnableAspireTestingPlatform>true</EnableAspireTestingPlatform></PropertyGroup>'),
    true
  );
});

test("usesMtpRunner: xunit.v3 WITHOUT adapter → MTP", () => {
  assert.equal(
    usesMtpRunner(
      '<Project><ItemGroup><PackageReference Include="xunit.v3" Version="1.0.0" /></ItemGroup></Project>'
    ),
    true
  );
});

test("usesMtpRunner: xunit.v3 WITH adapter → NOT MTP (classic VSTest)", () => {
  assert.equal(
    usesMtpRunner(
      '<Project>' +
        '<ItemGroup><PackageReference Include="xunit.v3" Version="1.0.0" /></ItemGroup>' +
        '<ItemGroup><PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" /></ItemGroup>' +
        "</Project>"
    ),
    false
  );
});

test("usesMtpRunner: classic xunit WITHOUT v3 → NOT MTP", () => {
  assert.equal(
    usesMtpRunner(
      '<Project>' +
        '<ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup>' +
        '<ItemGroup><PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" /></ItemGroup>' +
        "</Project>"
    ),
    false
  );
});

test("usesMtpRunner: case insensitive matching", () => {
  assert.equal(
    usesMtpRunner('<PropertyGroup><Usemicrosofttestingplatformrunner>TRUE</Usemicrosofttestingplatformrunner></PropertyGroup>'),
    true
  );
});

test("usesMtpRunner: empty project → NOT MTP", () => {
  assert.equal(
    usesMtpRunner('<Project Sdk="Microsoft.NET.Sdk"></Project>'),
    false
  );
});

/* ------------------------------------------------------------------ */
/*  projectForFile — edge cases                                       */
/* ------------------------------------------------------------------ */

test("projectForFile: finds the project whose dir contains the file", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "Lib", "Lib.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    const graph = buildProjectGraph(root);
    const proj = projectForFile(graph, path.join(root, "src", "Lib", "MyFile.cs"));
    assert.ok(proj !== undefined);
    assert.equal(proj!.name, "Lib");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projectForFile: nearest ancestor wins for nested dirs", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src", "A", "B", "C"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "A", "A.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    fs.writeFileSync(path.join(root, "src", "A", "B", "B.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    const graph = buildProjectGraph(root);
    const file = path.join(root, "src", "A", "B", "C", "deep.cs");
    const proj = projectForFile(graph, file);
    assert.ok(proj !== undefined);
    assert.equal(proj!.name, "B", "B is the nearest parent project, not A");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projectForFile: returns undefined for a file outside all projects", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "Lib", "Lib.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    const graph = buildProjectGraph(root);
    const proj = projectForFile(graph, path.join(root, "outside", "file.cs"));
    assert.equal(proj, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projectForFile: projectForFile with path containing ..", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "Lib", "Lib.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    const graph = buildProjectGraph(root);
    const proj = projectForFile(graph, path.join(root, "src", "Lib", "..", "Lib", "file.cs"));
    assert.ok(proj !== undefined, "path with .. should resolve correctly");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  testProjects — basic queries                                      */
/* ------------------------------------------------------------------ */

test("testProjects: returns only test projects", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests", "T"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "Lib", "Lib.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    fs.writeFileSync(
      path.join(root, "tests", "T", "T.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>'
    );
    const graph = buildProjectGraph(root);
    const tests = testProjects(graph);
    assert.equal(tests.length, 1, "only the test project");
    assert.equal(tests[0].name, "T");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("testProjects: empty graph returns empty array", () => {
  const root = scaffoldDir();
  try {
    fs.writeFileSync(path.join(root, "readme.md"), "empty");
    const graph = buildProjectGraph(root);
    assert.equal(testProjects(graph).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  sourceFingerprints — file-level fingerprinting                    */
/* ------------------------------------------------------------------ */

test("sourceFingerprints: walks source files and reports mtime:size", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "A.cs"), "content");
    fs.writeFileSync(path.join(root, "src", "B.csproj"), '<Project></Project>');
    const fps = new Map<string, string>();
    sourceFingerprints(root, path.join(root, "src"), fps);
    assert.ok(fps.has("src/A.cs"), "A.cs should be in fingerprints");
    assert.ok(fps.has("src/B.csproj"), "B.csproj should be in fingerprints");
    // Each value should be mtime:size format.
    const val = fps.get("src/A.cs")!;
    assert.ok(/^\d+:\d+$/.test(val), `expected mtime:size, got ${val}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sourceFingerprints: skips bin and obj directories", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "output.dll"), "binary");
    fs.mkdirSync(path.join(root, "obj"), { recursive: true });
    fs.writeFileSync(path.join(root, "obj", "assets.json"), "{}");
    const fps = new Map<string, string>();
    sourceFingerprints(root, root, fps);
    assert.ok(!fps.has("bin/output.dll"), "bin/ files should not be in fingerprints");
    assert.ok(!fps.has("obj/assets.json"), "obj/ files should not be in fingerprints");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sourceFingerprints: skips non-source file extensions", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "A.cs"), "content");
    fs.writeFileSync(path.join(root, "src", "A.exe"), "binary");
    fs.writeFileSync(path.join(root, "src", "A.log"), "log");
    const fps = new Map<string, string>();
    sourceFingerprints(root, path.join(root, "src"), fps);
    assert.ok(fps.has("src/A.cs"), ".cs should be included");
    assert.ok(!fps.has("src/A.exe"), ".exe should be excluded");
    assert.ok(!fps.has("src/A.log"), ".log should be excluded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  sourceStamp — directory stamping                                  */
/* ------------------------------------------------------------------ */

test("sourceStamp: format is count:mtime:digest", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "A.cs"), "content");
    fs.writeFileSync(path.join(root, "src", "B.cs"), "more");
    const stamp = sourceStamp(path.join(root, "src"));
    const parts = stamp.split(":");
    assert.equal(parts.length, 3, "stamp should have 3 parts");
    assert.equal(Number(parts[0]), 2, "file count should be 2");
    assert.ok(Number.isFinite(Number(parts[1])), "mtime should be finite");
    assert.equal(parts[2].length, 12, "digest should be 12 hex chars");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// sourceStamp is deliberately mtime+file-set based (no content hashing —
// that's the cost H4 optimizes away): count : newest-mtime : sha1(paths).
test("sourceStamp: different file SETS produce different stamps", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "A.cs"), "content1");
    const s1 = sourceStamp(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "B.cs"), "content2");
    const s2 = sourceStamp(path.join(root, "src"));
    assert.notEqual(s1, s2, "adding a file must change the stamp");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sourceStamp: an mtime change is reflected in the stamp", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const f = path.join(root, "src", "A.cs");
    fs.writeFileSync(f, "content1");
    const s1 = sourceStamp(path.join(root, "src"));
    // Explicit future mtime (same-ms rewrites can't be distinguished).
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    const s2 = sourceStamp(path.join(root, "src"));
    assert.notEqual(s1, s2, "a changed mtime must change the stamp");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sourceStamp: file rename changes stamp (path digest)", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "A.cs"), "content");
    const s1 = sourceStamp(path.join(root, "src"));
    fs.renameSync(path.join(root, "src", "A.cs"), path.join(root, "src", "B.cs"));
    const s2 = sourceStamp(path.join(root, "src"));
    assert.notEqual(s1, s2, "file rename should change stamp");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  transitiveSourceStamp — cycle guard                               */
/* ------------------------------------------------------------------ */

test("transitiveSourceStamp: circular references do not infinite-loop", () => {
  const root = scaffoldDir();
  try {
    fs.mkdirSync(path.join(root, "A"), { recursive: true });
    fs.mkdirSync(path.join(root, "B"), { recursive: true });
    // A references B, B references A (circular).
    fs.writeFileSync(
      path.join(root, "A", "A.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk">' +
        '<ItemGroup><ProjectReference Include="../B/B.csproj" /></ItemGroup></Project>'
    );
    fs.writeFileSync(
      path.join(root, "B", "B.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk">' +
        '<ItemGroup><ProjectReference Include="../A/A.csproj" /></ItemGroup></Project>'
    );
    const graph = buildProjectGraph(root);
    const memo = new Map<string, string>();
    const stamp = transitiveSourceStamp(graph, path.join(root, "A", "A.csproj"), memo);
    // If we got here without hanging, the cycle guard worked.
    assert.ok(typeof stamp === "string", "stamp is a string");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
