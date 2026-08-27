import * as fs from "fs";
import * as path from "path";
import { cacheDirFor } from "./util";

/** A lock this old is presumed leaked even if its pid can't be probed. */
const STALE_MS = 15 * 60 * 1000;

function isStale(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > STALE_MS) return true;
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false; // holder is alive
    } catch (e) {
      // ESRCH: dead. EPERM: alive but not ours — keep waiting.
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false; // raced with a release; retry the acquire
  }
}

/**
 * Cross-process mutual exclusion for the shadow worktree, for concurrent CLI
 * invocations (lint-staged parallelizes hook commands). CLI-only: the
 * extension serializes its own runs internally and its behavior is pinned.
 * Returns a release function, or null when the lock is still held at the
 * deadline — callers in hook contexts skip with exit 0 rather than block.
 */
export async function acquireShadowLock(
  repoRoot: string,
  waitMs = 10_000
): Promise<(() => void) | null> {
  const dir = cacheDirFor(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "shadow.lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
      };
    } catch {
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
