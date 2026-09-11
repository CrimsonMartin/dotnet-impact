import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";
import type { DiagnosticsEvent } from "../core/runner";

/**
 * Runner.emitBuildDiagnostics() — test that diagnostics are correctly
 * emitted and cleared based on msbuild output parsing.
 *
 * These tests exercise: error/warning parsing, project file ownership
 * resolution via [proj] suffix, clearing stale diagnostics on clean builds,
 * and shadow-path mapping back to real repo paths.
 */

function makeRunnerForDiagnostics(root: string): Runner {
  const runner = new Runner(root);
  runner.logSink = () => {};
  runner.diagnosticsSink = () => {};
  return runner;
}

function diagnosticsEmitted(runner: Runner): Array<{ kind: string; projectRel: string; diagnostics: Array<{ file: string; line: number; column: number; severity: string; code: string; message: string }> }> {
  const collected: Array<{ kind: string; projectRel: string; diagnostics: Array<{ file: string; line: number; column: number; severity: string; code: string; message: string }> }> = [];
  (runner as unknown as { diagnosticsSink: (e: typeof collected[0]) => void }).diagnosticsSink = (e) => collected.push(e);
  return collected;
}

/**
 * Build a minimal shadow dir for shadow-path resolution tests.
 */
function makeShadowDir(root: string): string {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-shadow-"));
  // Create a fake shadow structure
  const shadowSrc = path.join(shadow, "src");
  const shadowT = path.join(shadowSrc, "T");
  fs.mkdirSync(shadowT, { recursive: true });
  fs.writeFileSync(path.join(shadowT, "Foo.cs"), "// fake");

  // Set up the runner's shadow
  const runner = makeRunnerForDiagnostics(root);
  (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };
  return shadow;
}

