import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

/**
 * Windows dll-lock contract for the delta service (shipped broken through
 * v0.1.8): ModuleMetadata.CreateFromFile memory-maps the baseline dll and
 * holds the handle for the baseline's lifetime, so the next rebuild of that
 * project failed with MSB3021 "file is locked by .NET Host".
 *
 * A behavioral test can't catch a regression here — Linux mmap doesn't lock
 * files, which is exactly why the bug shipped — so this pins the source
 * contract instead: baselines must load from an in-memory image, never from
 * a file mapping.
 */
test("helper-deltas loads baselines from memory, never a file mapping", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../helper-deltas/Program.cs"),
    "utf8"
  );
  assert.match(src, /ModuleMetadata\.CreateFromImage/);
  assert.doesNotMatch(
    src,
    /ModuleMetadata\.CreateFromFile/,
    "CreateFromFile keeps the dll handle open and blocks Windows rebuilds (MSB3021)"
  );
});
