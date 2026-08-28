import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findBuiltDll, findBuiltDlls } from "../core/staticmap";
import { ProjectInfo } from "../core/projects";

/**
 * Regression: the bin-walk's try/catch guarded only readdirSync, so a dll
 * deleted between the directory listing and its statSync (MSBuild replacing
 * outputs mid-walk during a parallel build) threw ENOENT out of the run
 * pipeline. The window is tiny on Linux and wide on Windows (delete+copy
 * output replacement); a stress harness reproduced it on both. The walk must
 * treat a vanished file as absent, not fatal.
 */

function scaffold(): { root: string; info: ProjectInfo; outDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-dllwalk-"));
  const dir = path.join(root, "tests", "Lib.Tests");
  const outDir = path.join(dir, "bin", "Debug", "net8.0");
  fs.mkdirSync(outDir, { recursive: true });
  const info: ProjectInfo = {
    name: "Lib.Tests",
    csproj: path.join(dir, "Lib.Tests.csproj"),
    dir,
    assemblyName: "Lib.Tests",
    isTestProject: true,
    references: [],
  };
  return { root, info, outDir };
}

/** Make statSync throw ENOENT for `victim`, as if it vanished after readdir. */
function withVanishing<T>(victim: string, run: () => T): T {
  // The TS namespace import is read-only; patch the raw CJS module object,
  // which is the same instance staticmap.ts sees.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mutableFs = require("fs") as { statSync: unknown };
  const real = fs.statSync;
  mutableFs.statSync = (p: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(p)) === path.resolve(victim)) {
      const err = new Error(`ENOENT: no such file or directory, stat '${p}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
  };
  try {
    return run();
  } finally {
    mutableFs.statSync = real;
  }
}

test("findBuiltDll treats a dll deleted between readdir and stat as absent", () => {
  const { root, info, outDir } = scaffold();
  try {
    const dll = path.join(outDir, "Lib.Tests.dll");
    fs.writeFileSync(dll, "x");
    const found = withVanishing(dll, () => findBuiltDll(root, info, root));
    assert.equal(found, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findBuiltDlls keeps the surviving TFM when another vanishes mid-walk", () => {
  const { root, info, outDir } = scaffold();
  try {
    const net8 = path.join(outDir, "Lib.Tests.dll");
    const net9Dir = path.join(path.dirname(outDir), "net9.0");
    fs.mkdirSync(net9Dir, { recursive: true });
    const net9 = path.join(net9Dir, "Lib.Tests.dll");
    fs.writeFileSync(net8, "x");
    fs.writeFileSync(net9, "x");
    const found = withVanishing(net8, () => findBuiltDlls(root, info, root));
    assert.deepEqual(found, [net9]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
