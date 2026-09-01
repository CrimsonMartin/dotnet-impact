import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface ProjectInfo {
  /** Absolute path to the .csproj (within whichever tree it was scanned from). */
  csproj: string;
  /** Directory containing the csproj. */
  dir: string;
  name: string;
  /** Output assembly name (<AssemblyName> override, else project name). */
  assemblyName: string;
  references: string[]; // absolute csproj paths
  isTestProject: boolean;
  /**
   * Test project running through Microsoft.Testing.Platform instead of
   * VSTest (#23): no vstest hosting, no TRX logger, no --list-tests output —
   * the runner routes these through the MTP app's own surfaces.
   */
  /**
   * Runs on Microsoft.Testing.Platform (adapter-less xunit v3, MSTest.Sdk,
   * or explicit MTP properties). Optional so synthetic graphs in tests and
   * future constructors default to the VSTest pipeline.
   */
  usesMtpRunner?: boolean;
}

export interface ProjectGraph {
  root: string;
  projects: Map<string, ProjectInfo>; // key: absolute csproj path (normalized)
  /** reverse edges: csproj -> projects that reference it */
  referencedBy: Map<string, Set<string>>;
}

const SKIP_DIRS = new Set(["bin", "obj", "node_modules", ".git", ".vs", ".impact", "packages"]);

/**
 * A subdirectory with its own `.git` entry (a directory for a nested clone, a
 * file for a worktree or submodule) is a different repository: its csproj
 * copies are not this repo's projects, and the shadow worktree never contains
 * its files, so anything found there could never build or run. Claude Code
 * keeps worktrees at `.claude/worktrees/<name>/` inside the repo — scanning
 * them produced one duplicate, forever-childless Test Explorer project node
 * per worktree.
 */
function isNestedRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

function findCsprojFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const p = path.join(dir, e.name);
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && !isNestedRepo(p)) walk(p);
      } else if (e.name.endsWith(".csproj")) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/** Property/package shapes that mark a csproj as MTP-native (no VSTest host). */
const MTP_PROPS_RE =
  /<(TestingPlatformDotnetTestSupport|UseMicrosoftTestingPlatformRunner|EnableMSTestRunner|EnableNUnitRunner|EnableAspireTestingPlatform)>\s*true\s*</i;
const MSTEST_SDK_RE = /Sdk\s*=\s*"MSTest\.Sdk[/"]/i;
const XUNIT_V3_RE = /PackageReference\s+Include\s*=\s*"xunit\.v3/i;
const VSTEST_ADAPTER_RE =
  /PackageReference\s+Include\s*=\s*"(xunit\.runner\.visualstudio|NUnit3TestAdapter|MSTest\.TestAdapter|Microsoft\.NET\.Test\.Sdk)"/i;

/**
 * True when the csproj runs its tests through Microsoft.Testing.Platform
 * INSTEAD of VSTest (#23). xunit.v3 with the VSTest adapter present stays on
 * the classic path (it hosts fine); without the adapter it is MTP-only.
 */
export function usesMtpRunner(csprojContent: string): boolean {
  if (MTP_PROPS_RE.test(csprojContent) || MSTEST_SDK_RE.test(csprojContent)) return true;
  return XUNIT_V3_RE.test(csprojContent) && !VSTEST_ADAPTER_RE.test(csprojContent);
}

const TEST_PACKAGE_RE =
  /PackageReference\s+Include\s*=\s*"(Microsoft\.NET\.Test\.Sdk|xunit[^"]*|NUnit[^"]*|MSTest[^"]*|Microsoft\.Testing\.Platform[^"]*)"/i;
const PROJECT_REF_RE = /ProjectReference\s+Include\s*=\s*"([^"]+)"/gi;

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

