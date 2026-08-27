import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { cliChangedFiles, committedDiffFiles, detectBase, parseNameStatusZ } from "../core/changeset";

function gitIn(cwd: string) {
  return (...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
}

/** An "origin" repo on main plus a clone with a feature branch ahead of it. */
function scaffoldCloneWithBranch(): { origin: string; clone: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "impact-cs-test-"));
  const origin = path.join(tmp, "origin");
  fs.mkdirSync(origin);
  const og = gitIn(origin);
  og("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, "a.txt"), "a");
  fs.writeFileSync(path.join(origin, "b.txt"), "b");
  og("add", "-A");
  og("commit", "-qm", "init");

  gitIn(tmp)("clone", "-q", origin, "clone");
  const clone = path.join(tmp, "clone");
  const cg = gitIn(clone);
  cg("checkout", "-qb", "feature");
  fs.writeFileSync(path.join(clone, "a.txt"), "a2");
  cg("commit", "-qam", "edit a on feature");
  return { origin, clone, tmp };
}

test("parseNameStatusZ: plain and rename records", () => {
  const out = parseNameStatusZ("M\0src/A.cs\0R100\0old/B.cs\0new/B.cs\0A\0C.cs\0");
  assert.deepEqual(out, [
    { status: "M", file: "src/A.cs" },
    { status: "R100", file: "new/B.cs", origin: "old/B.cs" },
    { status: "A", file: "C.cs" },
  ]);
});

test("detectBase: origin/HEAD from a clone, probe when unset, none without a remote", async () => {
  const { clone, tmp } = scaffoldCloneWithBranch();
  try {
    // Feature branch has no upstream; clone sets origin/HEAD.
    assert.equal(await detectBase(clone), "origin/main");

    // origin/HEAD deleted (the locally-inited-repo shape): the probe finds origin/main.
    gitIn(clone)("remote", "set-head", "origin", "-d");
    assert.equal(await detectBase(clone), "origin/main");

    // Upstream, once set, wins.
    gitIn(clone)("branch", "-q", "--set-upstream-to", "origin/main", "feature");
    assert.equal(await detectBase(clone), "origin/main");

    // No remote at all: no base.
    const lone = path.join(tmp, "lone");
    fs.mkdirSync(lone);
    gitIn(lone)("init", "-q", "-b", "main");
    assert.equal(await detectBase(lone), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("committedDiffFiles: three-dot excludes drift committed on the base", async () => {
  const { origin, clone, tmp } = scaffoldCloneWithBranch();
  try {
    // Drift on origin/main after the fork point must not appear in the branch diff.
    const og = gitIn(origin);
    fs.writeFileSync(path.join(origin, "drift.txt"), "drift");
    og("add", "-A");
    og("commit", "-qm", "drift on main");
    gitIn(clone)("fetch", "-q", "origin");

    assert.deepEqual(await committedDiffFiles(clone, "origin/main"), ["a.txt"]);

    // A ref with no shared history degrades to empty, not an error.
    assert.deepEqual(await committedDiffFiles(clone, "no-such-ref"), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cliChangedFiles: default = branch commits ∪ dirty tree; --staged = index only", async () => {
  const { clone, tmp } = scaffoldCloneWithBranch();
  try {
    fs.writeFileSync(path.join(clone, "b.txt"), "b-dirty");
    fs.writeFileSync(path.join(clone, "untracked.txt"), "new");

    const byName = (a: string, b: string) => a.localeCompare(b);
    // Default: committed edit (a.txt) + dirty (b.txt) + untracked.
    assert.deepEqual((await cliChangedFiles(clone, {})).sort(byName), [
      "a.txt",
      "b.txt",
      "untracked.txt",
    ]);

    // --staged: only what's in the index — no branch commits, no dirty files.
    gitIn(clone)("add", "b.txt");
    assert.deepEqual(await cliChangedFiles(clone, { staged: true }), ["b.txt"]);

    // Explicit --base keeps committed ∪ dirty semantics.
    assert.deepEqual((await cliChangedFiles(clone, { base: "origin/main" })).sort(byName), [
      "a.txt",
      "b.txt",
      "untracked.txt",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cliChangedFiles: rename origins from committed diffs feed selection", async () => {
  const { clone, tmp } = scaffoldCloneWithBranch();
  try {
    const cg = gitIn(clone);
    cg("mv", "b.txt", "renamed.txt");
    cg("commit", "-qm", "rename b");
    const files = (await cliChangedFiles(clone, {})).sort((a, b) => a.localeCompare(b));
    assert.deepEqual(files, ["a.txt", "b.txt", "renamed.txt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
