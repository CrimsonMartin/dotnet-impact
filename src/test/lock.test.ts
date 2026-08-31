import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { acquireShadowLock, waitForShadowLock, withShadowLock } from "../core/lock";
import { cacheDirFor } from "../core/util";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "impact-lock-test-"));
}

function cleanup(root: string): void {
  fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

/** A live, probeable pid that is NOT this process: a sleeping child. */
function foreignLivePid(): { pid: number; kill: () => void } {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  return { pid: child.pid!, kill: () => child.kill() };
}

test("acquireShadowLock: exclusive across processes, reusable after release, steals dead-pid locks", async () => {
  const root = tmpRepo();
  const holder = foreignLivePid();
  try {
    const lockFile = path.join(cacheDirFor(root), "shadow.lock");

    // Held by a live FOREIGN process: acquire times out (never stolen).
    fs.mkdirSync(cacheDirFor(root), { recursive: true });
    fs.writeFileSync(lockFile, String(holder.pid));
    assert.equal(await acquireShadowLock(root, 400), null);

    // ...even when the foreign holder's lock is old: liveness beats age
    // (a cold build-map can legitimately run past any cutoff).
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    assert.equal(await acquireShadowLock(root, 400), null);
    fs.rmSync(lockFile, { force: true });

    // Free: acquire works, release frees it for the next acquire.
    const release = await acquireShadowLock(root, 100);
    assert.notEqual(release, null);
    release!();
    const again = await acquireShadowLock(root, 100);
    assert.notEqual(again, null);
    again!();

    // A lock left by a dead process is reclaimed immediately.
    fs.writeFileSync(lockFile, "999999999");
    const stolen = await acquireShadowLock(root, 100);
    assert.notEqual(stolen, null);
    stolen!();
  } finally {
    holder.kill();
    cleanup(root);
  }
});

test("acquireShadowLock: re-entrant within a process; file freed only after the last release", async () => {
  const root = tmpRepo();
  try {
    const lockFile = path.join(cacheDirFor(root), "shadow.lock");

    // The extension overlaps its own shadow phases (a save-triggered run
    // while a map build holds the shadow); those intra-process overlaps
    // predate the lock and must stay legal.
    const outer = await acquireShadowLock(root, 100);
    assert.notEqual(outer, null);
    const inner = await acquireShadowLock(root, 100);
    assert.notEqual(inner, null, "same-process acquire must re-enter, not deadlock");

    outer!();
    assert.ok(fs.existsSync(lockFile), "outer release with inner still active must keep the file");
    // A foreign process must still see it held mid-overlap.
    inner!();
    assert.ok(!fs.existsSync(lockFile), "last release must free the file");

    // Double release is inert: it must not free a later holder's lock.
    const a = await acquireShadowLock(root, 100);
    a!();
    const b = await acquireShadowLock(root, 100);
    a!(); // stale second release of the earlier acquisition
    assert.ok(fs.existsSync(lockFile), "stale double release must not free the new holder");
    b!();
    assert.ok(!fs.existsSync(lockFile));
  } finally {
    cleanup(root);
  }
});

test("waitForShadowLock: abort and deadline return null without acquiring; withShadowLock releases on throw", async () => {
  const root = tmpRepo();
  const holder = foreignLivePid();
  try {
    const lockFile = path.join(cacheDirFor(root), "shadow.lock");
    fs.mkdirSync(cacheDirFor(root), { recursive: true });
    fs.writeFileSync(lockFile, String(holder.pid));

    // Deadline against a live foreign holder.
    assert.equal(await waitForShadowLock(root, { waitMs: 500 }), null);

    // Abort mid-wait.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const t0 = Date.now();
    assert.equal(await waitForShadowLock(root, { signal: ctrl.signal, waitMs: 60_000 }), null);
    assert.ok(Date.now() - t0 < 5_000, "abort must end the wait promptly");
    fs.rmSync(lockFile, { force: true });

    // withShadowLock: fn ran under the lock; the lock is released on throw.
    const ok = await withShadowLock(root, { waitMs: 1_000 }, async () => {
      assert.ok(fs.existsSync(lockFile), "fn must run while the lock is held");
      return 42;
    });
    assert.deepEqual(ok, { ran: true, value: 42 });
    await assert.rejects(
      withShadowLock(root, { waitMs: 1_000 }, async () => {
        throw new Error("boom");
      })
    );
    assert.ok(!fs.existsSync(lockFile), "lock must be released after fn throws");

    // Skipped fn: returns null, fn never ran.
    fs.writeFileSync(lockFile, String(holder.pid));
    let ran = false;
    assert.equal(
      await withShadowLock(root, { waitMs: 300 }, async () => {
        ran = true;
      }),
      null
    );
    assert.equal(ran, false);
    fs.rmSync(lockFile, { force: true });
  } finally {
    holder.kill();
    cleanup(root);
  }
});
