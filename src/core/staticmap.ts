import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ProjectGraph, ProjectInfo, testProjects } from "./projects";
import { cacheDirFor, exec, resolveDotnet, toRepoRelative } from "./util";

export interface StaticMapResult {
  /**
   * test class FQN -> { csproj (repo-relative), files (repo-relative),
   * abstractFiles: files of DIRECTLY referenced interfaces/abstract classes
   * (self-tuning map, #31) }.
   */
  classes: Record<string, { csproj: string; files: string[]; abstractFiles?: string[] }>;
  /**
   * Solution top-level type FQN -> its source files. Lets the extension
   * resolve type names found in DI registration calls back to files (#31).
   * Absent on older helper builds.
   */
  types?: Record<string, string[]>;
  skipped: Array<{ assembly: string; reason: string }>;
}

/** Newest built dll for a project inside `rootDir` (skips ref/ metadata assemblies). */
export function findBuiltDll(rootDir: string, info: ProjectInfo, repoRoot: string): string | undefined {
  const rel = path.relative(repoRoot, info.dir);
  const binDir = path.join(rootDir, rel, "bin");
  let best: { p: string; mtime: number } | undefined;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name.toLowerCase() !== "ref") walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase() === `${info.assemblyName.toLowerCase()}.dll`) {
        // A build may replace the dll between readdir and stat; a vanished
        // file is absent, not fatal.
        let mtime: number;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          continue;
        }
        if (!best || mtime > best.mtime) best = { p, mtime };
      }
    }
  };
  walk(binDir, 0);
  return best?.p;
}

/**
 * All built copies of a project's assembly, one (the newest) per target
 * framework directory. Multi-TFM test projects build one dll per TFM; running
 * only the newest-built one silently skips the other framework's tests.
 */
export function findBuiltDlls(rootDir: string, info: ProjectInfo, repoRoot: string): string[] {
  const rel = path.relative(repoRoot, info.dir);
  const binDir = path.join(rootDir, rel, "bin");
  const bestPerTfm = new Map<string, { p: string; mtime: number }>();
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name.toLowerCase() !== "ref") walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase() === `${info.assemblyName.toLowerCase()}.dll`) {
        const tfm = path.basename(path.dirname(p)).toLowerCase();
        let mtime: number;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          continue; // replaced between readdir and stat
        }
        const best = bestPerTfm.get(tfm);
        if (!best || mtime > best.mtime) bestPerTfm.set(tfm, { p, mtime });
      }
    }
  };
  walk(binDir, 0);
  return [...bestPerTfm.values()].map((b) => b.p).sort();
}

/**
 * Build (once) and run the ImpactStaticMap helper: reads the built assemblies'
 * IL metadata + portable PDBs and returns each test class's transitive
 * type-reference closure as source files. Requires the shadow to be built.
 */
export class StaticMapper {
  constructor(
    private readonly repoRoot: string,
    /** Helper source dir shipped with the extension (helper-static/). */
    private readonly helperSrcDir: string,
    private readonly log: (msg: string) => void = () => undefined
  ) {}

