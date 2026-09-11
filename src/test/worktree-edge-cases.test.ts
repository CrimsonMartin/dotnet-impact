import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { cacheDirFor } from "../core/util";
import { ensureShadow, syncOverlay, isOverlaySkippedPath } from "../core/worktree";

function scaffoldGitRepo(): { root: string; git: (...a: string[]) => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-wt-edge-"));
  const git = (...args: string[]): void => {
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
  };
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

test("isOverlaySkippedPath: bin/ segments are skipped", () => {
  assert.equal(isOverlaySkippedPath("src/MyApp/bin/Debug/net10.0/output.dll"), true);
  assert.equal(isOverlaySkippedPath("bin/output.dll"), true);
  assert.equal(isOverlaySkippedPath("obj/project.assets.json"), true);
});

test("isOverlaySkippedPath: case-insensitive segment matching", () => {
  assert.equal(isOverlaySkippedPath("src/MyApp/BIN/Debug/output.dll"), true);
  assert.equal(isOverlaySkippedPath("src/MyApp/Obj/cache.json"), true);
});

test("isOverlaySkippedPath: source files are NOT skipped", () => {
  assert.equal(isOverlaySkippedPath("src/MyApp/Program.cs"), false);
  assert.equal(isOverlaySkippedPath("src/MyApp/Models/User.cs"), false);
  assert.equal(isOverlaySkippedPath("tests/MyApp.Tests/Test.cs"), false);
});

test("isOverlaySkippedPath: node_modules, .git, .vs, .impact are skipped", () => {
  assert.equal(isOverlaySkippedPath("node_modules/pkg/index.js"), true);
  assert.equal(isOverlaySkippedPath(".git/config"), true);
  assert.equal(isOverlaySkippedPath(".vs/MyApp/slnx.sqlite"), true);
  assert.equal(isOverlaySkippedPath(".impact/map.json"), true);
  assert.equal(isOverlaySkippedPath("packages/pkg.1.0/lib/net10.0/pkg.dll"), true);
});

test("isOverlaySkippedPath: nested skip segments are caught", () => {
  assert.equal(isOverlaySkippedPath("a/bin/b/c/output.dll"), true);
  assert.equal(isOverlaySkippedPath("a/obj/b/c/output.dll"), true);
});

test("ensureShadow: fails outside a git repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-wt-nogit-"));
  try {
    await assert.rejects(
      ensureShadow(root),
      /git worktree add failed/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureShadow: works on a repo with no prior shadow", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    fs.writeFileSync(path.join(root, "file.txt"), "content");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    // No shadow exists yet.
    assert.ok(!fs.existsSync(path.join(cacheDirFor(root), "shadow")));
    const shadow = await ensureShadow(root);
    assert.ok(fs.existsSync(shadow.dir), "shadow dir must exist");
    assert.ok(fs.existsSync(path.join(shadow.dir, ".git")), "shadow has its own .git");
    assert.equal(fs.readFileSync(path.join(shadow.dir, "file.txt"), "utf8"), "content");
  } finally {
    cleanup(root);
  }
});

test("syncOverlay: build outputs are never overlaid (bin/ and obj/)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-wt-edge-buildout-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "Lib.cs"), "namespace Lib;");
    fs.writeFileSync(path.join(root, "Lib.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    // Source files: committed.
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
    git("add", "src/", "Lib.csproj");
    git("commit", "-qm", "init");

    // Build outputs: untracked, so overlay WOULD copy them if not for skip.
    fs.mkdirSync(path.join(root, "bin", "Debug"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "Debug", "Lib.dll"), "binary");
    fs.mkdirSync(path.join(root, "obj"), { recursive: true });
    fs.writeFileSync(path.join(root, "obj", "project.assets.json"), "{}");

    const shadow = await ensureShadow(root);
    await syncOverlay(shadow);

    // Build outputs must NOT appear in the shadow.
    assert.ok(
      !fs.existsSync(path.join(shadow.dir, "bin")),
      "bin/ must not be in shadow"
    );
    assert.ok(
      !fs.existsSync(path.join(shadow.dir, "obj")),
      "obj/ must not be in shadow"
    );
    // But source files must be there.
    assert.equal(
      fs.readFileSync(path.join(shadow.dir, "src", "Lib.cs"), "utf8"),
      "namespace Lib;"
    );
  } finally {
    cleanup(root);
  }
});

