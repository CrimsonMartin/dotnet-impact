import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * #33 — changes made while VS Code is closed must be detected at startup.
 *
 * Impact's freshness checks are all reactive (build stamps consulted during a
 * build, the #10 watcher only alive while the window is), so an edit landing
 * between sessions produced no run: the tree repainted from cache with the
 * previous session's verdicts until the user happened to save. This pins the
 * session-boundary detection: a persisted source digest, re-walked and diffed
 * at startup.
 */

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-startup-"));
  fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "Lib", "Lib.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
  );
  fs.writeFileSync(path.join(root, "src", "Lib", "Calc.cs"), "namespace Demo;\npublic static class Calc { public static int Add(int a, int b) => a + b; }\n");
  fs.writeFileSync(path.join(root, "src", "Lib", "Other.cs"), "namespace Demo;\npublic static class Other { }\n");
  const git = (...a: string[]) =>
    execFileSync("git", a, {
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
  fs.rmSync(root, { recursive: true, force: true });
}

/** Distinguishable mtime regardless of filesystem timestamp granularity. */
function writeAged(file: string, content: string, secondsAhead: number): void {
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, t, t);
}

test("#33 startup: a cold cache records a baseline and triggers nothing", () => {
  const root = scaffold();
  try {
    const runner = new Runner(root);
    // No digest persisted yet: first activation must not read as "everything
    // changed" — that would fire a full suite the first time Impact opens.
    assert.deepEqual(runner.sourceChangesSinceLastSession(), []);
    // ...and the baseline must now exist for the next session to diff against.
    assert.ok(fs.existsSync(path.join(cacheDirFor(root), "source-digest.json")));
    assert.deepEqual(runner.sourceChangesSinceLastSession(), []);
  } finally {
    cleanup(root);
  }
});

test("#33 startup: files edited, added, or deleted while closed are detected", () => {
  const root = scaffold();
  try {
    const runner = new Runner(root);
    runner.sourceChangesSinceLastSession(); // session 1 records the baseline

    // "VS Code is closed": edit one file, add one, delete another.
    writeAged(path.join(root, "src", "Lib", "Calc.cs"), "namespace Demo;\npublic static class Calc { public static int Add(int a, int b) => a - b; }\n", 5);
    writeAged(path.join(root, "src", "Lib", "New.cs"), "namespace Demo;\npublic static class New { }\n", 5);
    fs.rmSync(path.join(root, "src", "Lib", "Other.cs"));

    const changed = new Runner(root).sourceChangesSinceLastSession().sort();
    assert.deepEqual(
      changed,
      ["src/Lib/Calc.cs", "src/Lib/New.cs", "src/Lib/Other.cs"],
      "an edit, an addition, and a deletion must all surface at startup"
    );
  } finally {
    cleanup(root);
  }
});

test("#33 startup: an untouched tree triggers nothing, and build output is ignored", () => {
  const root = scaffold();
  try {
    new Runner(root).sourceChangesSinceLastSession(); // baseline

    // Build output churns constantly and must never trigger a startup run.
    fs.mkdirSync(path.join(root, "src", "Lib", "bin", "Debug"), { recursive: true });
    writeAged(path.join(root, "src", "Lib", "bin", "Debug", "Lib.dll"), "binary", 5);
    fs.mkdirSync(path.join(root, "src", "Lib", "obj"), { recursive: true });
    writeAged(path.join(root, "src", "Lib", "obj", "Lib.AssemblyInfo.cs"), "// generated", 5);

    assert.deepEqual(new Runner(root).sourceChangesSinceLastSession(), []);
  } finally {
    cleanup(root);
  }
});

test("#33 startup: a run re-baselines, so this session's own edits stay quiet next time", () => {
  const root = scaffold();
  try {
    const runner = new Runner(root);
    runner.sourceChangesSinceLastSession(); // startup of session 1

    // An edit made and tested DURING the session: the run re-baselines it.
    writeAged(path.join(root, "src", "Lib", "Calc.cs"), "namespace Demo;\npublic static class Calc { }\n", 5);
    runner.recordSourceDigest();

    assert.deepEqual(
      new Runner(root).sourceChangesSinceLastSession(),
      [],
      "an edit already tested this session must not re-run at the next startup"
    );
  } finally {
    cleanup(root);
  }
});

test("#33 startup: the digest is re-recorded, so the same change fires once", () => {
  const root = scaffold();
  try {
    new Runner(root).sourceChangesSinceLastSession(); // baseline
    writeAged(path.join(root, "src", "Lib", "Calc.cs"), "namespace Demo;\npublic static class Calc { }\n", 5);

    assert.deepEqual(new Runner(root).sourceChangesSinceLastSession(), ["src/Lib/Calc.cs"]);
    assert.deepEqual(
      new Runner(root).sourceChangesSinceLastSession(),
      [],
      "a detected change must not re-fire on every subsequent startup"
    );
  } finally {
    cleanup(root);
  }
});
