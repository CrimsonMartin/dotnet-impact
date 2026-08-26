import { XMLParser } from "fast-xml-parser";
import * as fs from "fs";
import * as path from "path";
import { collectClassCoverage } from "./coverage";
import { discoverTestClasses } from "./discover";
import {
  affectedTestProjects,
  buildProjectGraph,
  ProjectGraph,
  ProjectInfo,
  testProjects,
} from "./projects";
import { ImpactMap } from "./map";
import { exec, git, toRepoRelative } from "./util";
import { ensureShadow, Shadow, syncOverlay } from "./worktree";

export interface TestOutcome {
  classFqn: string;
  method: string;
  passed: boolean;
  message?: string;
  durationMs?: number;
}

export interface RunResult {
  ok: boolean;
  ranClasses: string[];
  fallbackProjects: string[];
  outcomes: TestOutcome[];
  output: string;
}

export interface AffectedSet {
  classes: string[];
  /** Projects to run in full because changed files aren't in the map yet. */
  fallbackProjects: ProjectInfo[];
  changedFiles: string[];
}

export class Runner {
  readonly map: ImpactMap;
  private shadow: Shadow | null = null;
  private graph: ProjectGraph | null = null;

  constructor(readonly repoRoot: string) {
    this.map = new ImpactMap(repoRoot);
  }

  async prepare(): Promise<Shadow> {
    this.shadow = await ensureShadow(this.repoRoot);
    await syncOverlay(this.shadow);
    this.graph = buildProjectGraph(this.repoRoot);
    return this.shadow;
  }

  projectGraph(): ProjectGraph {
    if (!this.graph) this.graph = buildProjectGraph(this.repoRoot);
    return this.graph;
  }

  private shadowPath(repoFile: string): string {
    if (!this.shadow) throw new Error("prepare() not called");
    return path.join(this.shadow.dir, toRepoRelative(this.repoRoot, repoFile));
  }

  /** Changed files vs a git base ref plus uncommitted changes (repo-relative). */
  async changedFiles(base?: string, stagedOnly = false): Promise<string[]> {
    const files = new Set<string>();
    if (base) {
      const res = await git(this.repoRoot, ["diff", "--name-only", base]);
      for (const f of res.stdout.split(/\r?\n/)) if (f.trim()) files.add(f.trim());
    }
    const flags = stagedOnly ? ["diff", "--name-only", "--cached"] : ["status", "--porcelain"];
    const res = await git(this.repoRoot, flags);
    for (const line of res.stdout.split(/\r?\n/)) {
      const f = stagedOnly ? line.trim() : line.slice(3).trim();
      if (f) files.add(f);
    }
    return [...files];
  }

  computeAffected(changedFiles: string[]): AffectedSet {
    const graph = this.projectGraph();
    const unknown: string[] = [];
    const rel = changedFiles.map((f) =>
      path.isAbsolute(f) ? toRepoRelative(this.repoRoot, f) : f.split(path.sep).join("/")
    );
    const classes = this.map.affectedClasses(rel, unknown);

    const fallback = new Map<string, ProjectInfo>();
    for (const f of unknown) {
      for (const p of affectedTestProjects(graph, path.join(this.repoRoot, f))) {
        fallback.set(p.csproj.toLowerCase(), p);
      }
    }
    // Don't double-run: if a fallback project is being run in full, drop its mapped classes.
    const fallbackRel = new Set(
      [...fallback.values()].map((p) => toRepoRelative(this.repoRoot, p.csproj).toLowerCase())
    );
    const filteredClasses = classes.filter(
      (c) => !fallbackRel.has((this.map.entry(c)?.csproj ?? "").toLowerCase())
    );
    return { classes: filteredClasses, fallbackProjects: [...fallback.values()], changedFiles: rel };
  }

  /** Run the affected set inside the shadow worktree. */
  async runAffected(affected: AffectedSet): Promise<RunResult> {
    if (!this.shadow) await this.prepare();
    const outcomes: TestOutcome[] = [];
    let output = "";
    let ok = true;

    // Group mapped classes by owning test project.
    const byProject = new Map<string, string[]>();
    for (const cls of affected.classes) {
      const csproj = this.map.entry(cls)?.csproj;
      if (!csproj) continue;
      if (!byProject.has(csproj)) byProject.set(csproj, []);
      byProject.get(csproj)!.push(cls);
    }

    for (const [csproj, classes] of byProject) {
      const filter = classes.map((c) => `FullyQualifiedName~${c}`).join("|");
      const res = await this.dotnetTest(this.shadowPath(path.join(this.repoRoot, csproj)), [
        "--filter",
        filter,
      ]);
      ok = ok && res.ok;
      output += res.output;
      outcomes.push(...res.outcomes);
    }

    for (const p of affected.fallbackProjects) {
      const res = await this.dotnetTest(this.shadowPath(p.csproj), []);
      ok = ok && res.ok;
      output += res.output;
      outcomes.push(...res.outcomes);
    }

    return {
      ok,
      ranClasses: affected.classes,
      fallbackProjects: affected.fallbackProjects.map((p) => p.name),
      outcomes,
      output,
    };
  }

