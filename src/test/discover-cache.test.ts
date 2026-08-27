import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/** Tmp git repo with one committed xunit-shaped test project. */
function scaffoldGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-disc-test-"));
  fs.mkdirSync(path.join(root, "tests", "T"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "T", "T.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>`
  );
  fs.writeFileSync(path.join(root, "tests", "T", "ATests.cs"), "class ATests {}");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
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

test("discoverAll: cache skip, invalidation, force, failure-keeps-stale, dead-project cleanup", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    let calls = 0;
    let fail = false;
    const seams = {
      buildImpl: async () => undefined,
      discoverImpl: async () => {
        calls++;
        if (fail) throw new Error("boom");
        return ["Ns.ATests"];
      },
    };

    // 1. Cold: discovers once, caches.
    const d1 = await runner.discoverAll(seams);
    assert.deepEqual(d1, { "tests/T/T.csproj": ["Ns.ATests"] });
    assert.equal(calls, 1);

    // 2. Warm, unchanged: stamp skip — zero discovery calls, same result.
    const d2 = await runner.discoverAll(seams);
    assert.deepEqual(d2, d1);
    assert.equal(calls, 1);

    // 3. Source touched: that project rediscovers.
    const f = path.join(root, "tests", "T", "ATests.cs");
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await runner.discoverAll(seams);
    assert.equal(calls, 2);

    // 4. force bypasses a valid stamp.
    await runner.discoverAll({ ...seams, force: true });
    assert.equal(calls, 3);

    // 5. Discovery failure keeps the stale cached row instead of losing the tree.
    fail = true;
    fs.utimesSync(f, new Date(), new Date(Date.now() + 10_000));
    const d5 = await runner.discoverAll(seams);
    assert.equal(calls, 4);
    assert.deepEqual(d5["tests/T/T.csproj"], ["Ns.ATests"]);
    fail = false;

    // 6. Dead projects drop out of the cache file.
    fs.mkdirSync(path.join(root, "tests", "U"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tests", "U", "U.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>`
    );
    await runner.discoverAll({ ...seams, force: true }); // caches U
    fs.rmSync(path.join(root, "tests", "U"), { recursive: true });
    fs.utimesSync(f, new Date(), new Date(Date.now() + 15_000)); // make T dirty so the sweep runs
    await runner.discoverAll(seams);
    const cache = JSON.parse(
      fs.readFileSync(path.join(cacheDirFor(root), "discovery-cache.json"), "utf8")
    );
    assert.deepEqual(Object.keys(cache.projects), ["tests/T/T.csproj"]);
  } finally {
    cleanup(root);
  }
});
