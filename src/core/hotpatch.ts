import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { ProjectGraph, projectForFile } from "./projects";
import { cacheDirFor, exec, resolveDotnet, toRepoRelative } from "./util";

/**
 * Hot-patch fast path: for method-body-only edits, produce EnC deltas via the
 * resident ImpactDeltas service and push them into every live testhost through
 * the ImpactHotPatch startup-hook pipes — no build, no testhost restart.
 * Everything degrades silently: any miss returns false and the caller takes
 * the ordinary build path.
 */
export class HotPatcher {
  /** Runsettings injected into every test session (hook env). */
  readonly runsettingsFile: string;
  private readonly hotDir: string;
  private readonly pipeBase: string;
  private proc: ChildProcess | undefined;
  private ready = false;
  private broken = false;
  private starting: Promise<boolean> | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (msg: DeltaReply) => void>();
  private readonly loaded = new Set<string>(); // csproj abs paths loaded this epoch
  /** Delta generations pushed since the last real build (epoch). */
  private gen = 0;
  /** Last generation each live testhost accepted, keyed by pid file. */
  private readonly hostGen = new Map<string, number>();
  private onReady: () => void = () => undefined;

  constructor(
    private readonly repoRoot: string,
    /** helper-deltas and helper-hotpatch source dirs shipped with the extension. */
    private readonly deltasSrcDir: string,
    private readonly hookSrcDir: string,
    private readonly log: (m: string) => void = () => undefined
  ) {
    const cache = cacheDirFor(repoRoot);
    this.hotDir = path.join(cache, "hotpatch-hosts");
    this.pipeBase = `impact-${path.basename(cache)}`;
    this.runsettingsFile = path.join(cache, "hot.runsettings");
  }

  /** Write the runsettings (hook dll must exist first); call before sessions start. */
  async prepareRunsettings(): Promise<boolean> {
    try {
      return await this.prepareRunsettingsInner();
    } catch (e) {
      // Never throw: a rejection here used to silently kill session setup.
      this.log(`hot-patch: init failed: ${String(e)}`);
      return false;
    }
  }

  private async prepareRunsettingsInner(): Promise<boolean> {
    const hook = await this.buildHelper(this.hookSrcDir, "ImpactHotPatch");
    if (!hook) return false;
    fs.mkdirSync(this.hotDir, { recursive: true });
    fs.writeFileSync(
      this.runsettingsFile,
      `<RunSettings><RunConfiguration><EnvironmentVariables>
  <DOTNET_MODIFIABLE_ASSEMBLIES>debug</DOTNET_MODIFIABLE_ASSEMBLIES>
  <DOTNET_STARTUP_HOOKS>${hook}</DOTNET_STARTUP_HOOKS>
  <IMPACT_HOTPATCH_PIPE>${this.pipeBase}</IMPACT_HOTPATCH_PIPE>
  <IMPACT_HOTPATCH_DIR>${this.hotDir}</IMPACT_HOTPATCH_DIR>
</EnvironmentVariables></RunConfiguration></RunSettings>\n`
    );
    return true;
  }

  /** Drop all delta state; call after any real build (baselines went stale). */
  reset(): void {
    this.loaded.clear();
    this.gen = 0;
    this.hostGen.clear();
    if (this.proc && this.ready) this.send({ id: this.nextId++, cmd: "reset" });
  }

  /**
   * Freeze a just-written binlog into a source-embedding complog. Must run
   * before the next edit lands in the shadow, so callers await it.
   * Returns the number of compiler calls captured (0 = up-to-date no-op
   * build, complog untouched), or null on failure.
   */
  async snapshot(binlog: string, complog: string): Promise<number | null> {
    if (!(await this.ensureStarted())) return null;
    const r = await this.request({ cmd: "snapshot", binlog, complog });
    if (!r.ok) {
      this.log(`hotpatch: snapshot failed: ${r.reason}`);
      return null;
    }
    return r.calls ?? 0;
  }

