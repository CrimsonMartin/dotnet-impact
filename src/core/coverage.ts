import { XMLParser } from "fast-xml-parser";
import * as fs from "fs";
import * as path from "path";
import { classFilter, exec } from "./util";

export interface ClassCoverageResult {
  classFqn: string;
  /** Repo-relative source files (forward slashes) executed by this class's tests. */
  files: string[];
  passed: boolean;
  output: string;
}

/**
 * Preferred: Microsoft.CodeCoverage (ships inside Microsoft.NET.Test.Sdk) —
 * block-level instrumentation, far lower overhead than Coverlet's
 * per-sequence-point probes. Fallback: coverlet.collector, for test projects
 * where the MS collector is unavailable.
 */
export const COLLECTOR_MS = "Code Coverage;Format=cobertura";
export const COLLECTOR_COVERLET = "XPlat Code Coverage";
/** Collector that worked for this session; resolved on first successful run. */
let resolvedCollector: string | null = null;

/** Collector to try first: whichever worked before, else the MS collector. */
export function preferredCollector(): string {
  return resolvedCollector ?? COLLECTOR_MS;
}

/** Record which collector produced a report, so later runs skip the probe. */
export function noteWorkingCollector(collector: string): void {
  if (resolvedCollector === null) resolvedCollector = collector;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Runsettings restricting instrumentation to first-party assemblies (derived
 * from the project graph — no user configuration). Third-party/NuGet modules
 * are never useful to the impact map, and skipping them cuts both
 * instrumentation time and report size. Carries configuration for both
 * collectors; each reads only its own section.
 */
export function buildRunsettings(assemblyNames: string[]): string {
  const modulePaths = assemblyNames
    .map((n) => `          <ModulePath>.*[/\\\\]${escapeXml(escapeRegex(n))}\\.(dll|exe)$</ModulePath>`)
    .join("\n");
  const coverletInclude = assemblyNames.map((n) => `[${escapeXml(n)}]*`).join(",");
  return `<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <DataCollectionRunSettings>
    <DataCollectors>
      <DataCollector friendlyName="Code Coverage">
        <Configuration>
          <Format>cobertura</Format>
          <CodeCoverage>
            <ModulePaths>
              <Include>
${modulePaths}
              </Include>
            </ModulePaths>
          </CodeCoverage>
        </Configuration>
      </DataCollector>
      <DataCollector friendlyName="XPlat Code Coverage">
        <Configuration>
          <Include>${coverletInclude}</Include>
        </Configuration>
      </DataCollector>
    </DataCollectors>
  </DataCollectionRunSettings>
</RunSettings>
`;
}

/**
 * Run one test class with coverage collection and return the set of source
 * files its tests execute. Collects from disposable copies of each built
 * target framework's output; the shadow's live assemblies stay untouched.
 */
export async function collectClassCoverage(
  shadowDir: string,
  csproj: string,
  testDlls: string[],
  classFqn: string,
  signal?: AbortSignal,
  settingsFile?: string
): Promise<ClassCoverageResult> {
  const resultsRoot = path.join(shadowDir, ".impact-results");
  fs.mkdirSync(resultsRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(resultsRoot, "refresh-"));
  const files = new Set<string>();
  let passed = testDlls.length > 0;
  let output = "";
  try {
    // Collectors can rewrite assemblies in place, corrupting metadata that
    // foreground hot-patch hosts have memory-mapped even after restoration.
    // Run each TFM from a full output copy, just like the warm pipeline.
    for (const [index, dll] of testDlls.entries()) {
      if (signal?.aborted) break;
      // Project-based dotnet test supplies collector/adapter paths through
      // MSBuild. Preserve them when running copied DLLs directly; otherwise
      // Microsoft.CodeCoverage (which lives in NuGet, not bin/) disappears.
      // NuGet imports in multi-targeted projects are conditional on the TFM.
      const tfm = path.dirname(dll).split(path.sep).reverse()
        .find((part) => /^net(?:standard|coreapp)?\d+(?:\.\d+)*(?:-[a-z][a-z0-9.]*)?$/i.test(part));
      const metadata = await exec(
            "dotnet",
            ["msbuild", csproj,
              ...(tfm ? [`-p:TargetFramework=${tfm}`] : []),
              "-getProperty:TraceDataCollectorDirectoryPath,VSTestTestAdapterPath"],
            shadowDir,
            60_000,
            signal
          );
      const adapterPaths: string[] = [];
      if (metadata?.code === 0) {
        const properties = JSON.parse(metadata.stdout).Properties;
        for (const key of ["TraceDataCollectorDirectoryPath", "VSTestTestAdapterPath"]) {
          if (properties?.[key]) adapterPaths.push(properties[key]);
        }
      }
      const copyDir = path.join(scratch, "bin", String(index));
      const resultsDir = path.join(scratch, "results", String(index));
      const run = (collector: string) => {
        // A failed collector may leave instrumented files behind. Give the
        // fallback collector a fresh copy too; never share links to live DLLs.
        fs.rmSync(copyDir, { recursive: true, force: true });
        fs.cpSync(path.dirname(dll), copyDir, { recursive: true, dereference: true });
        fs.rmSync(resultsDir, { recursive: true, force: true });
        fs.mkdirSync(resultsDir, { recursive: true });
        return exec(
          "dotnet",
          [
            "test",
            path.join(copyDir, path.basename(dll)),
            "--filter",
            classFilter([classFqn]),
            "--collect",
            collector,
            ...(adapterPaths.length > 0 ? ["--test-adapter-path", adapterPaths.join(";")] : []),
            "--results-directory",
            resultsDir,
            ...(settingsFile ? ["--settings", settingsFile] : []),
            "--nologo",
            "--verbosity",
            "quiet",
          ],
          shadowDir,
          10 * 60 * 1000,
          signal
        );
      };

      const first = preferredCollector();
      let res = await run(first);
      let reports = findCoberturaFiles(resultsDir);
      // No report: try Coverlet when the MS collector is unavailable.
      if (reports.length === 0 && first === COLLECTOR_MS && !signal?.aborted) {
        res = await run(COLLECTOR_COVERLET);
        reports = findCoberturaFiles(resultsDir);
        if (reports.length > 0) noteWorkingCollector(COLLECTOR_COVERLET);
      } else if (reports.length > 0) {
        noteWorkingCollector(first);
      }
      for (const cobertura of reports) {
        for (const f of parseCoberturaHitFiles(cobertura, shadowDir)) files.add(f);
      }
      passed = passed && res.code === 0;
      output += res.stdout + res.stderr;
    }
    return { classFqn, files: [...files].sort(), passed: passed && !signal?.aborted, output };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function findCoberturaFiles(dir: string): string[] {
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
      // Coverlet emits coverage.cobertura.xml; MS Code Coverage emits <name>.cobertura.xml.
      else if (e.name.toLowerCase().endsWith(".cobertura.xml")) out.push(p);
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

/**
 * Extract per-line hit counts from a Cobertura report, keyed by
 * shadow-root-relative forward-slash path (absolute for files outside the
 * shadow, e.g. generated/SDK sources — callers skip those). A file's lines can
 * be split across several <class> elements (partials, nested types); the same
 * line reported twice is the same execution counted per class, so overlaps
 * take the max, not the sum.
 */
export function parseCoberturaLineHits(
  coberturaPath: string,
  shadowDir: string
): Map<string, Map<number, number>> {
  const xml = fs.readFileSync(coberturaPath, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    isArray: (name) => ["source", "package", "class", "line"].includes(name),
  });
  const doc = parser.parse(xml);
  const coverage = doc?.coverage;
  const out = new Map<string, Map<number, number>>();
  if (!coverage) return out;

  const sources: string[] = (coverage.sources?.source ?? []).map((s: unknown) => String(s));
  for (const pkg of coverage.packages?.package ?? []) {
    for (const cls of pkg?.classes?.class ?? []) {
      const filename: string = cls["@_filename"] ?? "";
      if (!filename) continue;
      const file = resolveSourceFile(filename, sources, shadowDir);
      let byLine = out.get(file);
      if (!byLine) out.set(file, (byLine = new Map()));
      for (const l of cls?.lines?.line ?? []) {
        const line = Number(l["@_number"] ?? 0);
        if (line <= 0) continue;
        const hits = Number(l["@_hits"] ?? 0);
        byLine.set(line, Math.max(byLine.get(line) ?? 0, hits));
      }
    }
  }
  return out;
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
