import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DiagnosticsEvent, Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * The runner's diagnostics stream: a failing minimal build parses its msbuild
 * output into a `set` event with file paths mapped from the shadow worktree
 * back to the real repo; the next clean build of the project re-parses its
 * output, so warnings survive a green build while errors retire; a silent
 * clean build replaces everything with an empty set.
 */

/** Tmp git repo: leaf classlib L, test project T referencing it (same as stale-stamp). */
function scaffoldGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-diag-test-"));
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

test("minimalBuild: failing msbuild output becomes a repo-mapped set event, then a clear", async () => {
  const root = scaffoldGitRepo();
  try {
    const runner = new Runner(root);
    const events: DiagnosticsEvent[] = [];
    const logs: string[] = [];
    runner.diagnosticsSink = (e) => events.push(e);
    runner.logSink = (m) => logs.push(m);

    let mode: "fail" | "warn" | "clean" = "fail";
    runner.msbuildImpl = async (csprojShadowAbs) => {
      const name = path.basename(csprojShadowAbs, ".csproj");
      const thing = path.join(path.dirname(csprojShadowAbs), "Thing.cs");
      const warn = `${thing}(3,9): warning CS0168: unused variable [${csprojShadowAbs}]`;
      if (mode === "fail" && name === "L") {
        // Canned compiler output as msbuild prints it: shadow paths, a
        // summary-block repeat of the same error, and one warning.
        const line = `${thing}(12,34): error CS1002: ; expected [${csprojShadowAbs}]`;
        return { code: 1, stdout: ["Build FAILED.", line, warn, "", line].join("\n"), stderr: "" };
      }
      const outDir = path.join(path.dirname(csprojShadowAbs), "bin", "Debug", "net10.0");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${name}.dll`), "");
      // A clean exit still prints warnings; the runner must not drop them.
      const stdout = mode === "warn" && name === "L" ? warn : "";
      return { code: 0, stdout, stderr: "" };
    };
    const testRels = new Set(["tests/T/T.csproj"]);
    const minimalBuild = (): Promise<boolean> =>
      (runner as unknown as { minimalBuild(rels: Set<string>): Promise<boolean> }).minimalBuild(
        testRels
      );

    await runner.prepare();

    // Run 1: L fails to compile — minimal build reports and bails.
    assert.equal(await minimalBuild(), false, "failing build unexpectedly succeeded");
    const sets = events.filter((e) => e.kind === "set");
    assert.equal(sets.length, 1);
    assert.equal(sets[0].projectRel, "src/L/L.csproj");
    const diags = (sets[0] as Extract<DiagnosticsEvent, { kind: "set" }>).diagnostics;
    assert.equal(diags.length, 2, "summary repeat was not deduped");
    const err = diags.find((d) => d.severity === "error")!;
    assert.equal(err.code, "CS1002");
    assert.equal(err.file, path.join(root, "src", "L", "Thing.cs"), "shadow path not repo-mapped");
    assert.equal(err.startLine, 11);
    assert.equal(err.startCol, 33);
    assert.equal(diags.find((d) => d.severity === "warning")?.code, "CS0168");
    // The raw compiler output must reach the log instead of vanishing.
    assert.ok(
      logs.some((m) => m.includes("CS1002")),
      "raw build output was discarded from the log"
    );

    // Run 2: the error is fixed but the warning remains — a green build must
    // retire the error while the warning survives.
    mode = "warn";
    events.length = 0;
    assert.equal(await minimalBuild(), true, "clean minimal build failed");
    const setFor = (rel: string) =>
      events.find((e): e is Extract<DiagnosticsEvent, { kind: "set" }> => e.kind === "set" && e.projectRel === rel);
    const warnSet = setFor("src/L/L.csproj");
    assert.ok(warnSet, "green build with warnings emitted no set for L");
    assert.deepEqual(
      warnSet.diagnostics.map((d) => [d.severity, d.code]),
      [["warning", "CS0168"]],
      "warning must survive a green build with the error gone"
    );
    assert.equal(setFor("tests/T/T.csproj")?.diagnostics.length, 0, "silent project must reset to empty");

    // Run 3: warning fixed too (a real edit, or the stamps would rightly
    // skip the rebuild and keep the still-valid warning) — the next silent
    // build empties L as well.
    mode = "clean";
    events.length = 0;
    fs.writeFileSync(path.join(root, "src", "L", "Thing.cs"), "class Thing { int x; }");
    await runner.prepare();
    assert.equal(await minimalBuild(), true, "clean minimal build failed");
    assert.equal(setFor("src/L/L.csproj")?.diagnostics.length, 0, "fixed warning did not retire");
  } finally {
    cleanup(root);
  }
});
