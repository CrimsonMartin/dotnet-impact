import * as fs from "fs";
import * as path from "path";
import { cacheDirFor } from "./util";

/** Age-based reclaim applies only when the holder pid can't be probed. */
const STALE_MS = 15 * 60 * 1000;

function isStale(file: string): boolean {
  try {
    // Pid liveness first: a legitimately long-running holder (cold build-map
    // on a large repo) must never lose its lock to an age cutoff.
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false; // holder is alive, however old the lock
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; // dead
        // EPERM etc.: exists but unprobeable — fall through to the age check.
      }
    }
    const st = fs.statSync(file);
    return Date.now() - st.mtimeMs > STALE_MS;
  } catch {
    return false; // raced with a release; retry the acquire
  }
}

/**
 * This process's re-entrancy depth per lock file. The extension overlaps its
 * own shadow phases deliberately (a save-triggered run while a map build
 * holds the shadow); those intra-process overlaps predate the lock and stay
 * legal — only the OUTERMOST acquisition owns the file, inner ones share it.
 */
const ownDepth = new Map<string, number>();

/**
 * Cross-process mutual exclusion for the shadow worktree: concurrent CLI
 * invocations (lint-staged parallelizes hook commands) and, since #8, the
 * extension's shadow-mutating phases against those CLI runs. Re-entrant
 * within a process (see ownDepth). Returns a release function, or null when
 * another process still holds the lock at the deadline — hook contexts skip
 * with exit 0 rather than block.
 */
export async function acquireShadowLock(
  repoRoot: string,
  waitMs = 10_000
): Promise<(() => void) | null> {
  const dir = cacheDirFor(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "shadow.lock");
  const deadline = Date.now() + waitMs;
  const enter = (): (() => void) => {
    ownDepth.set(file, (ownDepth.get(file) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; // double release must not free a later holder
      released = true;
      const depth = (ownDepth.get(file) ?? 1) - 1;
      if (depth > 0) {
        ownDepth.set(file, depth);
        return;
      }
      ownDepth.delete(file);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    };
  };
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return enter();
    } catch {
      try {
        if (Number(fs.readFileSync(file, "utf8")) === process.pid) return enter();
      } catch {
        /* raced with a release; fall through and retry */
      }
      if (isStale(file)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Extension-side acquisition (#8): wait for the shadow lock in abortable
 * slices. Returns the release function, or null when the signal aborts or the
 * deadline passes first — callers treat that as "superseded" or "shadow busy,
 * retry later". A crashed holder can't block forever: acquireShadowLock
 * reclaims dead-pid and stale locks.
 */
export async function waitForShadowLock(
  repoRoot: string,
  opts: { signal?: AbortSignal; waitMs?: number } = {}
): Promise<(() => void) | null> {
  const deadline = Date.now() + (opts.waitMs ?? Number.POSITIVE_INFINITY);
  for (;;) {
    if (opts.signal?.aborted || Date.now() > deadline) return null;
    const release = await acquireShadowLock(
      repoRoot,
      Math.min(1000, Math.max(1, deadline - Date.now()))
    );
    if (release) return release;
  }
}

/**
 * Convenience wrapper over waitForShadowLock: run fn under the lock, always
 * release. Returns null WITHOUT running fn when the lock wasn't acquired.
 */
export async function withShadowLock<T>(
  repoRoot: string,
  opts: { signal?: AbortSignal; waitMs?: number },
  fn: () => Promise<T>
): Promise<{ ran: true; value: T } | null> {
  const release = await waitForShadowLock(repoRoot, opts);
  if (!release) return null;
  try {
    return { ran: true, value: await fn() };
  } finally {
    release();
  }
}
