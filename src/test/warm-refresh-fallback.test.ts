import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * refreshPending's contract around the warm coverage pipeline (#3):
 * a warm result updates the map with no classic collector run, and a warm
 * failure (throw) never breaks refresh — it falls through to the classic
 * path, whose empty-result guard keeps the existing row.
 */

function scaffoldGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-warmfb-"));
  fs.mkdirSync(path.join(root, "tests", "T"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "T", "T.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>` +
      `<PackageReference Include="xunit" Version="2.9.0" />` +
      `</ItemGroup></Project>`
  );
  fs.writeFileSync(path.join(root, "tests", "T", "Tests.cs"), "class Tests {}");
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

test("refreshPending: warm coverage result updates the map without a classic collector run", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    await runner.prepare();
    runner.pendingRefresh.set("T.Tests", "tests/T/T.csproj");

    const calls: string[] = [];
    runner.coverageWarm = {
      collectClass: async (_shadow, _names, _dlls, cls) => {
        calls.push(cls);
        return { classFqn: cls, files: ["tests/T/Tests.cs"], passed: true, output: "" };
      },
    };

    const done = await runner.refreshPending();
    assert.equal(done, 1, "the warm result must count as a completed refresh");
    assert.deepEqual(calls, ["T.Tests"]);
    assert.deepEqual(runner.map.entry("T.Tests")?.files, ["tests/T/Tests.cs"], "map row must carry the warm files");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refreshPending: a throwing warm pipeline falls back and never poisons the refresh loop", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    const logs: string[] = [];
    runner.logSink = (m) => logs.push(m);
    await runner.prepare();
    // Seed an existing row that the failed refresh must NOT wipe.
    runner.map.update("T.Tests", "tests/T/T.csproj", ["tests/T/Tests.cs"]);
    runner.pendingRefresh.set("T.Tests", "tests/T/T.csproj");

    runner.coverageWarm = {
      collectClass: async () => {
        throw new Error("session died");
      },
    };

    // The classic fallback runs (and fails: nothing is built here); the
    // empty-result guard keeps the row and the loop completes cleanly.
    const done = await runner.refreshPending();
    assert.equal(done, 0);
    assert.deepEqual(runner.map.entry("T.Tests")?.files, ["tests/T/Tests.cs"], "existing row must survive");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
