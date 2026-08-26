import { XMLParser } from "fast-xml-parser";
import * as fs from "fs";
import * as path from "path";
import { exec } from "./util";

export interface ClassCoverageResult {
  classFqn: string;
  /** Repo-relative source files (forward slashes) executed by this class's tests. */
  files: string[];
  passed: boolean;
  output: string;
}

/**
 * Run one test class with Coverlet coverage collection and return the set of
 * source files its tests execute. Runs inside the shadow worktree.
 */
export async function collectClassCoverage(
  shadowDir: string,
  csproj: string,
  classFqn: string
): Promise<ClassCoverageResult> {
  const resultsDir = path.join(shadowDir, ".impact-results", classFqn.replace(/[^A-Za-z0-9_.]/g, "_"));
  fs.rmSync(resultsDir, { recursive: true, force: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  const res = await exec(
    "dotnet",
    [
      "test",
      csproj,
      "--filter",
      `FullyQualifiedName~${classFqn}`,
      "--collect",
      "XPlat Code Coverage",
      "--results-directory",
      resultsDir,
      "--nologo",
      "--no-restore",
      "--verbosity",
      "quiet",
    ],
    shadowDir
  );

  const files = new Set<string>();
  for (const cobertura of findCoberturaFiles(resultsDir)) {
    for (const f of parseCoberturaHitFiles(cobertura, shadowDir)) files.add(f);
  }
  fs.rmSync(resultsDir, { recursive: true, force: true });

  return {
    classFqn,
    files: [...files].sort(),
    passed: res.code === 0,
    output: res.stdout + res.stderr,
  };
}

function findCoberturaFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "coverage.cobertura.xml") out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Extract source files with at least one executed line from a Cobertura report,
 * as shadow-root-relative forward-slash paths.
 */
export function parseCoberturaHitFiles(coberturaPath: string, shadowDir: string): string[] {
  const xml = fs.readFileSync(coberturaPath, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    isArray: (name) => ["source", "package", "class", "line"].includes(name),
  });
  const doc = parser.parse(xml);
  const coverage = doc?.coverage;
  if (!coverage) return [];

  const sources: string[] = (coverage.sources?.source ?? []).map((s: unknown) => String(s));
  const files = new Set<string>();

  const packages = coverage.packages?.package ?? [];
  for (const pkg of packages) {
    const classes = pkg?.classes?.class ?? [];
    for (const cls of classes) {
      const filename: string = cls["@_filename"] ?? "";
      if (!filename) continue;
      const lines = cls?.lines?.line ?? [];
      const hit = lines.some((l: Record<string, string>) => Number(l["@_hits"] ?? 0) > 0);
      if (!hit) continue;
      files.add(resolveSourceFile(filename, sources, shadowDir));
    }
  }
  return [...files];
}

function resolveSourceFile(filename: string, sources: string[], shadowDir: string): string {
  let abs = filename;
  if (!path.isAbsolute(filename)) {
    const base = sources.find((s) => fs.existsSync(path.join(s, filename))) ?? shadowDir;
    abs = path.join(base, filename);
  }
  const rel = path.relative(shadowDir, abs);
  // Files outside the shadow (SDK, generated) keep their absolute path; we ignore those at query time.
  return (rel.startsWith("..") ? abs : rel).split(path.sep).join("/");
}
