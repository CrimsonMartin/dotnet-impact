import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * #16: minimalBuild reads each project's own-source stamp from the REAL repo,
 * but compiles the SHADOW copy synced earlier in prepare(). An edit landing in
 * that gap gets its mtime into the recorded stamp without its content being in
 * the compiled dll — the project then looks up to date forever while
 * dependents rebuild against an API surface its binary doesn't have
 * (MissingMethodException deep in a dependent's tests at runtime).
 */

/** Tmp git repo: leaf classlib L, test project T referencing it. */
function scaffoldGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-stamp-test-"));
  fs.mkdirSync(path.join(root, "src", "L"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "T"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "L", "L.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"></Project>`
  );
  fs.writeFileSync(path.join(root, "src", "L", "Thing.cs"), "class Thing {}");
  fs.writeFileSync(
    path.join(root, "tests", "T", "T.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>` +
      `<PackageReference Include="xunit" Version="2.9.0" />` +
      `<ProjectReference Include="../../src/L/L.csproj" />` +
      `</ItemGroup></Project>`
  );
  fs.writeFileSync(path.join(root, "tests", "T", "ThingTests.cs"), "class ThingTests {}");
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

function cleanup(root: string): void {
  fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root });
  } catch {
    /* ignore */
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("minimalBuild: an edit landing after the overlay sync still rebuilds on the next run (#16)", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    const built: string[] = [];
    runner.msbuildImpl = async (csprojShadowAbs) => {
      const name = path.basename(csprojShadowAbs, ".csproj");
      built.push(name);
      // Emulate the build laying down outputs where findBuiltDll(s) look.
      const outDir = path.join(path.dirname(csprojShadowAbs), "bin", "Debug", "net10.0");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${name}.dll`), "");
      return { code: 0 };
    };
    const testRels = new Set(["tests/T/T.csproj"]);
    // minimalBuild is private plumbing; the race lives entirely inside it.
    const minimalBuild = (): Promise<boolean> =>
      (runner as unknown as { minimalBuild(rels: Set<string>): Promise<boolean> }).minimalBuild(
        testRels
      );

    // Run 1: cold — both projects build, stamps recorded.
    await tick(); // scaffold mtimes must predate the sync
    await runner.prepare();
    assert.ok(await minimalBuild(), "cold minimal build failed");
    assert.deepEqual(built.sort(), ["L", "T"]);

    // Run 2: the race. The overlay sync has already happened when a save
    // lands in L — the stamp will see the edit, the shadow compile will not.
    built.length = 0;
    await runner.prepare();
    await tick(); // the edit's mtime must land after the sync instant
    fs.appendFileSync(path.join(root, "src", "L", "Thing.cs"), "\n// new member\n");
    assert.ok(await minimalBuild(), "raced minimal build failed");
    assert.deepEqual(built, ["L"], "changed leaf project was not rebuilt");

    // Run 3: the next save's run syncs the edit into the shadow. L's dll was
    // compiled from pre-edit source, so L MUST rebuild — a recorded stamp
    // claiming otherwise is the stale-assembly bug.
    built.length = 0;
    await tick();
    await runner.prepare();
    assert.ok(await minimalBuild(), "follow-up minimal build failed");
    assert.ok(
      built.includes("L"),
      "leaf project's post-sync edit was recorded as built: its dll stays stale and dependents bind against members it does not have"
    );
  } finally {
    cleanup(root);
  }
});

test("minimalBuild: stamps recorded normally when no edit races the sync", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    const built: string[] = [];
    runner.msbuildImpl = async (csprojShadowAbs) => {
      const name = path.basename(csprojShadowAbs, ".csproj");
      built.push(name);
      const outDir = path.join(path.dirname(csprojShadowAbs), "bin", "Debug", "net10.0");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${name}.dll`), "");
      return { code: 0 };
    };
    const testRels = new Set(["tests/T/T.csproj"]);
    const minimalBuild = (): Promise<boolean> =>
      (runner as unknown as { minimalBuild(rels: Set<string>): Promise<boolean> }).minimalBuild(
        testRels
      );

    await tick();
    await runner.prepare();
    assert.ok(await minimalBuild());
    assert.deepEqual(built.sort(), ["L", "T"]);

    // No edits: the incremental skip must keep working (the whole point of
    // the fast path is that an unchanged tree builds nothing).
    built.length = 0;
    await runner.prepare();
    assert.ok(await minimalBuild());
    assert.deepEqual(built, [], "unchanged projects were rebuilt — incrementality regressed");
  } finally {
    cleanup(root);
  }
});
