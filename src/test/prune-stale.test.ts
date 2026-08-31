import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { sourceStamp } from "../core/projects";
import { KnownResult, pruneKnownResults } from "../core/replay";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/** Tmp git repo with one committed xunit-shaped test project. */
function scaffoldGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-prune-test-"));
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

test("sourceStamp: moving a file into a subfolder changes the stamp (#17)", () => {
  const root = scaffoldGitRepo();
  try {
    const dir = path.join(root, "tests", "T");
    const before = sourceStamp(dir);
    // rename preserves the file's mtime and the project's file count — the
    // stamp must still change, or the stale discovery cache keeps the pane
    // showing the pre-move class.
    fs.mkdirSync(path.join(dir, "Sub"));
    fs.renameSync(path.join(dir, "ATests.cs"), path.join(dir, "Sub", "ATests.cs"));
    const after = sourceStamp(dir);
    assert.notEqual(after, before, "stamp did not change after a mtime-preserving move");
  } finally {
    cleanup(root);
  }
});

test("discoverAll: an mtime-preserving move re-discovers and returns the new FQNs", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    runner.map.update("Old.ATests", "tests/T/T.csproj", ["src/a.cs"]);
    let calls = 0;
    let listed = ["Old.ATests.Adds"];
    const seams = {
      buildImpl: async () => undefined,
      discoverImpl: async () => {
        calls++;
        return listed;
      },
    };

    const d1 = await runner.discoverAll(seams);
    assert.deepEqual(d1["tests/T/T.csproj"], ["Old.ATests.Adds"]);
    assert.equal(calls, 1);

    // Move the class into a subfolder (namespace changes with it).
    const dir = path.join(root, "tests", "T");
    fs.mkdirSync(path.join(dir, "Sub"));
    fs.renameSync(path.join(dir, "ATests.cs"), path.join(dir, "Sub", "ATests.cs"));
    listed = ["New.Sub.ATests.Adds"];

    const d2 = await runner.discoverAll(seams);
    assert.equal(calls, 2, "move did not invalidate the discovery cache");
    assert.deepEqual(
      d2["tests/T/T.csproj"],
      ["New.Sub.ATests.Adds"],
      "discovery still serves the pre-move FQN from cache"
    );
    // The old class must also leave the impact map, or the tree union
    // resurrects it as a ghost entry.
    assert.ok(!runner.map.has("Old.ATests"), "impact map still holds the pre-move class");
  } finally {
    cleanup(root);
  }
});

test("discoverAll: a deleted class is pruned from the map and lastFailures", async () => {
  const root = scaffoldGitRepo();
  try {
    fs.writeFileSync(path.join(root, "tests", "T", "BTests.cs"), "class BTests {}");
    // Seed a remembered failure for the class that is about to be deleted.
    fs.mkdirSync(cacheDirFor(root), { recursive: true });
    fs.writeFileSync(
      path.join(cacheDirFor(root), "last-failures.json"),
      JSON.stringify(["Ns.BTests"])
    );
    const runner = new Runner(root);
    runner.map.update("Ns.ATests", "tests/T/T.csproj", ["src/a.cs"]);
    runner.map.update("Ns.BTests", "tests/T/T.csproj", ["src/b.cs"]);

    let listed = ["Ns.ATests.Adds", "Ns.BTests.Bops"];
    const seams = {
      buildImpl: async () => undefined,
      discoverImpl: async () => listed,
    };
    await runner.discoverAll(seams);
    assert.ok(runner.map.has("Ns.BTests"));

    fs.rmSync(path.join(root, "tests", "T", "BTests.cs"));
    listed = ["Ns.ATests.Adds"];
    await runner.discoverAll(seams);

    assert.ok(runner.map.has("Ns.ATests"), "live class was wrongly pruned");
    assert.ok(!runner.map.has("Ns.BTests"), "deleted class survived in the impact map");
    const failures = JSON.parse(
      fs.readFileSync(path.join(cacheDirFor(root), "last-failures.json"), "utf8")
    );
    assert.ok(!failures.includes("Ns.BTests"), "deleted class survived in lastFailures");
  } finally {
    cleanup(root);
  }
});

test("discoverAll: an exit-0-but-empty discovery must NOT prune the project's rows", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    // Measured coverage row for a class whose .cs file is still on disk.
    runner.map.update("Ns.ATests", "tests/T/T.csproj", ["src/a.cs"]);

    const seams = {
      buildImpl: async () => undefined,
      // Simulates unparsed MTP output / missing runner: exit 0, zero methods.
      // discoverTests only throws on non-zero exit AND zero methods, so this
      // path reaches the prune with an empty class list.
      discoverImpl: async () => [] as string[],
    };
    await runner.discoverAll(seams);
    assert.ok(
      runner.map.has("Ns.ATests"),
      "empty discovery wiped measured coverage for a class still on disk"
    );
  } finally {
    cleanup(root);
  }
});

test("pruneKnownResults: drops dead method FQNs, keeps live ones", () => {
  const known = new Map<string, KnownResult>([
    ["Ns.ATests.Adds", { classFqn: "Ns.ATests", passed: true, skipped: false, duration: 5 }],
    ["Ns.GoneTests.Bops", { classFqn: "Ns.GoneTests", passed: false, skipped: false, duration: 9 }],
  ]);
  pruneKnownResults(known, new Set(["Ns.ATests.Adds"]));
  assert.deepEqual(
    [...known.keys()],
    ["Ns.ATests.Adds"],
    "deleted method's result would keep replaying into the pane"
  );
});