  private async ensureHelper(): Promise<{ dll: string; stamp: string } | null> {
    const bin = path.join(cacheDirFor(this.repoRoot), "staticmap-bin");
    const dll = path.join(bin, "ImpactStaticMap.dll");
    const stamp = path.join(bin, ".source-stamp");
    const src =
      fs.readFileSync(path.join(this.helperSrcDir, "Program.cs"), "utf8") +
      fs.readFileSync(path.join(this.helperSrcDir, "ImpactStaticMap.csproj"), "utf8");
    const want = hash(src);
    try {
      if (fs.existsSync(dll) && fs.readFileSync(stamp, "utf8") === want) return { dll, stamp: want };
    } catch {
      /* rebuild */
    }
    this.log("building static map helper (one-time)…");
    const res = await exec(
      "dotnet",
      ["build", path.join(this.helperSrcDir, "ImpactStaticMap.csproj"), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
      this.helperSrcDir,
      5 * 60 * 1000
    );
    if (res.code !== 0 || !fs.existsSync(dll)) {
      this.log(`static map helper build failed: ${(res.stderr || res.stdout).slice(0, 400)}`);
      return null;
    }
    fs.writeFileSync(stamp, want);
    return { dll, stamp: want };
  }

  /**
   * Compute the static map over `shadowDir`'s built assemblies. Returns null
   * when the helper is unavailable or produces nothing usable — the caller
   * reports the failure and leaves the existing map untouched.
   */
  /** Resident helper (H12); swapped when the helper binary or shadow changes. */
  private resident?: ResidentStaticHelper;
  /** The live resident helper (diagnostics/tests); undefined until first compute. */
  get residentHelper(): ResidentStaticHelper | undefined {
    return this.resident;
  }
  /** Test seam: force the one-shot path (no resident spawn). */
  residentDisabled = false;

  /**
   * Resident path (H12): a long-lived helper process reuses the parsed IL
   * graph of unchanged assemblies, so a rebuild that touched a subset of the
   * solution re-parses only those. Returns null on any failure so the caller
   * falls through to the one-shot process (never worse than pre-H12).
   */
  private async tryResident(
    helper: { dll: string; stamp: string },
    shadowDir: string,
    assemblies: Array<{ csproj: string; dll: string; isTest: boolean }>
  ): Promise<StaticMapResult | null> {
    if (this.residentDisabled) return null;
    if (
      this.resident &&
      (this.resident.dllPath !== helper.dll ||
        this.resident.stamp !== helper.stamp ||
        this.resident.shadowDir !== shadowDir)
    ) {
      this.resident.dispose();
      this.resident = undefined;
    }
    if (!this.resident) {
      this.resident = new ResidentStaticHelper(helper.dll, helper.stamp, shadowDir, this.log);
    }
    const served = await this.resident.mapRequest(shadowDir, assemblies);
    if (!served) return null;
    for (const s of served.map.skipped ?? []) {
      this.log(`static map skipped ${path.basename(s.assembly)}: ${s.reason}`);
    }
    return served.map;
  }

  /** Kill the resident helper process (extension deactivate / test teardown). */
  dispose(): void {
    this.resident?.dispose();
    this.resident = undefined;
  }

  async compute(shadowDir: string, graph: ProjectGraph): Promise<StaticMapResult | null> {
    const helper = await this.ensureHelper();
    if (!helper) return null;

    const testSet = new Set(testProjects(graph).map((p) => p.csproj.toLowerCase()));
    const assemblies: Array<{ csproj: string; dll: string; isTest: boolean }> = [];
    const missing: string[] = [];
    for (const p of graph.projects.values()) {
      const dll = findBuiltDll(shadowDir, p, this.repoRoot);
      if (dll) {
        assemblies.push({
          csproj: toRepoRelative(this.repoRoot, p.csproj),
          dll,
          isTest: testSet.has(p.csproj.toLowerCase()),
        });
      } else {
        missing.push(p.name);
      }
    }
    if (missing.length > 0) this.log(`static map: no built output for ${missing.join(", ")}`);
    if (assemblies.length === 0) return null;

    const servedMap = await this.tryResident(helper, shadowDir, assemblies);
    if (servedMap) return servedMap;

    // One-shot fallback (the pre-H12 path; also used when the resident helper
    // cannot start or is unhealthy).
    const inputFile = path.join(cacheDirFor(this.repoRoot), "staticmap-input.json");
    fs.mkdirSync(path.dirname(inputFile), { recursive: true });
    fs.writeFileSync(inputFile, JSON.stringify(assemblies));

    const res = await exec(
      "dotnet",
      [helper.dll, "--repo-root", shadowDir, "--assemblies", inputFile],
      shadowDir,
      5 * 60 * 1000
    );
    if (res.code !== 0) {
      this.log(`static map helper failed: ${(res.stderr || res.stdout).slice(0, 400)}`);
      return null;
    }
    try {
      const parsed = JSON.parse(res.stdout) as StaticMapResult;
      for (const s of parsed.skipped ?? []) {
        this.log(`static map skipped ${path.basename(s.assembly)}: ${s.reason}`);
      }
      return parsed;
    } catch (e) {
      this.log(`static map output unparseable: ${String(e)}`);
      return null;
    }
  }
}

interface ServeReply {
  id: number;
  ok: boolean;
  error?: string;
  result?: StaticMapResult;
  stats?: { parsed: number; cached: number };
}

/**
 * Resident ImpactStaticMap helper (H12): one long-lived `dotnet` process per
 * repo speaks line-delimited JSON over stdin/stdout (same protocol family as
 * the hot-patch delta service). The process keeps each assembly's parsed type
 * records in memory keyed by (path, mtime, size) + PDB stat, so a map request
 * re-parses only assemblies that were actually rebuilt.
 *
 * Requests are serialized (the engine is single-threaded and a request may
 * parse the whole solution); failures resolve null so the caller can fall
 * back to a one-shot process.
 */
export class ResidentStaticHelper {
  readonly dllPath: string;
  readonly stamp: string;
  readonly shadowDir: string;
  /** The helper process's pid (undefined while stopped); diagnostics + tests. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }
  private proc: ChildProcess | undefined;
  private ready = false;
  private starting: Promise<boolean> | null = null;
  private broken = false;
  private onReady: (() => void) | null = null;
  private pending = new Map<number, (r: ServeReply) => void>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly log: (msg: string) => void;
  /** Stats (parsed/cached assembly counts) of the last successful request. */
  lastStats?: { parsed: number; cached: number };
  /** Idle reaper: retires the helper after a quiet period (see armIdle). */
  private idleTimer: NodeJS.Timeout | undefined;

