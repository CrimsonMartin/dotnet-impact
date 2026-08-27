import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { cacheDirFor } from "../core/util";
import { ensureShadow, syncOverlay } from "../core/worktree";

function scaffoldGitRepo(): { root: string; git: (...a: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-wt-test-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  fs.writeFileSync(path.join(root, "a.txt"), "committed-a");
  fs.writeFileSync(path.join(root, "b.txt"), "committed-b");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { root, git };
}

function cleanup(root: string): void {
  fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root });
  } catch {
    /* ignore */
  }
}

const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

test("syncOverlay: modify, untracked, delete, rename, and restore-on-clean", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    const shadow = await ensureShadow(root);
    assert.equal(read(shadow.dir, "a.txt"), "committed-a");

    // Dirty modification is copied in; untracked file appears.
    fs.writeFileSync(path.join(root, "a.txt"), "edited-a");
    fs.writeFileSync(path.join(root, "new.txt"), "untracked");
    await syncOverlay(shadow);
    assert.equal(read(shadow.dir, "a.txt"), "edited-a");
    assert.equal(read(shadow.dir, "new.txt"), "untracked");

    // Revert to clean: shadow shows committed content again; untracked removed.
    fs.writeFileSync(path.join(root, "a.txt"), "committed-a");
    git("checkout", "--", "a.txt");
    fs.rmSync(path.join(root, "new.txt"));
    await syncOverlay(shadow);
    assert.equal(read(shadow.dir, "a.txt"), "committed-a");
    assert.equal(fs.existsSync(path.join(shadow.dir, "new.txt")), false);

    // Deletion propagates.
    fs.rmSync(path.join(root, "b.txt"));
    await syncOverlay(shadow);
    assert.equal(fs.existsSync(path.join(shadow.dir, "b.txt")), false);
    git("checkout", "--", "b.txt");
    await syncOverlay(shadow);
    assert.equal(read(shadow.dir, "b.txt"), "committed-b");

    // Staged rename: new path exists in shadow, origin removed.
    git("mv", "b.txt", "c.txt");
    await syncOverlay(shadow);
    assert.equal(read(shadow.dir, "c.txt"), "committed-b");
    assert.equal(fs.existsSync(path.join(shadow.dir, "b.txt")), false);
    git("mv", "c.txt", "b.txt");
    await syncOverlay(shadow);
    assert.equal(read(shadow.dir, "b.txt"), "committed-b");
  } finally {
    cleanup(root);
  }
});

test("ensureShadow: follows HEAD moves with a forced checkout", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    const s1 = await ensureShadow(root);
    assert.equal(read(s1.dir, "a.txt"), "committed-a");

    fs.writeFileSync(path.join(root, "a.txt"), "v2");
    git("add", "-A");
    git("commit", "-qm", "v2");
    const s2 = await ensureShadow(root);
    assert.equal(s2.dir, s1.dir);
    assert.equal(read(s2.dir, "a.txt"), "v2");
  } finally {
    cleanup(root);
  }
});
