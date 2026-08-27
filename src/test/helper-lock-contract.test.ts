import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

/**
 * Windows dll-lock contracts (the bug class shipped through v0.1.8: a held
 * baseline-module handle made every rebuild fail with MSB3021 after ten
 * seconds of copy retries).
 *
 * With the EnC engine, Roslyn's DebuggingSession itself reads the baseline
 * module from disk and may hold it mapped, so two source contracts guard the
 * mitigation instead:
 * - the helper must never open module metadata straight off a file
 *   (ModuleMetadata.CreateFromFile memory-maps and locks it), and
 * - the runner must drop all hot-patch sessions (hotpatch.reset()) before
 *   any Windows build, releasing whatever the engine holds.
 */
test("delta service never maps module metadata from a file", () => {
  for (const dir of ["helper-deltas", "helper-enc"]) {
    const abs = path.join(__dirname, "../../", dir);
    for (const f of fs.readdirSync(abs).filter((n) => n.endsWith(".cs"))) {
      const src = fs.readFileSync(path.join(abs, f), "utf8");
      assert.doesNotMatch(
        src,
        /ModuleMetadata\.CreateFromFile/,
        `${dir}/${f}: CreateFromFile keeps the dll handle open and blocks Windows rebuilds (MSB3021)`
      );
    }
  }
});

test("runner resets hot-patch sessions before Windows builds", () => {
  // Compiled tests run from out/test; the contract is on the TS source.
  const runnerSrc = fs.readFileSync(path.join(__dirname, "../../src/core/runner.ts"), "utf8");
  const win32Blocks = runnerSrc.split('process.platform === "win32"').slice(1);
  assert.ok(win32Blocks.length >= 2, "expected win32 release blocks in runner");
  for (const block of win32Blocks) {
    assert.match(
      block.slice(0, 400),
      /hotpatch\?\.reset\(\)/,
      "every Windows pre-build release must also reset the hot-patch engine (it holds baseline module handles)"
    );
  }
});