export function buildProjectGraph(root: string): ProjectGraph {
  const projects = new Map<string, ProjectInfo>();
  for (const csproj of findCsprojFiles(root)) {
    let content = "";
    try {
      content = fs.readFileSync(csproj, "utf8");
    } catch {
      continue;
    }
    const refs: string[] = [];
    for (const m of content.matchAll(PROJECT_REF_RE)) {
      const rel = m[1].split("\\").join(path.sep).split("/").join(path.sep);
      refs.push(path.resolve(path.dirname(csproj), rel));
    }
    const name = path.basename(csproj, ".csproj");
    const asmMatch = content.match(/<AssemblyName>([^<$]+)<\/AssemblyName>/i);
    projects.set(norm(csproj), {
      csproj,
      dir: path.dirname(csproj),
      name,
      assemblyName: asmMatch ? asmMatch[1].trim() : name,
      references: refs,
      isTestProject: TEST_PACKAGE_RE.test(content) || usesMtpRunner(content),
      usesMtpRunner: usesMtpRunner(content),
    });
  }

  const referencedBy = new Map<string, Set<string>>();
  for (const [key, p] of projects) {
    for (const ref of p.references) {
      const rk = norm(ref);
      if (!referencedBy.has(rk)) referencedBy.set(rk, new Set());
      referencedBy.get(rk)!.add(key);
    }
  }
  return { root, projects, referencedBy };
}

/** Find the project whose directory contains the given file (nearest ancestor wins). */
export function projectForFile(graph: ProjectGraph, file: string): ProjectInfo | undefined {
  const f = norm(file);
  let best: ProjectInfo | undefined;
  for (const p of graph.projects.values()) {
    const d = norm(p.dir) + path.sep;
    if (f.startsWith(d) && (!best || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

/** All test projects that (transitively) reference the project containing `file`. */
export function affectedTestProjects(graph: ProjectGraph, file: string): ProjectInfo[] {
  const start = projectForFile(graph, file);
  if (!start) return [...graph.projects.values()].filter((p) => p.isTestProject);
  const seen = new Set<string>([norm(start.csproj)]);
  const queue = [norm(start.csproj)];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const parent of graph.referencedBy.get(cur) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return [...seen]
    .map((k) => graph.projects.get(k)!)
    .filter((p) => p && p.isTestProject);
}

export function testProjects(graph: ProjectGraph): ProjectInfo[] {
  return [...graph.projects.values()].filter((p) => p.isTestProject);
}

const STAMP_FILE_RE = /\.(cs|csproj|props|targets|razor|cshtml|resx|config|json)$/i;

/**
 * Freshness stamp for a project INCLUDING everything it transitively
 * references — unchanged stamp means a rebuild would be a no-op.
 */
export function transitiveSourceStamp(
  graph: ProjectGraph,
  csprojAbs: string,
  memo: Map<string, string> = new Map()
): string {
  const key = path.resolve(csprojAbs).toLowerCase();
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  memo.set(key, ""); // cycle guard
  const info = graph.projects.get(key);
  if (!info) return "";
  const parts = [sourceStamp(info.dir)];
  for (const ref of [...info.references].sort()) {
    parts.push(transitiveSourceStamp(graph, ref, memo));
  }
  const stamp = parts.join("+");
  memo.set(key, stamp);
  return stamp;
}

/**
 * Freshness stamp for a project directory: newest source mtime + file count +
 * a digest of the relative paths. Count catches deletions; the path digest
 * catches moves — dragging a file into a subfolder preserves both its mtime
 * and the count, and a stamp blind to paths kept serving the pre-move FQNs
 * from the discovery cache (#17). Discovery can be skipped while the stamp holds.
 */
/**
 * The newest source mtime encoded in a sourceStamp(). Unparseable stamps
 * report Infinity — "newer than anything" — so callers treating post-sync
 * stamps as unproven never record garbage as built.
 */
export function stampNewestMs(stamp: string): number {
  const newest = Number(stamp.split(":")[1]);
  return Number.isFinite(newest) ? newest : Infinity;
}

export function sourceStamp(projectDir: string): string {
  let newest = 0;
  const rels: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const p = path.join(dir, e.name);
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && !isNestedRepo(p)) walk(p);
      } else if (STAMP_FILE_RE.test(e.name)) {
        const p = path.join(dir, e.name);
        rels.push(path.relative(projectDir, p).split(path.sep).join("/"));
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(projectDir);
  const digest = crypto.createHash("sha1").update(rels.sort().join("\n")).digest("hex").slice(0, 12);
  return `${rels.length}:${Math.round(newest)}:${digest}`;
}