  private async dotnetTest(
    csprojAbs: string,
    extraArgs: string[]
  ): Promise<{ ok: boolean; outcomes: TestOutcome[]; output: string }> {
    const trxDir = path.join(path.dirname(csprojAbs), ".impact-trx");
    fs.rmSync(trxDir, { recursive: true, force: true });
    const res = await exec(
      "dotnet",
      [
        "test",
        csprojAbs,
        ...extraArgs,
        "--nologo",
        "--verbosity",
        "quiet",
        "--logger",
        "trx",
        "--results-directory",
        trxDir,
      ],
      this.shadow!.dir
    );
    const outcomes: TestOutcome[] = [];
    try {
      for (const f of fs.readdirSync(trxDir).filter((f) => f.endsWith(".trx"))) {
        outcomes.push(...parseTrx(path.join(trxDir, f)));
      }
    } catch {
      /* no trx produced (build failure) */
    }
    fs.rmSync(trxDir, { recursive: true, force: true });
    return { ok: res.code === 0, outcomes, output: res.stdout + res.stderr };
  }

  /**
   * Build/refresh the impact map: discover test classes per project, collect
   * per-class coverage for classes missing from the map (or all, if refresh).
   */
  async buildMap(opts: {
    refresh?: boolean;
    onProgress?: (done: number, total: number, current: string) => void;
    shouldCancel?: () => boolean;
  }): Promise<{ mapped: number; failed: string[] }> {
    if (!this.shadow) await this.prepare();
    const graph = this.projectGraph();
    const work: Array<{ csprojRel: string; classFqn: string }> = [];
    const alive = new Set<string>();

    for (const p of testProjects(graph)) {
      const csprojRel = toRepoRelative(this.repoRoot, p.csproj);
      const shadowCsproj = this.shadowPath(p.csproj);
      // Warm restore/build once per project so per-class runs can use --no-restore.
      await exec("dotnet", ["build", shadowCsproj, "--nologo", "--verbosity", "quiet"], this.shadow!.dir);
      const classes = await discoverTestClasses(shadowCsproj, this.shadow!.dir);
      for (const cls of classes) {
        alive.add(cls);
        if (opts.refresh || !this.map.has(cls)) work.push({ csprojRel, classFqn: cls });
      }
    }

    const failed: string[] = [];
    let done = 0;
    for (const item of work) {
      if (opts.shouldCancel?.()) break;
      opts.onProgress?.(done, work.length, item.classFqn);
      try {
        const cov = await collectClassCoverage(
          this.shadow!.dir,
          this.shadowPath(path.join(this.repoRoot, item.csprojRel)),
          item.classFqn
        );
        // Keep only files in the repo tree; drop SDK absolute paths and generated code.
        const repoFiles = cov.files.filter(
          (f) => !path.isAbsolute(f) && !/(^|\/)(obj|bin)\//i.test(f)
        );
        this.map.update(item.classFqn, item.csprojRel, repoFiles);
        if (!cov.passed) failed.push(item.classFqn);
      } catch (e) {
        failed.push(`${item.classFqn}: ${(e as Error).message}`);
      }
      done++;
      if (done % 5 === 0) this.map.save();
    }
    this.map.save();
    return { mapped: done, failed };
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseTrx(trxPath: string): TestOutcome[] {
  const xml = fs.readFileSync(trxPath, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    isArray: (name) => ["UnitTestResult", "UnitTest"].includes(name),
  });
  const doc = parser.parse(xml);
  const results = doc?.TestRun?.Results?.UnitTestResult ?? [];
  const defs = doc?.TestRun?.TestDefinitions?.UnitTest ?? [];
  const classByTestId = new Map<string, string>();
  for (const d of defs) {
    const id = d["@_id"];
    const cls = d?.TestMethod?.["@_className"];
    if (id && cls) classByTestId.set(id, String(cls).split(",")[0]);
  }
  const outcomes: TestOutcome[] = [];
  for (const r of results) {
    const testName: string = decodeXml(r["@_testName"] ?? "");
    const cls =
      classByTestId.get(r["@_testId"]) ??
      testName.replace(/\(.*\)$/s, "").split(".").slice(0, -1).join(".");
    const duration: string | undefined = r["@_duration"];
    outcomes.push({
      classFqn: cls,
      method: testName,
      passed: r["@_outcome"] === "Passed",
      message: r?.Output?.ErrorInfo?.Message
        ? decodeXml(String(r.Output.ErrorInfo.Message))
        : undefined,
      durationMs: duration ? trxDurationToMs(duration) : undefined,
    });
  }
  return outcomes;
}

function trxDurationToMs(d: string): number {
  const m = d.match(/^(\d+):(\d+):([\d.]+)$/);
  if (!m) return 0;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}