test("syncOverlay: multiple calls are idempotent", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    fs.writeFileSync(path.join(root, "a.txt"), "v1");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");

    const shadow = await ensureShadow(root);

    // First sync.
    await syncOverlay(shadow);
    assert.equal(fs.readFileSync(path.join(shadow.dir, "a.txt"), "utf8"), "v1");

    // Second sync, no changes.
    await syncOverlay(shadow);
    assert.equal(fs.readFileSync(path.join(shadow.dir, "a.txt"), "utf8"), "v1");

    // Third sync, after a change.
    fs.writeFileSync(path.join(root, "a.txt"), "v2");
    await syncOverlay(shadow);
    assert.equal(fs.readFileSync(path.join(shadow.dir, "a.txt"), "utf8"), "v2");
  } finally {
    cleanup(root);
  }
});

test("syncOverlay: files with spaces in names are handled", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    fs.writeFileSync(path.join(root, "my file.txt"), "content");
    fs.writeFileSync(path.join(root, "another file.txt"), "another");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");

    const shadow = await ensureShadow(root);
    await syncOverlay(shadow);

    assert.equal(
      fs.readFileSync(path.join(shadow.dir, "my file.txt"), "utf8"),
      "content"
    );
    assert.equal(
      fs.readFileSync(path.join(shadow.dir, "another file.txt"), "utf8"),
      "another"
    );
  } finally {
    cleanup(root);
  }
});

test("syncOverlay: deeply nested directory structures", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    const deepPath = path.join("a", "b", "c", "d", "e", "f", "deep.txt");
    fs.mkdirSync(path.join(root, "a", "b", "c", "d", "e", "f"), { recursive: true });
    fs.writeFileSync(path.join(root, deepPath), "deep");

    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");

    const shadow = await ensureShadow(root);
    await syncOverlay(shadow);

    assert.equal(
      fs.readFileSync(path.join(shadow.dir, deepPath), "utf8"),
      "deep"
    );
  } finally {
    cleanup(root);
  }
});

test("syncOverlay: uncommitted changes are properly restored to clean", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    fs.writeFileSync(path.join(root, "a.txt"), "committed");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");

    const shadow = await ensureShadow(root);
    await syncOverlay(shadow);
    assert.equal(fs.readFileSync(path.join(shadow.dir, "a.txt"), "utf8"), "committed");

    // Make a dirty change.
    fs.writeFileSync(path.join(root, "a.txt"), "dirty");
    await syncOverlay(shadow);
    assert.equal(fs.readFileSync(path.join(shadow.dir, "a.txt"), "utf8"), "dirty");

    // Revert to committed state.
    fs.writeFileSync(path.join(root, "a.txt"), "committed");
    await syncOverlay(shadow);
    assert.equal(fs.readFileSync(path.join(shadow.dir, "a.txt"), "utf8"), "committed");
  } finally {
    cleanup(root);
  }
});

test("syncOverlay: overlay-manifest.json is created and updated", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    fs.writeFileSync(path.join(root, "a.txt"), "v1");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");

    const shadow = await ensureShadow(root);

    // Before any sync, manifest doesn't exist.
    const manifestPath = path.join(cacheDirFor(root), "overlay-manifest.json");
    assert.ok(!fs.existsSync(manifestPath));

    // Create an untracked file — it should be overlaid and tracked in manifest.
    fs.writeFileSync(path.join(root, "untracked.txt"), "untracked");
    await syncOverlay(shadow);

    // After sync, manifest exists with the overlaid files.
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.ok(manifest.includes("untracked.txt"), "manifest should contain untracked.txt");
  } finally {
    cleanup(root);
  }
});

test("ensureShadow: shadow dir is reused (same dir returned for multiple calls)", async () => {
  const { root, git } = scaffoldGitRepo();
  try {
    const gitCmd = (...args: string[]) =>
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
    fs.writeFileSync(path.join(root, "a.txt"), "v1");
    gitCmd("init", "-q");
    gitCmd("add", "-A");
    gitCmd("commit", "-qm", "init");

    const s1 = await ensureShadow(root);
    const s2 = await ensureShadow(root);

    assert.equal(s1.dir, s2.dir, "ensureShadow should return the same dir");
  } finally {
    cleanup(root);
  }
});
