import { git, parseStatusZ } from "./util";

/**
 * CLI-only change selection. The extension's selection path
 * (Runner.changedFiles, save events) is pinned and must not change; everything
 * here is reached exclusively from cli.ts.
 */

export interface DiffEntry {
  /** Status letter(s) from `git diff --name-status`, e.g. "M", "A", "R100". */
  status: string;
  file: string;
  /** For renames/copies: the path the file came from. */
  origin?: string;
}

/**
 * Parse `git diff --name-status -z` output: NUL-separated records of
 * status, path — with rename/copy records carrying origin then destination.
 */
export function parseNameStatusZ(stdout: string): DiffEntry[] {
  const chunks = stdout.split("\0");
  const out: DiffEntry[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const status = chunks[i];
    if (!status) continue;
    if (status[0] === "R" || status[0] === "C") {
      const origin = chunks[++i];
      const file = chunks[++i];
      if (file) out.push({ status, file, origin });
    } else {
      const file = chunks[++i];
      if (file) out.push({ status, file });
    }
  }
  return out;
}

/**
 * Auto-detect the diff base for "what did this branch change":
 * the branch's upstream, else origin/HEAD, else probe origin/main and
 * origin/master (origin/HEAD only exists after a clone or an explicit
 * `git remote set-head`, so locally-inited repos need the probe).
 */
export async function detectBase(repoRoot: string): Promise<string | undefined> {
  const upstream = await git(repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream.code === 0 && upstream.stdout.trim()) return upstream.stdout.trim();
  const originHead = await git(repoRoot, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead.code === 0) {
    const ref = originHead.stdout.trim();
    if (ref && ref !== "origin/HEAD") return ref;
  }
  for (const ref of ["origin/main", "origin/master"]) {
    const probe = await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    if (probe.code === 0) return ref;
  }
  return undefined;
}

/**
 * Files the branch's commits changed: `base...HEAD` (three-dot — the diff of
 * merge-base(base, HEAD) against HEAD, so drift committed on base is excluded).
 * Rename origins are included: the old path's tests are still affected.
 * A failing diff (no merge base, unborn HEAD) degrades to an empty list.
 */
export async function committedDiffFiles(repoRoot: string, base: string): Promise<string[]> {
  const res = await git(repoRoot, ["diff", "--name-status", "-z", `${base}...HEAD`]);
  if (res.code !== 0) return [];
  const files: string[] = [];
  for (const e of parseNameStatusZ(res.stdout)) {
    files.push(e.file);
    if (e.origin) files.push(e.origin);
  }
  return files;
}

export interface CliSelection {
  /** Explicit base ref; overrides auto-detection. */
  base?: string;
  /** Index only — the tight pre-commit mode; skips base auto-detection. */
  staged?: boolean;
}

/**
 * The CLI changed-set (repo-relative paths):
 *   --staged            index only
 *   --base <ref>        ref...HEAD ∪ dirty tree (∪ index only, with --staged)
 *   (default)           auto-detected base...HEAD ∪ dirty tree
 * Every degradation (no remote, branch not ahead, detached HEAD without an
 * upstream) collapses to the dirty tree, i.e. Runner.changedFiles()'s default.
 */
export async function cliChangedFiles(repoRoot: string, opts: CliSelection): Promise<string[]> {
  const files = new Set<string>();
  const base = opts.base ?? (opts.staged ? undefined : await detectBase(repoRoot));
  if (base) for (const f of await committedDiffFiles(repoRoot, base)) files.add(f);
  if (opts.staged) {
    const res = await git(repoRoot, ["diff", "--name-status", "-z", "--cached"]);
    for (const e of parseNameStatusZ(res.stdout)) {
      files.add(e.file);
      if (e.origin) files.add(e.origin);
    }
  } else {
    const res = await git(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    for (const e of parseStatusZ(res.stdout)) {
      files.add(e.file);
      if (e.origin) files.add(e.origin);
    }
  }
  return [...files];
}
