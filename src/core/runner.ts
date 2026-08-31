import * as fs from "fs";
import * as path from "path";
import {
  buildRunsettings,
  collectClassCoverage,
  COLLECTOR_COVERLET,
  COLLECTOR_MS,
  findCoberturaFiles,
  noteWorkingCollector,
  parseCoberturaLineHits,
  preferredCollector,
} from "./coverage";
import { classesRecord, discoverTests } from "./discover";
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
import { findBuiltDll, findBuiltDlls, StaticMapper } from "./staticmap";
import { parseTrx, TestOutcome } from "./trx";
import { cacheDirFor, classFilter, exec, git, parseStatusZ, toRepoRelative } from "./util";
import type { SessionRunner } from "./vstestSession";
import { ensureShadow, Shadow, syncOverlay } from "./worktree";

export { parseTrx } from "./trx";
export type { TestOutcome } from "./trx";

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
  /** Optional hot-patch fast path (method-body edits patch live testhosts). */
  hotpatch: import("./hotpatch").HotPatcher | null = null;
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

  /** All built test dlls (one per TFM) for a repo-relative csproj. */
  private findTestDlls(csprojRel: string): string[] {
    const graph = this.projectGraph();
    const info = [...graph.projects.values()].find(
      (p) => toRepoRelative(this.repoRoot, p.csproj).toLowerCase() === csprojRel.toLowerCase()
    );
    if (!info) return [];
    return findBuiltDlls(this.shadow!.dir, info, this.repoRoot);
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
   * Discover test methods across all test projects, fast:
   * - projects whose sources are unchanged since the cached discovery are
   *   skipped entirely (stamp = newest source mtime + file count + path digest);
   * - dirty projects get one build (the solution when present — dependency-
   *   correct and internally parallel — else serial per-project), then
   *   `--list-tests --no-build` runs in parallel.
   * Returns repo-relative csproj -> method FQNs (theory args stripped) for
   * every test project; derive classes with classesRecord() when needed.
   */
  async discoverAll(
    opts: {
      parallel?: number;
      force?: boolean;
      onPhase?: (message: string) => void;
      /** Test seam: replaces `dotnet test --list-tests` per project. */
      discoverImpl?: (csproj: string, cwd: string, noBuild: boolean) => Promise<string[]>;
      /** Test seam: replaces the warm build (also skips the solution-build shortcut). */
      buildImpl?: (csprojAbs: string) => Promise<void>;
    } = {}
  ): Promise<Record<string, string[]>> {
    if (!this.shadow) await this.prepare();
    const graph = this.projectGraph();
    const cachePath = path.join(cacheDirFor(this.repoRoot), "discovery-cache.json");
    let cache: { version: 3; projects: Record<string, { stamp: string; methods: string[] }> } = {
      version: 3,
      projects: {},
    };
    try {
      const loaded = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      // v2 cached classes only; a version bump re-discovers once to get methods.
      if (loaded?.version === 3) cache = loaded;
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
        result[rel] = cached.methods;
      } else {
        dirty.push({ p, rel, stamp });
      }
    }
    if (dirty.length === 0) return result;
    opts.onPhase?.(`discovering tests in ${dirty.length}/${projects.length} changed projects`);

    // Build phase for dirty projects: prefer one solution build.
    const build =
      opts.buildImpl ??
      (async (csprojAbs: string) => {
        await exec(
          "dotnet",
          ["build", csprojAbs, "--nologo", "--verbosity", "quiet"],
          this.shadow!.dir
        );
      });
    const sln = fs
      .readdirSync(this.repoRoot)
      .find((f) => f.toLowerCase().endsWith(".sln") || f.toLowerCase().endsWith(".slnx"));
    let slnOk = false;
    if (!opts.buildImpl && sln && dirty.length > 1) {
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
        await build(this.shadowPath(d.p.csproj));
      }
    }

    // Parallel discovery against the built outputs.
    const discover = opts.discoverImpl ?? discoverTests;
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
            const methods = await discover(this.shadowPath(d.p.csproj), this.shadow!.dir, true);
            result[d.rel] = methods;
            cache.projects[d.rel] = { stamp: d.stamp, methods };
          } catch {
            // Keep the stale cache row if we have one; better than losing the tree.
            const cached = cache.projects[d.rel];
            if (cached) result[d.rel] = cached.methods;
          }
        }
      })
    );

    // Drop cache rows for projects that no longer exist.
    const live = new Set(projects.map((p) => toRepoRelative(this.repoRoot, p.csproj)));
    for (const rel of Object.keys(cache.projects)) if (!live.has(rel)) delete cache.projects[rel];
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));

    // Prune map rows for classes discovery no longer sees — without this the
    // tree resurrects deleted/moved classes from the map forever (#17). A
    // project whose discovery came back EMPTY is withheld from the alive set:
    // discoverTests only throws on non-zero exit with zero methods, so an
    // exit-0 run that listed nothing (unparsed MTP output, missing runner)
    // would otherwise wipe measured coverage rows for untouched classes.
    const alive = new Map<string, Set<string>>();
    for (const [rel, classes] of Object.entries(classesRecord(result))) {
      if (classes.length > 0) alive.set(rel, new Set(classes));
    }
    const removed = this.map.prune(alive, live);
    if (removed.length > 0) {
      opts.onPhase?.(`pruned ${removed.length} stale map entries`);
      for (const cls of removed) this.lastFailures.delete(cls);
      this.saveLastFailures();
      this.map.save();
    }
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
   * Minimal rebuild for the projects feeding `testRels`: build only projects
   * whose own sources changed (dependency-ordered, BuildProjectReferences=false),
   * then copy their fresh outputs into each involved test project's output dir.
   * Returns false when anything went sideways — caller falls back to full builds.
   */
  private async minimalBuild(testRels: Set<string>, signal?: AbortSignal): Promise<boolean> {
    const graph = this.projectGraph();
    const stampsPath = path.join(cacheDirFor(this.repoRoot), "own-stamps.json");
    let stamps: Record<string, string> = {};
    try {
      stamps = JSON.parse(fs.readFileSync(stampsPath, "utf8"));
    } catch {
      /* fresh: everything counts as changed */
    }

    // Projects that feed the involved test projects (deps + the tests themselves).
    const relevant = new Map<string, ProjectInfo>();
    const addWithDeps = (info: ProjectInfo) => {
      const key = path.resolve(info.csproj).toLowerCase();
      if (relevant.has(key)) return;
      relevant.set(key, info);
      for (const ref of info.references) {
        const dep = graph.projects.get(path.resolve(ref).toLowerCase());
        if (dep) addWithDeps(dep);
      }
    };
    for (const rel of testRels) {
      const info = [...graph.projects.values()].find(
        (p) => toRepoRelative(this.repoRoot, p.csproj).toLowerCase() === rel.toLowerCase()
      );
      if (!info) return false;
      addWithDeps(info);
    }

    // Changed = own-source stamp differs from the last successful build's.
    const changed: ProjectInfo[] = [];
    const newStamps: Record<string, string> = {};
    for (const info of relevant.values()) {
      const rel = toRepoRelative(this.repoRoot, info.csproj);
      const stamp = sourceStamp(info.dir);
      newStamps[rel] = stamp;
      if (stamps[rel] !== stamp) changed.push(info);
    }
    if (changed.length === 0) return true;

    // Dependency order (referenced before referencing).
    const order: ProjectInfo[] = [];
    const visiting = new Set<string>();
    const visit = (info: ProjectInfo) => {
      const key = path.resolve(info.csproj).toLowerCase();
      if (visiting.has(key)) return;
      visiting.add(key);
      for (const ref of info.references) {
        const dep = graph.projects.get(path.resolve(ref).toLowerCase());
        if (dep && changed.includes(dep)) visit(dep);
      }
      order.push(info);
    };
    for (const info of changed) visit(info);

    const binlogDir = path.join(cacheDirFor(this.repoRoot), "binlogs");
    fs.mkdirSync(binlogDir, { recursive: true });
    const binlogsPath = path.join(cacheDirFor(this.repoRoot), "binlogs.json");
    let binlogs: Record<string, string> = {};
    try {
      binlogs = JSON.parse(fs.readFileSync(binlogsPath, "utf8"));
    } catch {
      /* fresh */
    }
    const built: Array<{ info: ProjectInfo; relKey: string; binlog: string }> = [];
    for (const info of order) {
      if (signal?.aborted) return false;
      const relKey = toRepoRelative(this.repoRoot, info.csproj);
      // The binlog is the hot-patch baseline material for this project.
      const binlog = path.join(binlogDir, info.name + ".binlog");
      const res = await exec(
        "dotnet",
        [
          "msbuild",
          this.shadowPath(info.csproj),
          "-t:Build",
          "-p:BuildProjectReferences=false",
          "-restore:false",
          "-nologo",
          "-v:q",
          `-bl:${binlog}`,
        ],
        this.shadow!.dir,
        10 * 60 * 1000,
        signal
      );
      if (res.code !== 0) {
        this.logSink(`minimal build failed for ${info.name}; falling back to full builds`);
        return false;
      }
      stamps[relKey] = newStamps[relKey];
      built.push({ info, relKey, binlog });
    }

    // Baseline material must embed sources (a raw binlog reads files from
    // disk at load time — by then they hold the NEXT edit). Snapshot now,
    // while the shadow still matches this build. A zero-call binlog means the
    // build was an up-to-date no-op (e.g. an mtime-only touch): the compiler
    // never ran, the dll is unchanged, and the previous baseline stays valid —
    // replacing it with an empty complog would poison the fast path.
    if (this.hotpatch) {
      const fresh: Array<{ info: ProjectInfo; complog: string }> = [];
      for (const b of built) {
        const complog = b.binlog.replace(/\.binlog$/, ".complog");
        const calls = await this.hotpatch.snapshot(b.binlog, complog);
        if (calls === null) delete binlogs[b.relKey];
        else if (calls > 0) {
          binlogs[b.relKey] = complog;
          fresh.push({ info: b.info, complog });
        }
        // calls === 0: keep the previous baseline untouched.
      }
      // Real recompiles invalidate loaded baselines and generation chains;
      // reset BEFORE preloading so the fresh baselines survive it. No-op
      // builds reset nothing — warm baselines stay warm.
      if (fresh.length > 0) {
        this.hotpatch.reset();
        for (const f of fresh) {
          // Warm the baseline now so the first fast save is milliseconds.
          const dll = findBuiltDll(this.shadow!.dir, f.info, this.repoRoot);
          if (dll) this.hotpatch.preload(f.info.csproj, f.complog, this.shadowPath(f.info.csproj), dll);
        }
      }
    }
    fs.writeFileSync(binlogsPath, JSON.stringify(binlogs));

    // Fan changed dependency outputs into each test project's output dirs
    // (one per TFM for multi-targeted test projects).
    for (const rel of testRels) {
      const testDlls = this.findTestDlls(rel);
      if (testDlls.length === 0) return false;
      for (const testDll of testDlls) {
        const outDir = path.dirname(testDll);
        for (const info of order) {
          if (testRels.has(toRepoRelative(this.repoRoot, info.csproj))) continue; // built its own output
          const depDll = findBuiltDll(this.shadow!.dir, info, this.repoRoot);
          if (!depDll) continue;
          for (const ext of [".dll", ".pdb"]) {
            const src = depDll.replace(/\.dll$/i, ext);
            const dst = path.join(outDir, path.basename(src));
            if (fs.existsSync(src) && fs.existsSync(dst)) {
              try {
                fs.copyFileSync(src, dst);
              } catch (e) {
                // src replaced mid-copy, or dst still held by a testhost
                // (Windows): the run proceeds on dst's existing copy.
                this.logSink(`dep copy skipped for ${path.basename(dst)}: ${(e as Error).message}`);
              }
            }
          }
        }
      }
    }

    fs.mkdirSync(path.dirname(stampsPath), { recursive: true });
    fs.writeFileSync(stampsPath, JSON.stringify(stamps));
    return true;
  }

  /**
   * Run the affected set inside the shadow worktree. Abort via `signal` to
   * supersede. Minimal rebuild happens up front, test runs go `--no-build` in
   * parallel across projects, and classes that failed last time run in a first
   * quick pass so red results surface early.
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

    const allRels = new Set([...byProject.keys(), ...fallbackRel]);
    const tStart = Date.now();

    // Fast path first: edits Roslyn's EnC engine accepts (method bodies,
    // added methods/fields/types, lambdas) become deltas patched into the
    // live warm testhosts — no build, no restart, milliseconds. Any miss
    // (rude edit, API-surface change, cold host, missing binlog) falls
    // through, logging why.
    // This must run BEFORE the Windows session release below: releasing kills
    // the warm hosts the fast path patches into.
    let fastPatched = false;
    let fastSkip = ""; // why the fast path was not even attempted
    if (affected.changedFiles.length === 0) fastSkip = "no-changed-files";
    else if (!this.sessions?.available) fastSkip = "sessions-unavailable";
    else if (!this.hotpatch) fastSkip = "hotpatch-unavailable";
    else {
      this.hotpatch.shadowDir = this.shadow!.dir;
      let binlogs: Record<string, string> = {};
      try {
        binlogs = JSON.parse(
          fs.readFileSync(path.join(cacheDirFor(this.repoRoot), "binlogs.json"), "utf8")
        );
      } catch {
        /* none yet */
      }
      fastPatched = await this.hotpatch
        .tryFastPath(affected.changedFiles, this.projectGraph(), binlogs)
        .catch(() => false);
    }

    // Build phase, minimal-rebuild strategy:
    //   1. Rebuild ONLY projects whose OWN sources changed since their last
    //      successful shadow build (BuildProjectReferences=false keeps MSBuild
    //      from re-walking the whole reference graph).
    //   2. Fan rebuilt dependency dlls into the involved test projects' output
    //      dirs by file copy — milliseconds instead of test-project rebuilds.
    // Any build failure falls back to the plain full `dotnet build` of the
    // involved test projects, which is always correct.
    let buildMs = 0;
    if (!fastPatched) {
      // Windows keeps loaded assemblies locked — and every warm testhost
      // locks its dependency dlls too, not just its own test dll, so ALL
      // sessions must let go before a shared project can rebuild. The EnC
      // engine also reads baseline modules from disk; dropping its sessions
      // releases those handles too.
      if (process.platform === "win32") {
        if (this.sessions?.available) await this.sessions.releaseAll();
        this.hotpatch?.reset();
      }
      const tBuild = Date.now();
      const built = await this.buildProjects(allRels, signal);
      buildMs = Date.now() - tBuild;
      ok = ok && built.ok;
      output += built.output;
    }
    const tTest = Date.now();

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
      // Preferred: warm test sessions (milliseconds of dispatch) — one per
      // built TFM, so multi-targeted test projects run every framework, same
      // as `dotnet test` would. Falls back to dotnet test on any
      // unavailability (which also covers every TFM).
      if (this.sessions?.available) {
        const dlls = this.findTestDlls(inv.rel);
        const results = [];
        for (const dll of dlls) {
          const r = await this.sessions.runFilter(dll, inv.filter, signal);
          if (!r) {
            results.length = 0;
            break; // any session miss: run the whole invocation via dotnet test
          }
          results.push(r);
        }
        if (dlls.length > 0 && results.length === dlls.length) {
          return {
            ok: results.every((r) => r.ok),
            outcomes: results.flatMap((r) => r.outcomes),
            output: results.map((r) => r.output).join(""),
          };
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

    const now = Date.now();
    const fastLabel = fastPatched ? "hit" : fastSkip ? `off(${fastSkip})` : "miss";
    this.logSink(
      `timing: fastpath=${fastLabel} build=${buildMs}ms tests=${now - tTest}ms total=${now - tStart}ms`
    );

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

  /** Minimal-rebuild first; any failure falls back to plain builds of the test projects. */
  private async buildProjects(
    allRels: Set<string>,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; output: string }> {
    let ok = true;
    let output = "";
    if (!(await this.minimalBuild(allRels, signal))) {
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
      // Full builds rewrite dlls with no binlog: every hot-patch baseline is
      // now stale, and a delta emitted against one would corrupt fresh hosts.
      if (this.hotpatch) {
        this.hotpatch.reset();
        try {
          fs.rmSync(path.join(cacheDirFor(this.repoRoot), "binlogs.json"), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
    return { ok, output };
  }

  /**
   * Explicit "run with coverage": the selected classes/projects run under a
   * coverage collector (same MS-collector-with-Coverlet-fallback as map
   * refresh) and per-line hit counts come back for the editor's native
   * coverage view. Deliberately bypasses hot-patch and warm sessions —
   * instrumentation needs a real collector-owned testhost — but keeps the
   * minimal-rebuild path, so an unchanged tree skips straight to the run.
   */
  async runCoverage(
    affected: AffectedSet,
    signal?: AbortSignal,
    onPartial?: (outcomes: TestOutcome[]) => void
  ): Promise<RunResult & { coverage: Map<string, Map<number, number>> }> {
    if (!this.shadow) await this.prepare();
    const outcomes: TestOutcome[] = [];
    let output = "";

    const byProject = new Map<string, string[]>();
    for (const cls of affected.classes) {
      const csproj = this.map.entry(cls)?.csproj ?? affected.classOwners?.[cls];
      if (!csproj) continue;
      if (!byProject.has(csproj)) byProject.set(csproj, []);
      byProject.get(csproj)!.push(cls);
    }
    const fallbackRel = affected.fallbackProjects.map((p) => toRepoRelative(this.repoRoot, p.csproj));
    const allRels = new Set([...byProject.keys(), ...fallbackRel]);

    if (process.platform === "win32") {
      if (this.sessions?.available) await this.sessions.releaseAll();
      this.hotpatch?.reset(); // EnC baseline handles; see runAffected
    }

    const built = await this.buildProjects(allRels, signal);
    let ok = built.ok;
    output += built.output;

    const coverage = new Map<string, Map<number, number>>();
    const mergeHits = (report: Map<string, Map<number, number>>) => {
      // Across projects the same line's executions are genuinely additive.
      for (const [file, lines] of report) {
        let byLine = coverage.get(file);
        if (!byLine) coverage.set(file, (byLine = new Map()));
        for (const [line, hits] of lines) byLine.set(line, (byLine.get(line) ?? 0) + hits);
      }
    };

    const invocations = [
      ...[...byProject.entries()].map(([rel, classes]) => ({
        rel,
        filter: classFilter(classes) as string | undefined,
      })),
      ...fallbackRel.map((rel) => ({ rel, filter: undefined as string | undefined })),
    ];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, invocations.length) }, async () => {
        for (;;) {
          if (signal?.aborted) return;
          const i = next++;
          if (i >= invocations.length) return;
          const inv = invocations[i];
          const res = await this.dotnetTestCoverage(inv.rel, inv.filter, signal);
          ok = ok && (res.ok || signal?.aborted === true);
          output += res.output;
          outcomes.push(...res.outcomes);
          mergeHits(res.coverage);
          if (res.outcomes.length > 0) onPartial?.(res.outcomes);
        }
      })
    );

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
      coverage,
    };
  }

  private async dotnetTestCoverage(
    rel: string,
    filter: string | undefined,
    signal?: AbortSignal
  ): Promise<{
    ok: boolean;
    outcomes: TestOutcome[];
    output: string;
    coverage: Map<string, Map<number, number>>;
  }> {
    const csprojAbs = this.shadowPath(path.join(this.repoRoot, rel));
    const resultsDir = path.join(path.dirname(csprojAbs), ".impact-cov");

    const run = (collector: string) => {
      fs.rmSync(resultsDir, { recursive: true, force: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      return exec(
        "dotnet",
        [
          "test",
          csprojAbs,
          ...(filter ? ["--filter", filter] : []),
          "--collect",
          collector,
          ...(this.settingsFile ? ["--settings", this.settingsFile] : []),
          "--no-build",
          "--no-restore",
          "--nologo",
          "--verbosity",
          "quiet",
          "--logger",
          "trx",
          "--results-directory",
          resultsDir,
        ],
        this.shadow!.dir,
        10 * 60 * 1000,
        signal
      );
    };

    const first = preferredCollector();
    let res = await run(first);
    let reports = findCoberturaFiles(resultsDir);
    if (reports.length === 0 && first === COLLECTOR_MS && !signal?.aborted) {
      res = await run(COLLECTOR_COVERLET);
      reports = findCoberturaFiles(resultsDir);
      if (reports.length > 0) noteWorkingCollector(COLLECTOR_COVERLET);
    } else if (reports.length > 0) {
      noteWorkingCollector(first);
    }

    const coverage = new Map<string, Map<number, number>>();
    for (const report of reports) {
      // Same-file overlap across a project's reports (multi-TFM) is the same
      // code measured twice: max, not sum.
      for (const [file, lines] of parseCoberturaLineHits(report, this.shadow!.dir)) {
        let byLine = coverage.get(file);
        if (!byLine) coverage.set(file, (byLine = new Map()));
        for (const [line, hits] of lines) byLine.set(line, Math.max(byLine.get(line) ?? 0, hits));
      }
    }

    const outcomes: TestOutcome[] = [];
    try {
      for (const f of fs.readdirSync(resultsDir).filter((f) => f.endsWith(".trx"))) {
        outcomes.push(...parseTrx(path.join(resultsDir, f)));
      }
    } catch {
      /* no trx produced (build failure) */
    }
    fs.rmSync(resultsDir, { recursive: true, force: true });
    return { ok: res.code === 0, outcomes, output: res.stdout + res.stderr, coverage };
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
     * vstest-discovered method FQNs per repo-relative csproj (discoverAll()
     * output, verbatim). Their classes join the alive set when pruning: vstest
     * and IL metadata name nested classes differently, and the union never
     * wrongly kills rows.
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
    for (const [rel, classes] of Object.entries(classesRecord(opts.discovered)))
      alive.set(rel, new Set(classes));
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
   * Queue classes that just produced results for a coverage refresh — but only
   * where refreshing buys anything: rows that are static, missing, or stale
   * measured coverage. Fresh coverage rows are skipped, so a full-suite run
   * doesn't trigger hours of pointless background re-measurement. Classes only
   * the run knew about (fallback discoveries) get owners from `owners` and
   * grow the map organically.
   */
  static readonly COVERAGE_FRESH_MS = 7 * 24 * 3600 * 1000;

  queueRefreshFromOutcomes(outcomes: TestOutcome[], owners?: Record<string, string>): number {
    for (const o of outcomes) {
      if (o.skipped) continue;
      const entry = this.map.entry(o.classFqn);
      const csproj = entry?.csproj ?? owners?.[o.classFqn];
      if (!csproj) continue;
      if (
        entry &&
        (entry.source ?? "coverage") === "coverage" &&
        Date.now() - Date.parse(entry.updatedAt) < Runner.COVERAGE_FRESH_MS
      ) {
        continue; // measured recently: nothing to learn
      }
      this.pendingRefresh.set(o.classFqn, csproj);
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
        const files = repoTreeFiles(cov.files);
        if (files.length === 0) {
          // No report (failed run, racing rebuild, missing collector): never
          // overwrite a good row with emptiness.
          this.logSink(`map refresh: no coverage produced for ${cls}; keeping existing row`);
          continue;
        }
        this.map.update(cls, csprojRel, files);
        this.map.save();
        done++;
      } catch {
        /* leave the row as-is; the next full build-map covers it */
      }
    }
    return done;
  }
}