  /**
   * Eagerly load a project's baseline right after its build, so the first
   * fast save doesn't pay the complog-load cost. Fire-and-forget.
   */
  preload(csprojAbs: string, complog: string, shadowCsproj: string, dll: string): void {
    void (async () => {
      if (!(await this.ensureStarted()) || this.loaded.has(csprojAbs)) return;
      const r = await this.request({ cmd: "load", binlog: complog, csproj: shadowCsproj, dll });
      if (r.ok) this.loaded.add(csprojAbs);
    })();
  }

  /**
   * Try to satisfy the changed files entirely with hot patches. Returns true
   * only when every file produced a delta AND every live testhost accepted it.
   */
  async tryFastPath(changedRel: string[], graph: ProjectGraph, binlogs: Record<string, string>): Promise<boolean> {
    if (this.broken || changedRel.length === 0) return false;
    if (!changedRel.every((f) => f.endsWith(".cs"))) {
      this.log("hotpatch: non-.cs change — using build path");
      return false;
    }
    const hosts = this.liveHosts();
    if (hosts.length === 0) {
      this.log("hotpatch: no warm testhosts — using build path");
      return false;
    }
    // Coherence gate: a host that (re)started mid-epoch loaded the stale disk
    // dll and never saw the earlier deltas — patching only the newest delta
    // into it would run wrong code. Rebuild instead (which resets the epoch).
    if (this.gen > 0 && hosts.some((h) => (this.hostGen.get(h.pidFile) ?? 0) < this.gen)) {
      this.log("hotpatch: a testhost restarted mid-epoch and missed earlier deltas — using build path");
      this.reset();
      return false;
    }

    const jobs: Array<{ csprojAbs: string; fileAbs: string }> = [];
    for (const rel of changedRel) {
      const abs = path.join(this.repoRoot, rel);
      const owner = projectForFile(graph, abs);
      if (!owner) {
        this.log(`hotpatch: no owning project for ${rel} — using build path`);
        return false;
      }
      const binlog = binlogs[toRepoRelative(this.repoRoot, owner.csproj)];
      if (!binlog || !fs.existsSync(binlog)) {
        this.log(`hotpatch: no baseline yet for ${owner.name} — using build path`);
        return false;
      }
      jobs.push({ csprojAbs: owner.csproj, fileAbs: abs });
    }
    if (!(await this.ensureStarted())) return false;

    // Load projects on demand (once per epoch), then request deltas.
    const deltas: Array<{ assembly: string; md: Buffer; il: Buffer; pdb: Buffer }> = [];
    for (const job of jobs) {
      if (!this.loaded.has(job.csprojAbs)) {
        const rel = toRepoRelative(this.repoRoot, job.csprojAbs);
        const shadowCsproj = this.shadowPathOf(job.csprojAbs);
        const dll = this.builtDllFor(graph, job.csprojAbs);
        if (!dll) return false;
        const r = await this.request({ cmd: "load", binlog: binlogs[rel], csproj: shadowCsproj, dll });
        if (!r.ok) {
          this.log(`hotpatch: load failed for ${rel}: ${r.reason}`);
          return false;
        }
        this.loaded.add(job.csprojAbs);
      }
      const shadowFile = path.join(
        this.shadowDir!,
        toRepoRelative(this.repoRoot, job.fileAbs)
      );
      const r = await this.request({
        cmd: "delta",
        csproj: this.shadowPathOf(job.csprojAbs),
        file: shadowFile,
      });
      if (!r.ok && (r.reason ?? "").startsWith("no-op")) {
        continue; // semantically unchanged file: nothing to patch, not a failure
      }
      if (!r.ok) {
        this.log(`hotpatch: ${path.basename(job.fileAbs)}: ${r.reason} — using build path`);
        return false;
      }
      deltas.push({
        assembly: r.assembly!,
        md: Buffer.from(r.md!, "base64"),
        il: Buffer.from(r.il!, "base64"),
        pdb: Buffer.from(r.pdb!, "base64"),
      });
    }

    // Push every delta to every live testhost. A dead pipe (stale pid file,
    // pid reuse) just drops that host; a live host REFUSING a delta is an
    // inconsistency and forces the build path + reset.
    let patchedHosts = 0;
    for (const host of hosts) {
      let connected = true;
      for (const d of deltas) {
        let okPush: boolean;
        try {
          okPush = await this.push(host, d).catch(async () => {
            // One retry covers the hook's brief re-accept window.
            await new Promise((r) => setTimeout(r, 120));
            return this.push(host, d);
          });
        } catch (e) {
          connected = false; // dead host: prune registration, skip it
          this.log(`hotpatch: host ${path.basename(host.pidFile)} unreachable (${(e as Error).message}); pruned`);
          try {
            fs.rmSync(host.pidFile, { force: true });
          } catch {
            /* ignore */
          }
          break;
        }
        if (!okPush) {
          this.log(`hotpatch: testhost rejected delta; using build path`);
          this.reset(); // patched state may now be inconsistent across hosts
          return false;
        }
      }
      if (connected) patchedHosts++;
    }
    if (deltas.length > 0 && patchedHosts === 0) {
      // Nothing accepted the patch: fresh testhosts would load stale disk
      // assemblies. Only the build path is safe.
      this.log("hotpatch: no live testhost accepted patches; using build path");
      this.reset();
      return false;
    }
    if (deltas.length > 0) {
      this.gen++;
      for (const host of hosts) {
        if (fs.existsSync(host.pidFile)) this.hostGen.set(host.pidFile, this.gen);
      }
    }
    this.log(`hotpatch: applied ${deltas.length} delta(s) to ${patchedHosts} testhost(s)`);
    return true;
  }