  /**
   * The helper's stdio pipes keep the parent's event loop alive, so a
   * forgotten helper would block process exit (test processes, CLI runs).
   * An idle reaper retires the helper after a quiet period; the next
   * request simply respawns it (the C# side also exits on stdin EOF, so a
   * crashed parent is always cleaned up). The timer itself is unref'd so it
   * never blocks exit on its own.
   */
  /** Idle retirement window in ms (tests shorten it). */
  idleTimeoutMs = 90_000;
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.log("static map helper idle — retiring");
      this.dispose();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  /** Every live helper is killed on process exit so CLI runs don't leak it. */
  static live = new Set<ResidentStaticHelper>();
  private static exitHooked = false;

  constructor(dllPath: string, stamp: string, shadowDir: string, log: (msg: string) => void) {
    this.dllPath = dllPath;
    this.stamp = stamp;
    this.shadowDir = shadowDir;
    this.log = log;
    ResidentStaticHelper.live.add(this);
    if (!ResidentStaticHelper.exitHooked) {
      ResidentStaticHelper.exitHooked = true;
      process.on("exit", () => {
        for (const h of [...ResidentStaticHelper.live]) h.dispose(true);
      });
    }
  }

  private async ensureReady(): Promise<boolean> {
    if (this.broken) return false;
    if (this.proc && this.ready) return true;
    this.starting ??= this.start();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  private async start(): Promise<boolean> {
    try {
      this.lineParts = [];
      const dotnet = resolveDotnet();
      const env = { ...process.env };
      if (path.isAbsolute(dotnet)) {
        env.DOTNET_ROOT = path.dirname(dotnet);
        env.PATH = `${path.dirname(dotnet)}${path.delimiter}${env.PATH ?? ""}`;
      }
      this.proc = spawn(dotnet, [this.dllPath, "--serve"], {
        cwd: this.shadowDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Last stats of the previous successful request (tests + diagnostics).
      this.lastStats = undefined;
      this.proc.on("error", () => {
        this.ready = false;
        this.proc = undefined;
      });
      this.proc.stdin!.on("error", () => undefined);
      this.proc.on("exit", () => {
        this.ready = false;
        this.proc = undefined;
        for (const [, resolve] of this.pending) resolve({ id: -1, ok: false, error: "helper exited" });
        this.pending.clear();
      });
      this.proc.stdout!.on("data", (d: Buffer) => this.onData(d));
      // Silent by default; IMPACT_STATIC_DEBUG=1 surfaces the helper's stderr.
      this.proc.stderr!.on("data", (d: Buffer) => {
        if (process.env.IMPACT_STATIC_DEBUG === "1") {
          for (const line of d.toString().split("\n")) if (line.trim()) this.log(line.trim());
        }
      });
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 60_000);
        this.onReady = () => {
          clearTimeout(t);
          resolve(true);
        };
      });
      if (!ok) {
        this.dispose(true);
        return false;
      }
      this.ready = true;
      // The child itself never counts toward parent liveness; the idle
      // reaper handles the stdio-pipe hold on the event loop.
      this.proc.unref();
      this.log("static map helper resident ready");
      this.armIdle();
      return true;
    } catch (e) {
      this.log(`static map helper start failed: ${String(e)}`);
      this.broken = true;
      return false;
    }
  }

