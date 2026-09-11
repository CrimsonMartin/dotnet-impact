import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectClassCoverage } from "../core/coverage";
import { Runner } from "../core/runner";
import * as util from "../core/util";

test("classic map refresh isolates collector writes from hot-patch assemblies for every TFM", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-refresh-isolation-"));
  const project = "tests/T/T.csproj";
  fs.mkdirSync(path.join(root, "tests/T"), { recursive: true });
  fs.writeFileSync(path.join(root, project), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>');
  fs.writeFileSync(path.join(root, "tests/T/Tests.cs"), "class Tests {}");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "fixture"]]) {
    execFileSync("git", args, { cwd: root });
  }
  try {
    const runner = new Runner(root);
    const shadow = await runner.prepare();
    const originalDlls = ["net8.0", "net10.0"].map((tfm) => {
      const dll = path.join(shadow.dir, "tests/T/bin/Debug", tfm, "T.dll");
      fs.mkdirSync(path.dirname(dll), { recursive: true });
      fs.writeFileSync(dll, "original assembly");
      fs.writeFileSync(path.join(path.dirname(dll), "T.deps.json"), "runtime dependencies");
      return dll;
    });
    runner.map.updateStatic("T.Tests", project, ["tests/T/Tests.cs"]);
    runner.pendingRefresh.set("T.Tests", project);
    // Exercise the fallback even when warm coverage was configured but failed.
    runner.coverageWarm = { collectClass: async () => null };
    const collected: string[] = [];
    const frameworks: string[] = [];
    t.mock.method(util, "exec", async (_cmd: string, args: string[]) => {
      if (args[0] === "msbuild") {
        frameworks.push(args.find((arg) => arg.startsWith("-p:TargetFramework="))!);
        return { code: 0, stdout: JSON.stringify({ Properties: {
          TraceDataCollectorDirectoryPath: "/nuget/collector",
          VSTestTestAdapterPath: "/custom/adapter",
        } }), stderr: "" };
      }
      if (!args[1].endsWith(".csproj")) {
        assert.equal(args[args.indexOf("--test-adapter-path") + 1], "/nuget/collector;/custom/adapter");
      }
      // The old project-based invocation instruments the live output. A DLL
      // invocation must instead point at a complete disposable output copy.
      const target = args[1].endsWith(".csproj") ? originalDlls[0] : args[1];
      collected.push(target);
      assert.equal(fs.readFileSync(path.join(path.dirname(target), "T.deps.json"), "utf8"), "runtime dependencies");
      fs.writeFileSync(target, "instrumented assembly");
      const results = args[args.indexOf("--results-directory") + 1];
      fs.mkdirSync(results, { recursive: true });
      fs.writeFileSync(path.join(results, "coverage.cobertura.xml"), `<coverage><sources><source>${shadow.dir}</source></sources><packages><package><classes><class filename="tests/T/Tests.cs"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`);
      return { code: 0, stdout: "", stderr: "" };
    });
    assert.equal(await runner.refreshPending(), 1);
    for (const dll of originalDlls) {
      assert.equal(fs.readFileSync(dll, "utf8"), "original assembly", "coverage must never rewrite a DLL mapped by the hot-patch host");
    }
    assert.equal(collected.length, 2, "both target frameworks must be measured");
    assert.deepEqual(frameworks.sort(), ["-p:TargetFramework=net10.0", "-p:TargetFramework=net8.0"]);
    for (const dll of collected) assert.equal(fs.existsSync(dll), false, "temporary copies must be cleaned up");
    assert.deepEqual(runner.map.entry("T.Tests")?.files, ["tests/T/Tests.cs"]);
  } finally {
    fs.rmSync(util.cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("classic collector fallback gets a fresh copy and cleans up when collection throws", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-collector-fallback-"));
  const dll = path.join(root, "bin", "T.dll");
  fs.mkdirSync(path.dirname(dll));
  fs.writeFileSync(dll, "original assembly");
  const collected: string[] = [];
  try {
    t.mock.method(util, "exec", async (_cmd: string, args: string[]) => {
      if (args[0] === "msbuild") return { code: 0, stdout: '{"Properties":{}}', stderr: "" };
      const copy = args[1];
      collected.push(copy);
      assert.equal(fs.readFileSync(copy, "utf8"), "original assembly", "fallback must not reuse instrumented files");
      fs.writeFileSync(copy, "instrumented assembly");
      if (collected.length === 2) throw new Error("collector crashed");
      return { code: 1, stdout: "", stderr: "collector unavailable" };
    });
    await assert.rejects(collectClassCoverage(root, path.join(root, "T.csproj"), [dll], "T.Tests"), /collector crashed/);
    assert.equal(collected.length, 2);
    assert.equal(fs.readFileSync(dll, "utf8"), "original assembly");
    for (const copy of collected) assert.equal(fs.existsSync(copy), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
