import * as path from "path";

/**
 * A compiler/build diagnostic parsed from msbuild console output. Positions
 * are 0-based (msbuild prints 1-based; the parser subtracts). Project-level
 * diagnostics without a source span (NU/MSB/NETSDK codes) carry zeroed positions.
 */
export interface BuildDiagnostic {
  file: string;
  startLine: number;
  startCol: number;
  endLine?: number;
  endCol?: number;
  severity: "error" | "warning";
  code: string;
  message: string;
  /** The csproj msbuild appended in brackets, when present. */
  project?: string;
}

/**
 * Canonical span form: `File.cs(12,34): error CS1002: msg [proj.csproj]`,
 * optionally with a 4-tuple span `(l1,c1,l2,c2)`. The lazy file group binds
 * the LAST parenthesized digit tuple, so Windows paths containing parens
 * (`C:\Program Files (x86)\...`) parse whole — the `(x86)` group fails the
 * digit match and the engine extends the path instead.
 */
const SPAN_RE =
  /^\s*(.+?)\((\d+),(\d+)(?:,(\d+),(\d+))?\)\s*:\s*(error|warning)\s+([A-Z]+\d+)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?\s*$/;

/** Project-level form without a span: `proj.csproj : error NU1105: msg [proj]`. */
const NOSPAN_RE =
  /^\s*(\S(?:.*?\S)?)\s*:\s*(error|warning)\s+([A-Z]+\d+)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?\s*$/;

/**
 * Parse msbuild console output into diagnostics, deduped: msbuild repeats
 * every error in its trailing summary block, and multi-TFM builds repeat per
 * target framework. Relative file paths resolve against `cwd` (the build's
 * working directory) when given.
 */
export function parseMsbuildOutput(text: string, cwd?: string): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: BuildDiagnostic) => {
    const key = [d.file, d.startLine, d.startCol, d.code, d.message].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  const resolve = (file: string) => (cwd && !path.isAbsolute(file) ? path.resolve(cwd, file) : file);

  for (const line of text.split(/\r?\n/)) {
    let m = SPAN_RE.exec(line);
    if (m) {
      push({
        file: resolve(m[1]),
        startLine: parseInt(m[2], 10) - 1,
        startCol: parseInt(m[3], 10) - 1,
        endLine: m[4] ? parseInt(m[4], 10) - 1 : undefined,
        endCol: m[5] ? parseInt(m[5], 10) - 1 : undefined,
        severity: m[6] as "error" | "warning",
        code: m[7],
        message: m[8],
        project: m[9],
      });
      continue;
    }
    m = NOSPAN_RE.exec(line);
    if (m) {
      push({
        file: resolve(m[1]),
        startLine: 0,
        startCol: 0,
        severity: m[2] as "error" | "warning",
        code: m[3],
        message: m[4],
        project: m[5],
      });
    }
  }
  return out;
}

/**
 * Map a file path from the shadow worktree back into the real repo. Prefix
 * comparison is case-insensitive (Windows drive-letter casing varies) and
 * separator-agnostic; a path not under `shadowDir` passes through unchanged.
 */
export function mapShadowToRepo(file: string, shadowDir: string, repoRoot: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(file);
  const s = norm(shadowDir);
  if (f.toLowerCase() === s.toLowerCase()) return repoRoot;
  if (!f.toLowerCase().startsWith(s.toLowerCase() + "/")) return file;
  return path.join(repoRoot, f.slice(s.length + 1));
}
