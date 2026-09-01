import * as assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cacheDirFor } from "../core/util";

const execFileAsync = promisify(execFile);

/**
 * #24: the CLI surface a pipeline scripts against, exercised as a real child
 * process (`node out/cli.js`) on a scaffolded git repo with a seeded map —
 * no dotnet builds, so the whole file stays cheap.
 *
 * Two contracts under test:
 *  - `affected --format json` is ALWAYS valid JSON on stdout, with mapReady
 *    distinguishing "cold map — fall back to the full suite" from "nothing
 *    affected" (the workflow in docs/ci.md branches on exactly this);
 *  - `run --ci` flips the #7 hook-safety soft-skips (no map / lock held →
 *    exit 0) into failures, WITHOUT changing the default behavior hooks
 *    depend on.
 */

const CLI = path.join(__dirname, "..", "cli.js");

function scaffoldGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-cli-ci-"));
  fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "T"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Lib", "Lib.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"></Project>`
  );
  fs.writeFileSync(path.join(root, "src", "Lib", "A.cs"), "namespace Lib; public class A {}");
  fs.writeFileSync(path.join(root, "src", "Lib", "B.cs"), "namespace Lib; public class B {}");
  fs.writeFileSync(
    path.join(root, "tests", "T", "T.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>` +
      `<PackageReference Include="xunit" Version="2.9.0" />` +
      `<ProjectReference Include="../../src/Lib/Lib.csproj" />` +
      `</ItemGroup></Project>`
  );
  fs.writeFileSync(path.join(root, "tests", "T", "ATests.cs"), "namespace Lib.Tests; public class ATests {}");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
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
  git("commit", "-qm", "init");
  return root;
}

function seedMap(root: string): void {
  fs.mkdirSync(cacheDirFor(root), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDirFor(root), "impact-map.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "Lib.Tests.ATests": {
          csproj: "tests/T/T.csproj",
          files: ["src/Lib/A.cs"],
          source: "coverage",
          updatedAt: new Date().toISOString(),
        },
      },
    })
  );
}

/** Run the CLI; resolves (never rejects) with code/stdout/stderr. */
async function cli(root: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync(process.execPath, [CLI, ...args], { cwd: root, timeout: 60_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function cleanup(root: string): void {
  fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

test("affected --format json: mapped file → its class; unmapped file → fallback project", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    const mapped = await cli(root, "affected", "--format", "json", "src/Lib/A.cs");
    assert.equal(mapped.code, 0, mapped.stderr);
    const m = JSON.parse(mapped.stdout);
    assert.deepEqual(m, {
      mapReady: true,
      classes: ["Lib.Tests.ATests"],
      projects: [],
      changedFiles: ["src/Lib/A.cs"],
    });

    const unmapped = await cli(root, "affected", "--format", "json", "src/Lib/B.cs");
    assert.equal(unmapped.code, 0, unmapped.stderr);
    const u = JSON.parse(unmapped.stdout);
    assert.equal(u.mapReady, true);
    assert.deepEqual(u.classes, [], "unmapped file selects no mapped classes");
    assert.deepEqual(u.projects, ["T"], "unmapped source falls back to the referencing test project");

    // The default line output is unchanged — hooks parse it today.
    const lines = await cli(root, "affected", "src/Lib/A.cs");
    assert.equal(lines.stdout.trim(), "Lib.Tests.ATests");
  } finally {
    cleanup(root);
  }
});

test("affected --format json with a cold map: valid JSON, mapReady=false, exit 0", async () => {
  const root = scaffoldGitRepo();
  try {
    const r = await cli(root, "affected", "--format", "json", "src/Lib/A.cs");
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { mapReady: false, classes: [], projects: [], changedFiles: [] });
    assert.match(r.stderr, /no impact map yet/);
  } finally {
    cleanup(root);
  }
});

test("affected --format rejects unknown values with usage (exit 2)", async () => {
  const root = scaffoldGitRepo();
  try {
    const r = await cli(root, "affected", "--format", "yaml");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--format yaml is not valid/);
    assert.match(r.stderr, /usage:/);
  } finally {
    cleanup(root);
  }
});

test("run: cold map soft-skips by default (#7 hook safety) but FAILS under --ci (#24)", async () => {
  const root = scaffoldGitRepo();
  try {
    const hook = await cli(root, "run", "src/Lib/A.cs");
    assert.equal(hook.code, 0, "hook safety: infrastructure never blocks a commit");
    assert.match(hook.stderr, /skipping/);

    const ci = await cli(root, "run", "--ci", "src/Lib/A.cs");
    assert.equal(ci.code, 1, "a CI job must not green-light untested code on a cold map");
    assert.match(ci.stderr, /failing \(--ci\)/);
  } finally {
    cleanup(root);
  }
});

