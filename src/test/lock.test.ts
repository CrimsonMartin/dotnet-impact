import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { acquireShadowLock } from "../core/lock";
import { cacheDirFor } from "../core/util";

test("acquireShadowLock: exclusive while held, reusable after release, steals dead-pid locks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-lock-test-"));
  try {
    const release = await acquireShadowLock(root, 100);
    assert.notEqual(release, null);

    // Second acquire times out while the first holds it.
    assert.equal(await acquireShadowLock(root, 400), null);

    release!();
    const again = await acquireShadowLock(root, 100);
    assert.notEqual(again, null);
    again!();

    // A lock left by a dead process is reclaimed immediately.
    const lockFile = path.join(cacheDirFor(root), "shadow.lock");
    fs.writeFileSync(lockFile, "999999999");
    const stolen = await acquireShadowLock(root, 100);
    assert.notEqual(stolen, null);
    stolen!();
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
