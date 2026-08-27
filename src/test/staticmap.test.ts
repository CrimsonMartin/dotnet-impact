import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ProjectInfo } from "../core/projects";
import { findBuiltDll } from "../core/staticmap";

function scaffold(): { root: string; repoRoot: string; info: ProjectInfo } {
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

test("findBuiltDll: finds the project's dll under bin", () => {
  const { root, repoRoot, info } = scaffold();
  const p = put(root, "src/Lib/bin/Debug/net10.0/Lib.dll");
  assert.equal(findBuiltDll(root, info, repoRoot), p);
});

test("findBuiltDll: ref/ metadata-only assemblies are never selected", () => {
  const { root, repoRoot, info } = scaffold();
  put(root, "src/Lib/bin/Debug/net10.0/ref/Lib.dll");
  assert.equal(findBuiltDll(root, info, repoRoot), undefined);
});

test("findBuiltDll: newest dll wins across TFM dirs, case-insensitively", () => {
  const { root, repoRoot, info } = scaffold();
  put(root, "src/Lib/bin/Debug/net8.0/Lib.dll", -60_000);
  const newest = put(root, "src/Lib/bin/Debug/net10.0/LIB.DLL", 60_000);
  assert.equal(findBuiltDll(root, info, repoRoot), newest);
});

test("findBuiltDll: missing bin dir yields undefined", () => {
  const { root, repoRoot, info } = scaffold();
  assert.equal(findBuiltDll(root, info, repoRoot), undefined);
});