test("run --ci: a held shadow lock fails instead of skipping", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    // A live foreign process holds the lock (a sleeping child: probeable pid).
    const holder = execFile("sleep", ["120"]);
    fs.mkdirSync(cacheDirFor(root), { recursive: true });
    fs.writeFileSync(path.join(cacheDirFor(root), "shadow.lock"), String(holder.pid));
    try {
      const ci = await cli(root, "run", "--ci", "src/Lib/A.cs");
      assert.equal(ci.code, 1);
      assert.match(ci.stderr, /shadow worktree — failing \(--ci\)/);

      const hook = await cli(root, "run", "src/Lib/A.cs");
      assert.equal(hook.code, 0, "default lock contention still soft-skips for hooks");
    } finally {
      holder.kill();
    }
  } finally {
    cleanup(root);
  }
});

test("build-map --if-missing: no-op with a map present, exit 0", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    const r = await cli(root, "build-map", "--if-missing");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /impact map present \(1 test classes\); skipping build/);
  } finally {
    cleanup(root);
  }
});

/**
 * The exit codes a pipeline actually branches on, pinned with REAL runs so
 * 0 and 1 can never be swapped: `run --ci` must exit 0 when the affected
 * tests pass and 1 when one fails. Unlike the tests above, this scaffolds a
 * buildable repo and runs dotnet — the price of pinning the real mapping
 * (`result.ok ? 0 : 1`) end to end rather than trusting a unit seam.
 */
