import { XMLParser } from "fast-xml-parser";
import * as fs from "fs";
import * as path from "path";
import { buildRunsettings, collectClassCoverage } from "./coverage";
import { discoverTestClasses } from "./discover";
import {
  affectedTestProjects,
  buildProjectGraph,
  ProjectGraph,
  ProjectInfo,
  projectForFile,
  sourceStamp,
  testProjects,
} from "./projects";
import { ImpactMap } from "./map";
import { findBuiltDll, StaticMapper } from "./staticmap";
import { cacheDirFor, classFilter, exec, git, parseStatusZ, toRepoRelative } from "./util";
import type { SessionRunner } from "./vstestSession";
import { ensureShadow, Shadow, syncOverlay } from "./worktree";

export interface TestOutcome {
  classFqn: string;
  method: string;
  passed: boolean;
  /** Test was skipped (e.g. [Fact(Skip=...)]); passed is false but it is not a failure. */
  skipped: boolean;
  message?: string;
  durationMs?: number;
}

export interface RunResult {
  ok: boolean;
  /** The run was aborted (superseded by a newer save); results are partial. */
  cancelled: boolean;
  ranClasses: string[];
  fallbackProjects: string[];
  outcomes: TestOutcome[];
  output: string;
}

/** Keep only files in the repo tree; drop SDK absolute paths and generated code. */
function repoTreeFiles(files: string[]): string[] {
  return files.filter((f) => !path.isAbsolute(f) && !/(^|\/)(obj|bin)\//i.test(f));
}

export interface AffectedSet {
  classes: string[];
  /** Projects to run in full because changed files aren't in the map yet. */
  fallbackProjects: ProjectInfo[];
  changedFiles: string[];
  /** Owning test project (repo-relative csproj) for classes not yet in the map. */
  classOwners?: Record<string, string>;
}

/** Unmapped changed files that justify project-level fallback runs. */
const FALLBACK_FILE_RE = /\.(cs|csproj|props|targets|config|resx|json|xml|razor|cshtml)$/i;

export class Runner {
  readonly map: ImpactMap;
  private shadow: Shadow | null = null;
  private graph: ProjectGraph | null = null;
  private settingsFile: string | undefined;

  /** Optional persistent test-session runner; runs fall back to dotnet test without it. */
  sessions: SessionRunner | null = null;
  /** Static (IL+PDB) map builder; log sink is swappable by the host. */
  readonly staticMapper: StaticMapper;
  logSink: (msg: string) => void = () => undefined;

  constructor(readonly repoRoot: string) {
    this.map = new ImpactMap(repoRoot);
    this.lastFailures = this.loadLastFailures();
    this.staticMapper = new StaticMapper(
      repoRoot,
      path.join(__dirname, "..", "..", "helper-static"),
      (m) => this.logSink(m)
    );
  }

  /** Newest built test dll for a repo-relative csproj, inside the shadow. */
  private findTestDll(csprojRel: string): string | undefined {
    const graph = this.projectGraph();
    const info = [...graph.projects.values()].find(
      (p) => toRepoRelative(this.repoRoot, p.csproj).toLowerCase() === csprojRel.toLowerCase()
    );
    if (!info) return undefined;
    return findBuiltDll(this.shadow!.dir, info, this.repoRoot);
  }

  async prepare(): Promise<Shadow> {
    this.shadow = await ensureShadow(this.repoRoot);
    await syncOverlay(this.shadow);
    this.graph = buildProjectGraph(this.repoRoot);
    // Instrument only first-party assemblies (derived from the graph, not config).
    const names = [...this.graph.projects.values()].map((p) => p.assemblyName);
    this.settingsFile = path.join(this.shadow.dir, ".impact-runsettings.xml");
    fs.writeFileSync(this.settingsFile, buildRunsettings(names));
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

  /**
   * Discover test classes across all test projects, fast:
   * - projects whose sources are unchanged since the cached discovery are
   *   skipped entirely (stamp = newest source mtime + file count);
   * - dirty projects get one build (the solution when present — dependency-
   *   correct and internally parallel — else serial per-project), then
   *   `--list-tests --no-build` runs in parallel.
   * Returns repo-relative csproj -> class FQNs for every test project.
   */
  async discoverAll(
    opts: {
      parallel?: number;
      force?: boolean;
      onPhase?: (message: string) => void;
    } = {}
  ): Promise<Record<string, string[]>> {
    if (!this.shadow) await this.prepare();
    const graph = this.projectGraph();
    const cachePath = path.join(cacheDirFor(this.repoRoot), "discovery-cache.json");
    let cache: { version: 2; projects: Record<string, { stamp: string; classes: string[] }> } = {
      version: 2,
      projects: {},
    };
    try {
      const loaded = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (loaded?.version === 2) cache = loaded;
    } catch {
      /* fresh */
    }

    const projects = testProjects(graph);
    const result: Record<string, string[]> = {};
    const dirty: Array<{ p: ProjectInfo; rel: string; stamp: string }> = [];
    for (const p of projects) {
      const rel = toRepoRelative(this.repoRoot, p.csproj);
      const stamp = sourceStamp(p.dir); // real repo is the source of truth
      const cached = cache.projects[rel];
      if (!opts.force && cached && cached.stamp === stamp) {
        result[rel] = cached.classes;
      } else {
        dirty.push({ p, rel, stamp });
      }
    }
    if (dirty.length === 0) return result;
    opts.onPhase?.(`discovering tests in ${dirty.length}/${projects.length} changed projects`);

    // Build phase for dirty projects: prefer one solution build.
    const sln = fs
      .readdirSync(this.repoRoot)
      .find((f) => f.toLowerCase().endsWith(".sln") || f.toLowerCase().endsWith(".slnx"));
    let slnOk = false;
    if (sln && dirty.length > 1) {
      opts.onPhase?.(`building solution ${sln}`);
      const res = await exec(
        "dotnet",
        ["build", path.join(this.shadow!.dir, sln), "--nologo", "--verbosity", "quiet"],
        this.shadow!.dir
      );
      slnOk = res.code === 0;
    }
    if (!slnOk) {
      let n = 0;
      for (const d of dirty) {
        opts.onPhase?.(`building ${d.p.name} (${++n}/${dirty.length})`);
        await exec(
          "dotnet",
          ["build", this.shadowPath(d.p.csproj), "--nologo", "--verbosity", "quiet"],
          this.shadow!.dir
        );
      }
    }

    // Parallel discovery against the built outputs.
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, opts.parallel ?? 4), dirty.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= dirty.length) return;
          const d = dirty[i];
          opts.onPhase?.(`discovering ${d.p.name} (${++done}/${dirty.length})`);
          try {
            const classes = await discoverTestClasses(this.shadowPath(d.p.csproj), this.shadow!.dir, true);
            result[d.rel] = classes;
            cache.projects[d.rel] = { stamp: d.stamp, classes };
          } catch {
            // Keep the stale cache row if we have one; better than losing the tree.
            const cached = cache.projects[d.rel];
            if (cached) result[d.rel] = cached.classes;
          }
        }
      })
    );

    // Drop cache rows for projects that no longer exist.
    const live = new Set(projects.map((p) => toRepoRelative(this.repoRoot, p.csproj)));
    for (const rel of Object.keys(cache.projects)) if (!live.has(rel)) delete cache.projects[rel];
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));
    return result;
  }

  /** Changed files vs a git base ref plus uncommitted changes (repo-relative). */
  async changedFiles(base?: string, stagedOnly = false): Promise<string[]> {
    const files = new Set<string>();
    // -z everywhere: NUL separators, no quoting of paths with spaces/specials.
    if (base) {
      const res = await git(this.repoRoot, ["diff", "--name-only", "-z", base]);
      for (const f of res.stdout.split("\0")) if (f) files.add(f);
    }
    if (stagedOnly) {
      const res = await git(this.repoRoot, ["diff", "--name-only", "-z", "--cached"]);
      for (const f of res.stdout.split("\0")) if (f) files.add(f);
    } else {
      const res = await git(this.repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all"]);
      for (const e of parseStatusZ(res.stdout)) {
        files.add(e.file);
        if (e.origin) files.add(e.origin); // a rename's old path still affects its tests
      }
    }
    return [...files];
  }

  computeAffected(changedFiles: string[]): AffectedSet {
    const graph = this.projectGraph();
    const unknown: string[] = [];
    const rel = changedFiles
      .map((f) =>
        path.isAbsolute(f) ? toRepoRelative(this.repoRoot, f) : f.split(path.sep).join("/")
      )
      // Build outputs are never inputs; a repo without bin/obj gitignored must
      // not have generated files (obj/*.cs, deps.json, ...) drive selection.
      .filter((f) => !/(^|\/)(bin|obj)\//i.test(f));
    const classes = this.map.affectedClasses(rel, unknown);

    const fallback = new Map<string, ProjectInfo>();
    for (const f of unknown) {
      if (!FALLBACK_FILE_RE.test(f)) continue;
      const abs = path.join(this.repoRoot, f);
      // Non-.cs files (project files, config) only trigger fallback when they
      // belong to a project; stray repo-root json/xml shouldn't run everything.
      if (!/\.cs$/i.test(f) && !projectForFile(graph, abs)) continue;
      for (const p of affectedTestProjects(graph, abs)) {
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

  /** Class FQNs that failed in the previous run, for failure-first ordering. */
  private lastFailures: Set<string>;

  private loadLastFailures(): Set<string> {
    try {
      return new Set(
        JSON.parse(fs.readFileSync(path.join(cacheDirFor(this.repoRoot), "last-failures.json"), "utf8"))
      );
    } catch {
      return new Set();
    }
  }

  private saveLastFailures(): void {
    const p = path.join(cacheDirFor(this.repoRoot), "last-failures.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([...this.lastFailures]));
  }

  /**
   * Run the affected set inside the shadow worktree. Abort via `signal` to
   * supersede. Build happens once up front (shared deps compile once), test
   * runs go `--no-build` in parallel across projects, and classes that failed
   * last time run in a first quick pass so red results surface early.
   * `onPartial` streams each test invocation's outcomes as it finishes.
   */
  async runAffected(
    affected: AffectedSet,
    signal?: AbortSignal,
    onPartial?: (outcomes: TestOutcome[]) => void
  ): Promise<RunResult> {
    if (!this.shadow) await this.prepare();
    const outcomes: TestOutcome[] = [];
    let output = "";
    let ok = true;

    // Group mapped classes by owning test project.
    const byProject = new Map<string, string[]>();
    for (const cls of affected.classes) {
      const csproj = this.map.entry(cls)?.csproj ?? affected.classOwners?.[cls];
      if (!csproj) continue;
      if (!byProject.has(csproj)) byProject.set(csproj, []);
      byProject.get(csproj)!.push(cls);
    }
    const fallbackRel = affected.fallbackProjects.map((p) => toRepoRelative(this.repoRoot, p.csproj));

    // Windows keeps loaded assemblies locked: stop warm sessions before builds
    // can overwrite their dlls. (Elsewhere the helper's mtime check handles it.)
    const allRels = new Set([...byProject.keys(), ...fallbackRel]);
    if (process.platform === "win32" && this.sessions?.available) {
      for (const rel of allRels) {
        const dll = this.findTestDll(rel);
        if (dll) await this.sessions.release(dll);
      }
    }

    // Build phase: every involved project once, serially — later builds reuse
    // the shared dependencies the first ones compiled.
    for (const rel of allRels) {
      if (signal?.aborted) break;
      const res = await exec(
        "dotnet",
        ["build", this.shadowPath(path.join(this.repoRoot, rel)), "--nologo", "--verbosity", "quiet"],
        this.shadow!.dir,
        10 * 60 * 1000,
        signal
      );
      if (res.code !== 0 && !signal?.aborted) {
        ok = false;
        output += res.stdout + res.stderr;
      }
    }

    // Failure-first: split mapped classes into a quick red pass and the rest.
    const failedNow = affected.classes.filter((c) => this.lastFailures.has(c));
    const passes: Array<Array<{ rel: string; filter?: string }>> = [];
    const invocationsFor = (pick: (cls: string) => boolean) => {
      const list: Array<{ rel: string; filter?: string }> = [];
      for (const [rel, classes] of byProject) {
        const subset = classes.filter(pick);
        if (subset.length > 0) list.push({ rel, filter: classFilter(subset) });
      }
      return list;
    };
    if (failedNow.length > 0) passes.push(invocationsFor((c) => this.lastFailures.has(c)));
    passes.push([
      ...invocationsFor((c) => failedNow.length === 0 || !this.lastFailures.has(c)),
      ...fallbackRel.map((rel) => ({ rel, filter: undefined })),
    ]);

    const runInvocation = async (inv: { rel: string; filter?: string }) => {
      // Preferred: warm test session (milliseconds of dispatch). Falls back to
      // dotnet test on any unavailability.
      if (this.sessions?.available) {
        const dll = this.findTestDll(inv.rel);
        if (dll) {
          const r = await this.sessions.runFilter(dll, inv.filter, signal);
          if (r) return { ok: r.ok, outcomes: r.outcomes, output: r.output };
        }
      }
      return this.dotnetTest(
        this.shadowPath(path.join(this.repoRoot, inv.rel)),
        [...(inv.filter ? ["--filter", inv.filter] : []), "--no-build"],
        signal
      );
    };

    for (const invocations of passes) {
      if (signal?.aborted) break;
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, invocations.length) }, async () => {
          for (;;) {
            if (signal?.aborted) return;
            const i = next++;
            if (i >= invocations.length) return;
            const res = await runInvocation(invocations[i]);
            ok = ok && (res.ok || signal?.aborted === true);
            output += res.output;
            outcomes.push(...res.outcomes);
            if (res.outcomes.length > 0) onPartial?.(res.outcomes);
          }
        })
      );
    }

    // Remember failures for next run's quick pass (skip on cancel: partial data).
    if (!signal?.aborted) {
      for (const o of outcomes) {
        if (o.skipped) continue;
        if (o.passed) this.lastFailures.delete(o.classFqn);
        else this.lastFailures.add(o.classFqn);
      }
      this.saveLastFailures();
    }

    return {
      ok,
      cancelled: signal?.aborted === true,
      ranClasses: affected.classes,
      fallbackProjects: affected.fallbackProjects.map((p) => p.name),
      outcomes,
      output,
    };
  }

  private async dotnetTest(
    csprojAbs: string,
    extraArgs: string[],
    signal?: AbortSignal
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
      this.shadow!.dir,
      10 * 60 * 1000,
      signal
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
   * Build/refresh the impact map from the built assemblies' IL metadata and
   * portable PDBs: each test class's transitive type-reference closure becomes
   * its file row (a safe superset of dynamic coverage). Rows are tagged
   * `static`; the live-refresh pipeline replaces them with measured coverage
   * as tests run. Seconds, not hours.
   */
  async buildMap(opts: {
    refresh?: boolean;
    /**
     * vstest-discovered classes per repo-relative csproj (from discoverAll()).
     * Used as part of the alive set when pruning: vstest and IL metadata name
     * nested classes differently, and the union never wrongly kills rows.
     */
    discovered: Record<string, string[]>;
    onProgress?: (done: number, total: number, current: string) => void;
    onPhase?: (message: string) => void;
    shouldCancel?: () => boolean;
  }): Promise<{ mapped: number; failed: string[] }> {
    if (!this.shadow) await this.prepare();
    const graph = this.projectGraph();
    const failed: string[] = [];
    let cancelled = false;
    const ctrl = new AbortController();
    const wantCancel = () => {
      if (opts.shouldCancel?.()) {
        cancelled = true;
        ctrl.abort();
      }
      return cancelled;
    };

    const projects = testProjects(graph);
    const liveProjects = new Set(projects.map((p) => toRepoRelative(this.repoRoot, p.csproj)));

    // Build phase: the closure needs every assembly. One solution build when
    // possible (dependency-correct, internally parallel), else per test project.
    const sln = fs
      .readdirSync(this.repoRoot)
      .find((f) => f.toLowerCase().endsWith(".sln") || f.toLowerCase().endsWith(".slnx"));
    let builtOk = false;
    if (sln) {
      opts.onPhase?.(`building solution ${sln}`);
      const res = await exec(
        "dotnet",
        ["build", path.join(this.shadow!.dir, sln), "--nologo", "--verbosity", "quiet"],
        this.shadow!.dir,
        15 * 60 * 1000,
        ctrl.signal
      );
      builtOk = res.code === 0;
      if (!builtOk && !ctrl.signal.aborted) failed.push(`solution build: ${sln}`);
    }
    if (!builtOk) {
      let built = 0;
      for (const p of projects) {
        if (wantCancel()) break;
        opts.onPhase?.(`building ${p.name} (${++built}/${projects.length})`);
        await exec(
          "dotnet",
          ["build", this.shadowPath(p.csproj), "--nologo", "--verbosity", "quiet"],
          this.shadow!.dir,
          10 * 60 * 1000,
          ctrl.signal
        );
      }
    }
    if (wantCancel()) return { mapped: 0, failed };

    // Static closure over the built assemblies.
    opts.onPhase?.("computing static impact map");
    const result = await this.staticMapper.compute(this.shadow!.dir, graph);
    if (!result) {
      return { mapped: 0, failed: [...failed, "static map computation failed"] };
    }

    const entries = Object.entries(result.classes);
    /** Alive classes per project for pruning: static ∪ vstest discovery (their
     * naming differs on nested classes; the union never wrongly kills rows). */
    const alive = new Map<string, Set<string>>();
    for (const [rel, classes] of Object.entries(opts.discovered)) alive.set(rel, new Set(classes));
    let done = 0;
    for (const [cls, row] of entries) {
      if (!alive.has(row.csproj)) alive.set(row.csproj, new Set());
      alive.get(row.csproj)!.add(cls);
      opts.onProgress?.(done, entries.length, cls);
      // refresh forces a clean static baseline over old coverage rows too.
      if (this.map.updateStatic(cls, row.csproj, row.files, opts.refresh)) done++;
    }

    if (!cancelled) {
      const removed = this.map.prune(alive, liveProjects);
      if (removed.length > 0) opts.onPhase?.(`pruned ${removed.length} stale map entries`);
    }
    this.map.save();
    return { mapped: done, failed };
  }

  // ---------- live map refresh ----------

  /** Classes queued for background coverage refresh: FQN -> owning csproj (repo-relative). */
  readonly pendingRefresh = new Map<string, string>();

  /**
   * Queue every class that just produced results for a coverage refresh, so map
   * rows track reality as tests re-run. Classes only the run knew about (fallback
   * discoveries) get owners from `owners` and grow the map organically.
   */
  queueRefreshFromOutcomes(outcomes: TestOutcome[], owners?: Record<string, string>): number {
    for (const o of outcomes) {
      if (o.skipped) continue;
      const csproj = this.map.entry(o.classFqn)?.csproj ?? owners?.[o.classFqn];
      if (csproj) this.pendingRefresh.set(o.classFqn, csproj);
    }
    return this.pendingRefresh.size;
  }

  /**
   * Drain the refresh queue one class at a time (low-priority coverage runs).
   * Abort via `signal` to yield to a foreground run; the in-flight class is
   * requeued. Returns how many rows were refreshed.
   */
  async refreshPending(
    opts: {
      signal?: AbortSignal;
      onProgress?: (remaining: number, current: string) => void;
    } = {}
  ): Promise<number> {
    if (!this.shadow) await this.prepare();
    let done = 0;
    while (this.pendingRefresh.size > 0 && !opts.signal?.aborted) {
      const [cls, csprojRel] = this.pendingRefresh.entries().next().value as [string, string];
      this.pendingRefresh.delete(cls);
      opts.onProgress?.(this.pendingRefresh.size, cls);
      try {
        const cov = await collectClassCoverage(
          this.shadow!.dir,
          this.shadowPath(path.join(this.repoRoot, csprojRel)),
          cls,
          opts.signal,
          this.settingsFile
        );
        if (opts.signal?.aborted) {
          this.pendingRefresh.set(cls, csprojRel); // partial result: retry later
          break;
        }
        this.map.update(cls, csprojRel, repoTreeFiles(cov.files));
        this.map.save();
        done++;
      } catch {
        /* leave the row as-is; the next full build-map covers it */
      }
    }
    return done;
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
    const outcome: string = r["@_outcome"] ?? "";
    outcomes.push({
      classFqn: cls,
      method: testName,
      passed: outcome === "Passed",
      skipped: outcome === "NotExecuted" || outcome === "Skipped" || outcome === "Inconclusive",
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