test("emitBuildDiagnostics: error output sets diagnostics for the built project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-dierr-"));
  try {
    const shadow = makeShadowDir(root);
    const runner = makeRunnerForDiagnostics(root);
    (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };

    const diags = diagnosticsEmitted(runner);
    const raw = "T.cs(5,10): error CS0103: The name 'x' does not exist in the current context [/repo/src/T/T.csproj]";
    (runner as unknown as { emitBuildDiagnostics: (rel: string, raw: string, alsoClear?: string[]) => void }).emitBuildDiagnostics("T.csproj", raw);

    const events = diags;
    assert.ok(events.length > 0, "should emit diagnostic events for errors");
    const ev = events[0];
    assert.equal(ev.kind, "set");
    assert.equal(ev.projectRel, "T.csproj");
    assert.ok(ev.diagnostics.length > 0, "should have parsed diagnostics");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("emitBuildDiagnostics: clean build (warnings only) sets diagnostics for the built project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-diwarn-"));
  try {
    const shadow = makeShadowDir(root);
    const runner = makeRunnerForDiagnostics(root);
    (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };

    const diags = diagnosticsEmitted(runner);
    const raw = "T.cs(5,10): warning CS0168: The variable 'x' is declared but never used [/repo/src/T/T.csproj]";
    (runner as unknown as { emitBuildDiagnostics: (rel: string, raw: string, alsoClear?: string[]) => void }).emitBuildDiagnostics("T.csproj", raw);

    const events = diags;
    assert.ok(events.length > 0, "should emit diagnostic events for warnings");
    const ev = events[0];
    assert.equal(ev.kind, "set");
    assert.ok(ev.diagnostics.some(d => d.severity === "warning" || d.severity === "Warning"));
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("emitBuildDiagnostics: empty output clears stale diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-diclear-"));
  try {
    const shadow = makeShadowDir(root);
    const runner = makeRunnerForDiagnostics(root);
    (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };

    const diags = diagnosticsEmitted(runner);
    const raw = "";
    (runner as unknown as { emitBuildDiagnostics: (rel: string, raw: string, alsoClear?: string[]) => void }).emitBuildDiagnostics("T.csproj", raw);

    const events = diags;
    assert.ok(events.length > 0, "should emit a clearing event even for empty output");
    const ev = events[0];
    assert.equal(ev.kind, "set");
    assert.deepEqual(ev.diagnostics, [], "empty output → no diagnostics");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("emitBuildDiagnostics: alsoClear retires stale diagnostics for closure projects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-diclosure-"));
  try {
    const shadow = makeShadowDir(root);
    const runner = makeRunnerForDiagnostics(root);
    (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };

    const diags = diagnosticsEmitted(runner);
    // AlsoClear should cause empty diagnostics to be set for the listed projects
    (runner as unknown as { emitBuildDiagnostics: (rel: string, raw: string, alsoClear?: string[]) => void }).emitBuildDiagnostics("T.csproj", "", ["Main.csproj"]);

    const events = diags;
    // Should have at least one set event for T.csproj and one for Main.csproj (the alsoClear)
    const projectRels = new Set(events.map((e) => e.projectRel));
    assert.ok(projectRels.has("Main.csproj"), "alsoClear project should get a set event");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("emitBuildDiagnostics: [proj] suffix matches project by basename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-diproj-"));
  try {
    const shadow = makeShadowDir(root);
    const runner = makeRunnerForDiagnostics(root);
    (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };

    const diags = diagnosticsEmitted(runner);
    // Use a [proj] suffix to name the project
    const raw = "Foo.cs(5,10): error CS0103: x not found [T.csproj]";
    (runner as unknown as { emitBuildDiagnostics: (rel: string, raw: string, alsoClear?: string[]) => void }).emitBuildDiagnostics("T.csproj", raw);

    const events = diags;
    assert.ok(events.length > 0);
    const ev = events[0];
    assert.equal(ev.projectRel, "T.csproj");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("emitBuildDiagnostics: file owned by another project maps to owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-diother-"));
  try {
    const shadow = makeShadowDir(root);
    const runner = makeRunnerForDiagnostics(root);
    (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };

    // Create a SourceFile structure so projectForFile can match
    const srcPath = path.join(shadow, "src", "T", "Shared.cs");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "// shared code");

    const diags = diagnosticsEmitted(runner);
    // Build a diagnostic from a file that lives under the shadow's T project
    const raw = "src/T/Shared.cs(5,10): error CS0103: x not found [/repo/src/T/T.csproj]";
    (runner as unknown as { emitBuildDiagnostics: (rel: string, raw: string, alsoClear?: string[]) => void }).emitBuildDiagnostics("T.csproj", raw);

    const events = diags;
    assert.ok(events.length > 0);
    // The diagnostic should be filed under the project that owns the file
    assert.equal(events[0].projectRel, "T.csproj");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("emitBuildDiagnostics: shadow path mapped to repo root (absolute)", () => {
  // mapShadowToRepo returns path.join(repoRoot, relativePath), which produces
  // an absolute path when repoRoot is absolute. This is the actual behavior.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-dishtorepo-"));
  try {
    const shadow = root;
    const srcDir = path.join(shadow, "src", "T");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "Foo.cs"), "// code");

    const runner = makeRunnerForDiagnostics(root);
    (runner as unknown as { shadow: { dir: string } | null }).shadow = { dir: shadow };

    const diags = diagnosticsEmitted(runner);
    const shadowFile = path.join(shadow, "src", "T", "Foo.cs");
    const raw = `${shadowFile}(5,10): warning CS0168: x [/repo/src/T/T.csproj]`;
    (runner as unknown as { emitBuildDiagnostics: (rel: string, raw: string, alsoClear?: string[]) => void }).emitBuildDiagnostics("T.csproj", raw);

    const events = diags;
    assert.ok(events.length > 0);
    const diagFile = events[0].diagnostics[0]?.file ?? "";
    // mapShadowToRepo returns path.join(repoRoot, relative) → absolute path
    assert.ok(path.isAbsolute(diagFile), `diagnostic file is absolute, got: ${diagFile}`);
    assert.ok(diagFile.includes("src/T/Foo.cs"), `should contain src/T/Foo.cs, got: ${diagFile}`);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