  /** Shadow worktree dir; set by the runner before use. */
  shadowDir: string | undefined;

  private shadowPathOf(absInRepo: string): string {
    return path.join(this.shadowDir!, toRepoRelative(this.repoRoot, absInRepo));
  }

  private builtDllFor(graph: ProjectGraph, csprojAbs: string): string | undefined {
    const info = graph.projects.get(path.resolve(csprojAbs).toLowerCase());
    if (!info || !this.shadowDir) return undefined;
    // Lazy import avoids a cycle with staticmap.
    const { findBuiltDll } = require("./staticmap") as typeof import("./staticmap");
    return findBuiltDll(this.shadowDir, info, this.repoRoot);
  }

  private liveHosts(): Array<{ pidFile: string; pipeName: string }> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.hotDir);
    } catch {
      return [];
    }
    const hosts: Array<{ pidFile: string; pipeName: string }> = [];
    for (const e of entries) {
      const pidFile = path.join(this.hotDir, e);
      try {
        process.kill(Number(e), 0); // alive?
        hosts.push({ pidFile, pipeName: fs.readFileSync(pidFile, "utf8").trim() });
      } catch {
        try {
          fs.rmSync(pidFile, { force: true }); // stale registration
        } catch {
          /* ignore */
        }
      }
    }
    return hosts;
  }

  private push(
    host: { pipeName: string },
    d: { assembly: string; md: Buffer; il: Buffer; pdb: Buffer }
  ): Promise<boolean> {
    const pipePath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${host.pipeName}`
        : path.join(os.tmpdir(), `CoreFxPipe_${host.pipeName}`);
    return new Promise<boolean>((resolve, reject) => {
      const sock = net.connect(pipePath, () => {
        const name = Buffer.from(d.assembly, "utf8");
        const parts: Buffer[] = [];
        for (const b of [name, d.md, d.il, d.pdb]) {
          const len = Buffer.alloc(4);
          len.writeInt32LE(b.length);
          parts.push(len, b);
        }
        sock.write(Buffer.concat(parts));
      });
      sock.on("data", (buf) => {
        sock.end();
        resolve(buf[0] === 1);
      });
      sock.on("error", reject);
      setTimeout(() => reject(new Error("hotpatch pipe timeout")), 5000);
    });
  }

  // ---- delta service process management ----

  private async buildHelper(srcDir: string, name: string): Promise<string | undefined> {
    const bin = path.join(cacheDirFor(this.repoRoot), `${name.toLowerCase()}-bin`);
    const dll = path.join(bin, `${name}.dll`);
    const stamp = path.join(bin, ".source-stamp");
    const src = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith(".cs") || f.endsWith(".csproj"))
      .sort()
      .map((f) => fs.readFileSync(path.join(srcDir, f), "utf8"))
      .join("\n");
    const want = hash(src);
    try {
      if (fs.existsSync(dll) && fs.readFileSync(stamp, "utf8") === want) return dll;
    } catch {
      /* rebuild */
    }
    this.log(`building ${name} helper (one-time)…`);
    const csproj = fs.readdirSync(srcDir).find((f) => f.endsWith(".csproj"))!;
    const res = await exec(
      "dotnet",
      ["build", path.join(srcDir, csproj), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
      srcDir,
      5 * 60 * 1000
    );
    if (res.code !== 0 || !fs.existsSync(dll)) {
      this.log(`${name} helper build failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
      return undefined;
    }
    fs.writeFileSync(stamp, want);
    return dll;
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.broken) return false;
    if (this.proc && this.ready) return true;
    this.starting ??= this.start();
    const ok = await this.starting;
    if (!ok) this.starting = null;
    return ok;
  }

  private async start(): Promise<boolean> {
    try {
      this.buffer = "";
      const dll = await this.buildHelper(this.deltasSrcDir, "ImpactDeltas");
      if (!dll) {
        this.broken = true;
        return false;
      }
      const dotnet = resolveDotnet();
      const env = { ...process.env };
      if (path.isAbsolute(dotnet)) {
        env.DOTNET_ROOT = path.dirname(dotnet);
        env.PATH = `${path.dirname(dotnet)}${path.delimiter}${env.PATH ?? ""}`;
      }
      this.proc = spawn(dotnet, [dll], { cwd: this.repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
      this.proc.on("error", () => {
        this.ready = false;
        this.proc = undefined;
      });
      this.proc.stdin!.on("error", () => undefined);
      this.proc.on("exit", () => {
        this.ready = false;
        this.proc = undefined;
        this.loaded.clear();
        for (const [, resolve] of this.pending) resolve({ ok: false, reason: "service exited" });
        this.pending.clear();
      });
      this.proc.stdout!.on("data", (d: Buffer) => this.onData(d.toString()));
      this.proc.stderr!.on("data", () => undefined);
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 30_000);
        this.onReady = () => {
          clearTimeout(t);
          resolve(true);
        };
      });
      if (!ok) {
        this.dispose();
        return false;
      }
      this.ready = true;
      this.log("hot-patch delta service ready");
      return true;
    } catch (e) {
      this.log(`delta service start failed: ${String(e)}`);
      this.broken = true;
      return false;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: DeltaReply & { id?: number; type?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "ready") {
        this.onReady();
        continue;
      }
      if (msg.id !== undefined) {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    }
  }

  private send(cmd: object): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(cmd) + "\n");
    } catch {
      /* exit handler flushes pending */
    }
  }

  private request(cmd: Record<string, unknown>): Promise<DeltaReply> {
    const id = this.nextId++;
    return new Promise<DeltaReply>((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, ...cmd });
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, reason: "timeout" });
      }, 30_000);
    });
  }

  dispose(): void {
    try {
      this.send({ cmd: "shutdown" });
      const proc = this.proc;
      setTimeout(() => proc?.kill(), 1000);
    } catch {
      /* ignore */
    }
    this.ready = false;
    this.proc = undefined;
    this.starting = null;
  }
}

interface DeltaReply {
  ok: boolean;
  reason?: string;
  calls?: number;
  assembly?: string;
  md?: string;
  il?: string;
  pdb?: string;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
