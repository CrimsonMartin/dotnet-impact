import * as fs from "fs";
import * as path from "path";
import { cacheDirFor, git, parseStatusZ, StatusEntry } from "./util";

export interface Shadow {
  repoRoot: string;
  dir: string;
}

const OVERLAY_MANIFEST = "overlay-manifest.json";

/**
 * Ensure a detached git worktree exists for the repo and matches its current HEAD.
 * The worktree lives in the user cache dir, sharing the object store with the real repo.
 */
export async function ensureShadow(repoRoot: string): Promise<Shadow> {
  const cache = cacheDirFor(repoRoot);
  const dir = path.join(cache, "shadow");
  fs.mkdirSync(cache, { recursive: true });

  const head = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

  if (!fs.existsSync(path.join(dir, ".git"))) {
    // A stale registration can linger if the folder was deleted manually.
    await git(repoRoot, ["worktree", "prune"]);
    const res = await git(repoRoot, ["worktree", "add", "--detach", dir, head]);
    if (res.code !== 0) {
      throw new Error(`git worktree add failed: ${res.stderr || res.stdout}`);
    }
  } else {
    const shadowHead = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    if (shadowHead !== head) {
      // Drop any previous overlay before moving; checkout -f resets tracked files.
      const res = await git(dir, ["checkout", "--detach", "-f", head]);
      if (res.code !== 0) {
        throw new Error(`shadow checkout failed: ${res.stderr || res.stdout}`);
      }
    }
  }
  return { repoRoot, dir };
}

async function dirtyFiles(repoRoot: string): Promise<StatusEntry[]> {
  const res = await git(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  return parseStatusZ(res.stdout);
}

/**
 * Mirror the real repo's uncommitted state into the shadow worktree:
 * copy dirty/untracked files over, delete deleted ones, and restore files
 * that were overlaid previously but are clean again now.
 */
export async function syncOverlay(shadow: Shadow): Promise<string[]> {
  const manifestPath = path.join(cacheDirFor(shadow.repoRoot), OVERLAY_MANIFEST);
  let previous: string[] = [];
  try {
    previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    /* first run */
  }

  const dirty = await dirtyFiles(shadow.repoRoot);
  const current = new Set<string>();

  for (const { status, file, origin } of dirty) {
    // A rename's origin no longer exists in the real tree; remove it in the shadow.
    if (origin && status.includes("R")) {
      try {
        fs.rmSync(path.join(shadow.dir, origin), { force: true });
      } catch {
        /* ignore */
      }
      current.add(origin);
    }
    // Skip anything inside our own cache, and gitignored noise never appears here.
    const src = path.join(shadow.repoRoot, file);
    const dst = path.join(shadow.dir, file);
    if (status.includes("D") || !fs.existsSync(src)) {
      try {
        fs.rmSync(dst, { force: true });
      } catch {
        /* ignore */
      }
      current.add(file);
      continue;
    }
    current.add(file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  // Files overlaid before but clean now: restore committed content in the shadow.
  // Tracked and untracked must be handled separately — one untracked pathspec
  // makes `git checkout -- <list>` fail wholesale, restoring nothing.
  const toRestore = previous.filter((f) => !current.has(f));
  if (toRestore.length > 0) {
    const tracked: string[] = [];
    for (const f of toRestore) {
      const res = await git(shadow.dir, ["ls-files", "--error-unmatch", f]);
      if (res.code === 0) {
        tracked.push(f);
      } else {
        // Untracked file copied earlier and since deleted in the real repo.
        try {
          fs.rmSync(path.join(shadow.dir, f), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    if (tracked.length > 0) await git(shadow.dir, ["checkout", "-f", "--", ...tracked]);
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify([...current], null, 2));
  return [...current];
}
