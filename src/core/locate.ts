import * as fs from "fs";
import * as path from "path";

export interface SourceLocation {
  file: string; // absolute path
  line: number; // 0-based
}

const SKIP_DIRS = new Set(["bin", "obj", "node_modules", ".git"]);
const NAMESPACE_RE = /^\s*namespace\s+([A-Za-z_][\w.]*)/;
const CLASS_RE = /^\s*(?:\[[^\]]*\]\s*)*(?:public|internal|protected|private)?\s*(?:sealed\s+|abstract\s+|static\s+|partial\s+)*class\s+([A-Za-z_]\w*)/;

/**
 * Scan a project directory for class declarations and return
 * fully-qualified-name -> source location. Regex-based: handles file-scoped and
 * block namespaces, attributes, and modifiers; ignores nested-class dotting
 * subtleties (rare in test code).
 */
export function locateClasses(projectDir: string): Map<string, SourceLocation> {
  const out = new Map<string, SourceLocation>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(p);
      } else if (e.name.endsWith(".cs")) {
        scanFile(p, out);
      }
    }
  };
  walk(projectDir);
  return out;
}

function scanFile(file: string, out: Map<string, SourceLocation>): void {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  let ns = "";
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const nsMatch = lines[i].match(NAMESPACE_RE);
    if (nsMatch) {
      ns = nsMatch[1];
      continue;
    }
    const clsMatch = lines[i].match(CLASS_RE);
    if (clsMatch) {
      const fqn = ns ? `${ns}.${clsMatch[1]}` : clsMatch[1];
      if (!out.has(fqn)) out.set(fqn, { file, line: i });
    }
  }
}

/** Find the declaration line of a method within a source file (0-based), if present. */
export function locateMethod(file: string, methodName: string): number | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const re = new RegExp(`^\\s*(?:public|internal|protected|private).*\\b${escapeRe(methodName)}\\s*[(<]`);
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
