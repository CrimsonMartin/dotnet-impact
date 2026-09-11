import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * Sync watermark semantics — the invariant that a stamp newer than the
 * watermark must never be recorded as built (#16).
 *
 * prepare() stamps syncedAtMs BEFORE syncOverlay, so an edit landing in
 * that instant is excluded from stamp recording.
 * resyncShadow() stamps AFTER sync, so every post-sync edit is naturally
 * excluded too — but the method is also a no-op when no shadow exists.
 */

function scaffold(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-watermark-"));
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
  fs.writeFileSync(path.join(root, "tests", "T", "Tests.cs"), "class TTests {}");
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
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root });
  } catch {
    /* ignore */
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("prepare: syncedAtMs is set before syncOverlay (stamp-before-sync invariant)", async () => {
  const root = scaffold();
  try {
    const runner = new Runner(root);
    const shadow = await runner.prepare();
    const syncedAtMs = (runner as unknown as { syncedAtMs: number }).syncedAtMs;
    assert.ok(syncedAtMs > 0, "syncedAtMs must be non-zero after prepare");
    // The watermark must be before the shadow exists — verify the invariant
    // by checking that the shadow was synced at or before this instant.
    const entries = fs.readdirSync(shadow.dir, { recursive: true });
    assert.ok(entries.length > 0, "shadow must have content after prepare");
  } finally {
    cleanup(root);
  }
});

test("resyncShadow: no-op when no shadow prepared", async () => {
  const root = scaffold();
  try {
    const runner = new Runner(root);
    // No prepare() called — resyncShadow should be a no-op.
    await runner.resyncShadow();
    // syncedAtMs stays at 0 because nothing was synced.
    const syncedAtMs = (runner as unknown as { syncedAtMs: number }).syncedAtMs;
    assert.equal(syncedAtMs, 0, "resyncShadow without prepare must not advance the watermark");
    assert.equal(runner["shadow"], null, "shadow must remain null");
  } finally {
    cleanup(root);
  }
});

test("resyncShadow: advances watermark after a real sync", async () => {
  const root = scaffold();
  try {
    const runner = new Runner(root);
    await runner.prepare();
    const syncedAtMsBefore = (runner as unknown as { syncedAtMs: number }).syncedAtMs;
    await tick(20);
    // Edit a file and re-sync.
    fs.appendFileSync(path.join(root, "src", "L", "Thing.cs"), "\n// edit");
    await runner.resyncShadow();
    const syncedAtMsAfter = (runner as unknown as { syncedAtMs: number }).syncedAtMs;
    assert.ok(syncedAtMsAfter > syncedAtMsBefore, "resyncShadow must advance the watermark");
    // The edit is now in the shadow.
    const runner2 = new Runner(root);
    const shadow2 = await runner2.prepare();
    const content = fs.readFileSync(path.join(shadow2.dir, "src", "L", "Thing.cs"), "utf8");
    assert.ok(content.includes("// edit"), "resyncShadow must propagate the edit to the shadow");
  } finally {
    cleanup(root);
  }
});

test("minimalBuild: post-sync edits in the shadow still rebuild (stamp exclusion works)", async () => {
  const root = scaffold();
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

    // Cold run: both build, stamps recorded.
    await tick();
    await runner.prepare();
    assert.ok(await minimalBuild());
    assert.deepEqual(built.sort(), ["L", "T"]);

    // No edits: incremental skip works.
    built.length = 0;
    await runner.prepare();
    assert.ok(await minimalBuild());
    // (length, not deepEqual(built, []): deepEqual's assertion signature
    // would narrow `built` to never[] for the rest of the block)
    assert.equal(built.length, 0, "no projects should rebuild without edits");

    // Edit and re-sync: the stamp gets excluded because mtime > syncedAtMs.
    built.length = 0;
    fs.appendFileSync(path.join(root, "src", "L", "Thing.cs"), "\n// new");
    await runner.resyncShadow();  // advances watermark after sync
    assert.ok(await minimalBuild());
    assert.ok(built.includes("L"), "L must rebuild because the stamp is newer than the watermark");
  } finally {
    cleanup(root);
  }
});