  /**
   * Buffer-based line splitting: per-chunk work is just a memcpy + a memchr
   * scan. The old string approach re-decoded and re-concatenated the whole
   * accumulated (multi-MB map) line on every chunk, which throttled the pipe
   * drain and cost ~60ms on a cold full-map response.
   */
  /** Incomplete-line chunks (zero-copy references; concatenated once per line). */
  private lineParts: Buffer[] = [];

  /**
   * Line splitting that stays O(n) in the total byte count: each chunk is
   * memchr-scanned once and kept as a reference; a line is materialized
   * (concat + decode) exactly once, when its newline arrives. Re-concatening
   * a growing multi-MB buffer per chunk was O(n²) and throttled the pipe
   * drain, adding ~300ms to a cold full-map response.
   */
  private onData(chunk: Buffer): void {
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf(10);
      if (nl === -1) {
        this.lineParts.push(rest);
        return;
      }
      this.lineParts.push(rest.subarray(0, nl));
      const line = Buffer.concat(this.lineParts).toString("utf8").trim();
      this.lineParts = [];
      rest = rest.subarray(nl + 1);
      if (line) this.handleLine(line);
      if (rest.length === 0) return;
    }
  }

  private handleLine(line: string): void {
    let msg: ServeReply & { ready?: boolean };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.ready) {
      this.onReady?.();
      return;
    }
    if (typeof msg.id === "number") {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  /**
   * Request a full map computation. Resolves the parsed map (+ the helper's
   * parsed/cached assembly stats), or null when the resident path is
   * unavailable (caller falls back to one-shot).
   */
  mapRequest(
    shadowDir: string,
    assemblies: Array<{ csproj: string; dll: string; isTest: boolean }>,
    timeoutMs = 5 * 60 * 1000
  ): Promise<{ map: StaticMapResult; stats?: { parsed: number; cached: number } } | null> {
    const run = this.chain.then(async () => {
      if (!(await this.ensureReady())) return null;
      const id = this.nextId++;
      this.armIdle(); // in-flight work extends the idle window
      // The timeout timer is cleared on every resolution path: a leftover
      // ref'd 5-minute timer would otherwise hold the process open after the
      // last request (verified: dispose() + exit hung for 5 minutes).
      let timeoutTimer: NodeJS.Timeout | undefined;
      const reply = await new Promise<ServeReply>((resolve) => {
        this.pending.set(id, resolve);
        try {
          this.proc?.stdin?.write(
            JSON.stringify({ id, op: "map", repoRoot: shadowDir, assemblies }) + "\n"
          );
        } catch {
          this.pending.delete(id);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          resolve({ id, ok: false, error: "write failed" });
        }
        timeoutTimer = setTimeout(() => {
          if (this.pending.delete(id)) resolve({ id, ok: false, error: "timeout" });
        }, timeoutMs);
      });
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (reply.ok && reply.result) {
        this.lastStats = reply.stats;
        this.armIdle();
        return { map: reply.result, stats: reply.stats };
      }
      // A timeout may be a slow-but-healthy computation; only unhealthy
      // replies (exit / write failure / protocol error) retire the process.
      if (reply.error !== "timeout") {
        this.log(`resident static map helper unhealthy (${reply.error}) — using one-shot`);
        this.dispose();
      }
      return null;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  dispose(immediate = false): void {
    const proc = this.proc;
    this.ready = false;
    this.proc = undefined;
    this.starting = null;
    this.onReady = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    ResidentStaticHelper.live.delete(this);
    for (const [, resolve] of this.pending) resolve({ id: -1, ok: false, error: "disposed" });
    this.pending.clear();
    if (!proc) return;
    if (immediate) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      return;
    }
    try {
      proc.stdin?.write(JSON.stringify({ id: 0, op: "shutdown" }) + "\n");
    } catch {
      /* fall through to the kill timer */
    }
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, 1000).unref();
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