test("run --ci exit codes: green affected run exits 0, a failing test exits 1", { timeout: 600_000 }, async () => {
  const { dotnetOrNull } = await import("./deltas-helper");
  if (!dotnetOrNull()) return; // no SDK on this machine: nothing to test against

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-cli-exit-"));
  fs.mkdirSync(path.join(root, "src", "Calc"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Calc.Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Calc", "Calc.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
  );
  const calcCs = path.join(root, "src", "Calc", "Calc.cs");
  const GOOD = "namespace Calc;\n\npublic static class Calculator\n{\n    public static int Add(int a, int b)\n    {\n        return a + b;\n    }\n}\n";
  fs.writeFileSync(calcCs, GOOD);
  fs.writeFileSync(
    path.join(root, "tests", "Calc.Tests", "Calc.Tests.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><IsPackable>false</IsPackable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <ProjectReference Include="../../src/Calc/Calc.csproj" />
  </ItemGroup>
</Project>`
  );
  fs.writeFileSync(
    path.join(root, "tests", "Calc.Tests", "CalcTests.cs"),
    "using Xunit;\n\nnamespace Calc.Tests;\n\npublic class CalcTests\n{\n    [Fact] public void Adds() => Assert.Equal(5, Calc.Calculator.Add(2, 3));\n}\n"
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  fs.mkdirSync(cacheDirFor(root), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDirFor(root), "impact-map.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "Calc.Tests.CalcTests": {
          csproj: "tests/Calc.Tests/Calc.Tests.csproj",
          files: ["src/Calc/Calc.cs"],
          source: "coverage",
          updatedAt: new Date().toISOString(),
        },
      },
    })
  );

  try {
    // Green: the affected class passes → exit 0, and the summary says so.
    const green = await cli(root, "run", "--ci", "src/Calc/Calc.cs");
    assert.equal(green.code, 0, `green run must exit 0; stderr: ${green.stderr.slice(0, 500)}`);
    assert.match(green.stdout + green.stderr, /1\/1 passed/);

    // Red: break the method → the same invocation must exit 1 and name the failure.
    fs.writeFileSync(calcCs, GOOD.replace("return a + b;", "return a - b;"));
    const red = await cli(root, "run", "--ci", "src/Calc/Calc.cs");
    assert.equal(red.code, 1, `a failing test must exit 1; stdout: ${red.stdout.slice(0, 500)}`);
    assert.match(red.stdout + red.stderr, /FAIL .*Adds/);
  } finally {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Full CLI-surface audit: every command and flag proven against the real
// binary, not just the parser. Cheap by design — scaffolds reuse the seeded
// map and none of these invocations pays for a dotnet build.
// ---------------------------------------------------------------------------

/** Git in a scaffold repo with a pinned identity (matches scaffoldGitRepo's). */
function gitIn(root: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

test("status: reports the mapped class count, cold and seeded", async () => {
  const root = scaffoldGitRepo();
  try {
    const cold = await cli(root, "status");
    assert.equal(cold.code, 0, cold.stderr);
    assert.match(cold.stdout, /impact map: 0 test classes mapped/);
    seedMap(root);
    const seeded = await cli(root, "status");
    assert.equal(seeded.code, 0);
    assert.match(seeded.stdout, /impact map: 1 test classes mapped/);
  } finally {
    cleanup(root);
  }
});

test("affected line output: fallback projects print as project:<name> lines", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    const r = await cli(root, "affected", "src/Lib/B.cs");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "project:T", "hooks parse this exact line form");
  } finally {
    cleanup(root);
  }
});

test("--base selection against real git history; a bad ref exits 2, never selects nothing", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    // A typo'd ref in a pre-push hook must fail loudly, not green-light the push.
    const bad = await cli(root, "affected", "--base", "no-such-ref");
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--base no-such-ref: unknown revision/);

    // Real selection: a commit touching the mapped file lands on top of the
    // base, no file args — the diff drives it.
    fs.appendFileSync(path.join(root, "src", "Lib", "A.cs"), "\n// touched\n");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-qm", "touch A");
    const r = await cli(root, "affected", "--base", "HEAD~1");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "Lib.Tests.ATests");
  } finally {
    cleanup(root);
  }
});

test("--staged selects the index only, through the real binary", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    // Unstaged edit: --staged must NOT see it.
    fs.appendFileSync(path.join(root, "src", "Lib", "A.cs"), "\n// dirty\n");
    const unstaged = await cli(root, "affected", "--staged");
    assert.equal(unstaged.code, 0, unstaged.stderr);
    assert.equal(unstaged.stdout.trim(), "", "unstaged edits are invisible to --staged");
    // Staged: selected.
    gitIn(root, "add", "src/Lib/A.cs");
    const staged = await cli(root, "affected", "--staged");
    assert.equal(staged.code, 0, staged.stderr);
    assert.equal(staged.stdout.trim(), "Lib.Tests.ATests");
  } finally {
    cleanup(root);
  }
});

test("file arguments and --base/--staged are mutually exclusive (exit 2) for affected and run", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    for (const args of [
      ["affected", "src/Lib/A.cs", "--staged"],
      ["run", "src/Lib/A.cs", "--base", "HEAD"],
    ]) {
      const r = await cli(root, ...args);
      assert.equal(r.code, 2, `${args.join(" ")} must be a usage error`);
      assert.match(r.stderr, /mutually exclusive/);
    }
  } finally {
    cleanup(root);
  }
});

test("usage errors exit 2: unknown command, no command, bad --parallel; outside a repo exits 1", async () => {
  const root = scaffoldGitRepo();
  try {
    const unknown = await cli(root, "bogus");
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /usage: impact/);

    const none = await cli(root);
    assert.equal(none.code, 2);

    const badParallel = await cli(root, "build-map", "--parallel", "abc");
    assert.equal(badParallel.code, 2, "a typo'd --parallel must not be silently ignored");
    assert.match(badParallel.stderr, /--parallel abc is not valid/);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "impact-cli-nongit-"));
    try {
      const r = await cli(outside, "status");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not inside a git repository/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    cleanup(root);
  }
});

test("run: a clean tree reports 'no changes'; a non-source change reports 'no tests affected' — both exit 0", async () => {
  const root = scaffoldGitRepo();
  try {
    seedMap(root);
    const clean = await cli(root, "run");
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /no changes detected; nothing to run/);

    fs.writeFileSync(path.join(root, "README.md"), "docs only\n");
    const docs = await cli(root, "run");
    assert.equal(docs.code, 0, docs.stderr);
    assert.match(docs.stdout, /no tests affected by this change/);
  } finally {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    cleanup(root);
  }
});

test("build-map end to end on a projectless repo: maps 0, honors --parallel, --refresh beats --if-missing", async () => {
  // No csproj anywhere → discovery finds nothing and no dotnet build runs,
  // so the full command path (lock → prepare → discover → map → summary)
  // stays cheap enough to drive for real.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-cli-bm-"));
  fs.writeFileSync(path.join(root, "README.md"), "empty\n");
  gitIn(root, "init", "-q");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "init");
  try {
    const first = await cli(root, "build-map", "--parallel", "4");
    assert.equal(first.code, 0, first.stderr);
    // A projectless repo maps nothing and still exits 0. (The static-map
    // stage reports one "failed" row here — nothing buildable to analyze —
    // which is summary noise, not an error exit; pinned as-is.)
    assert.match(first.stdout, /mapped 0 test classes/);

    // --if-missing alone would skip once a map exists; --refresh overrides it.
    seedMap(root);
    const skip = await cli(root, "build-map", "--if-missing");
    assert.equal(skip.code, 0);
    assert.match(skip.stdout, /skipping build/);
    const forced = await cli(root, "build-map", "--if-missing", "--refresh");
    assert.equal(forced.code, 0, forced.stderr);
    assert.doesNotMatch(forced.stdout, /skipping build/, "--refresh must force the pass");
    assert.match(forced.stdout, /mapped \d+ test classes/);
  } finally {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    cleanup(root);
  }
});
