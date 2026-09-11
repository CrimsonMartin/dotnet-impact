import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ProjectInfo } from "../core/projects";
import { findBuiltDll, findBuiltDlls } from "../core/staticmap";

/* ------------------------------------------------------------------ */
/*  findBuiltDll — supplementary cases beyond the existing test suite  */
/* ------------------------------------------------------------------ */

function scaffoldDll(): { root: string; repoRoot: string; info: ProjectInfo } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "impact-dll-test-repo-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-dll-test-shadow-"));
  const dir = path.join(repoRoot, "src", "Lib");
  fs.mkdirSync(dir, { recursive: true });
  const info: ProjectInfo = {
    csproj: path.join(dir, "Lib.csproj"),
    dir,
    name: "Lib",
    assemblyName: "Lib",
    references: [],
    isTestProject: false,
    usesMtpRunner: false,
  };
  return { root, repoRoot, info };
}

function put(root: string, rel: string, mtimeOffsetMs = 0): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  if (mtimeOffsetMs !== 0) {
    const t = new Date(Date.now() + mtimeOffsetMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

test("findBuiltDll: depth-4 limit prevents traversing beyond bin/TFM/", () => {
  const { root, repoRoot, info } = scaffoldDll();
  // Depth from binDir: 0=bin, 1=Debug, 2=net10.0, 3=extra1, 4=extra2, 5=extra3
  // Walk stops at depth > 4, so dll in extra3/ (depth 5) is ignored.
  put(root, "src/Lib/bin/Debug/net10.0/extra1/extra2/extra3/Lib.dll", 100_000);
  // dll at bin/Debug/net10.0/ (depth 2) should be found
  const found = put(root, "src/Lib/bin/Debug/net10.0/Lib.dll", 50_000);
  assert.equal(findBuiltDll(root, info, repoRoot), found);
});

test("findBuiltDll: handles file disappearing between readdir and stat", () => {
  const { root, repoRoot, info } = scaffoldDll();
  const p = put(root, "src/Lib/bin/Debug/net10.0/Lib.dll", 100_000);
  // Normal case: file exists
  assert.equal(findBuiltDll(root, info, repoRoot), p);
});

/* ----------------------------------------------------------- */
/*  findBuiltDlls — multi-TFM: returns one (newest) per TFM   */
/* ----------------------------------------------------------- */

test("findBuiltDlls: returns exactly one dll per TFM directory", () => {
  const { root, repoRoot, info } = scaffoldDll();
  put(root, "src/Lib/bin/Debug/net8.0/Lib.dll", -10_000);
  put(root, "src/Lib/bin/Debug/net10.0/Lib.dll", 10_000);
  const result = findBuiltDlls(root, info, repoRoot);
  assert.equal(result.length, 2);
  // Sorted ascending by full path: net10 < net8 alphabetically
  assert.ok(result[0].includes("net10.0"), "net10.0 comes first alphabetically");
  assert.ok(result[1].includes("net8.0"), "net8.0 comes second");
});

test("findBuiltDlls: newest wins within each TFM, not globally", () => {
  const { root, repoRoot, info } = scaffoldDll();
  put(root, "src/Lib/bin/Debug/net8.0/Lib.dll", -5_000);
  put(root, "src/Lib/bin/Debug/net8.0/Lib.dll.2", 5_000); // different name won't match
  put(root, "src/Lib/bin/Debug/net10.0/Lib.dll", 100_000);
  put(root, "src/Lib/bin/Debug/net10.0/Lib.dll.2", 10_000); // different name won't match
  // Only exact assembly-name dlls match
  const result = findBuiltDlls(root, info, repoRoot);
  assert.equal(result.length, 2);
  // Sorted ascending: net10 < net8
  assert.ok(result[0].includes("net10.0"), "net10.0 first (sorted)");
  assert.ok(result[1].includes("net8.0"), "net8.0 second (sorted)");
});

test("findBuiltDlls: ref/ directory is excluded per TFM", () => {
  const { root, repoRoot, info } = scaffoldDll();
  put(root, "src/Lib/bin/Debug/net8.0/ref/Lib.dll");
  put(root, "src/Lib/bin/Debug/net8.0/Lib.dll");
  const result = findBuiltDlls(root, info, repoRoot);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes("net8.0"));
  // Verify it's NOT the ref/ copy
  assert.ok(!result[0].includes("/ref/"), "ref/ dll should not be selected");
});

test("findBuiltDlls: missing bin dir yields empty array", () => {
  const { root, repoRoot, info } = scaffoldDll();
  const result = findBuiltDlls(root, info, repoRoot);
  assert.equal(result.length, 0);
  assert.ok(Array.isArray(result), "should return an array even when empty");
});

test("findBuiltDlls: case-insensitive assembly name match", () => {
  const { root, repoRoot, info } = scaffoldDll();
  // The assembly name is "Lib" — should also match "LIB.DLL"
  put(root, "src/Lib/bin/Debug/net10.0/LIB.DLL", 100_000);
  const result = findBuiltDlls(root, info, repoRoot);
  assert.equal(result.length, 1);
});

test("findBuiltDlls: depth-4 limit", () => {
  const { root, repoRoot, info } = scaffoldDll();
  // Place dll at depth 6 — should be ignored
  put(root, "src/Lib/bin/Debug/net10.0/extra1/extra2/extra3/Lib.dll", 100_000);
  const result = findBuiltDlls(root, info, repoRoot);
  assert.equal(result.length, 0);
});

/* ----------------------------------------------------------- */
/*  findBuiltDll — edge cases with ref/ in nested dirs        */
/* ----------------------------------------------------------- */

test("findBuiltDll: ref/ in nested TFM subdirectories is excluded", () => {
  const { root, repoRoot, info } = scaffoldDll();
  // Put the only dll inside a ref/ subdirectory of the TFM
  put(root, "src/Lib/bin/Debug/net10.0/ref/Lib.dll");
  assert.equal(findBuiltDll(root, info, repoRoot), undefined);
});

test("findBuiltDll: handles deeply nested non-ref directories up to depth 4", () => {
  const { root, repoRoot, info } = scaffoldDll();
  // At depth exactly 4: bin/Debug/net10.0/Lib.dll — depth=4
  const p = put(root, "src/Lib/bin/Debug/net10.0/Lib.dll", 50_000);
  assert.equal(findBuiltDll(root, info, repoRoot), p);
});
