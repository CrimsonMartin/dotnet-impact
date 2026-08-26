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
}

export interface ProjectGraph {
  root: string;
  projects: Map<string, ProjectInfo>; // key: absolute csproj path (normalized)
  /** reverse edges: csproj -> projects that reference it */
  referencedBy: Map<string, Set<string>>;
}

const SKIP_DIRS = new Set(["bin", "obj", "node_modules", ".git", ".vs", ".impact", "packages"]);

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
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(path.join(dir, e.name));
      } else if (e.name.endsWith(".csproj")) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
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
      isTestProject: TEST_PACKAGE_RE.test(content),
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
