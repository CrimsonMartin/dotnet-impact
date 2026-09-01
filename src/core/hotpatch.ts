import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { ProjectGraph, projectForFile } from "./projects";
import { cacheDirFor, exec, resolveDotnet, toRepoRelative } from "./util";

/**
 * Hot-patch fast path: for edits Roslyn's EnC engine accepts (method bodies,
 * added methods/fields/types, lambdas), produce deltas via the
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
      const caps = intersectCapabilities(this.liveHosts().map((h) => h.capabilities));
      const r = await this.request({
        cmd: "load",
        binlog: complog,
        csproj: shadowCsproj,
        dll,
        ...(caps ? { caps } : {}),
      });
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

    // One save can span several files and projects: group by owning project
    // so each project's edits enter a single emit (#11 P3) — per-file emits
    // would refuse interdependent edits (a method added in one file, called
    // from another) that the engine accepts together.
    const byProject = new Map<string, string[]>(); // csprojAbs -> changed file abs paths
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
      if (!byProject.has(owner.csproj)) byProject.set(owner.csproj, []);
      byProject.get(owner.csproj)!.push(abs);
    }
    if (!(await this.ensureStarted())) return false;

    // What the live hosts can actually apply (#11 P2), sent with each load so
    // the engine refuses edits the runtimes can't take instead of emitting
    // deltas that would die at ApplyUpdate.
    const caps = intersectCapabilities(hosts.map((h) => h.capabilities));

    // The engine can only hot-patch an API change when every project consuming
    // it recompiles inside the same session (#22): pull the owners' transitive
    // dependents (those with baselines) into the session, and exempt an owner
    // from the API-surface guard only when ALL its dependents made it in.
    const hasBaseline = (csprojAbs: string): boolean => {
      const b = binlogs[toRepoRelative(this.repoRoot, csprojAbs)];
      return !!b && fs.existsSync(b);
    };
    const { exemptAbs, loadAlsoAbs } = apiGuardExemptFor(graph, [...byProject.keys()], hasBaseline);

    // Load owners + dependents on demand (once per epoch). Mid-epoch loads
    // are refused by the service (session restarts would corrupt generation
    // chaining), which lands here as a load failure → build path → reset.
    for (const csprojAbs of new Set([...byProject.keys(), ...loadAlsoAbs])) {
      if (this.loaded.has(csprojAbs)) continue;
      const rel = toRepoRelative(this.repoRoot, csprojAbs);
      const shadowCsproj = this.shadowPathOf(csprojAbs);
      const dll = this.builtDllFor(graph, csprojAbs);
      if (!dll) return false;
      const r = await this.request({
        cmd: "load",
        binlog: binlogs[rel],
        csproj: shadowCsproj,
        dll,
        ...(caps ? { caps } : {}),
      });
      if (!r.ok) {
        this.log(`hotpatch: load failed for ${rel}: ${r.reason}`);
        return false;
      }
      this.loaded.add(csprojAbs);
    }

    // One solution-wide emit for the whole save (#22): every changed file in
    // one request, so cross-project edits are analyzed together and the reply
    // may carry one delta per touched module.
    const filesAbs = [...byProject.values()].flat();
    const label = filesAbs.map((f) => path.basename(f)).join("+");
    const deltas: Array<{ assembly: string; md: Buffer; il: Buffer; pdb: Buffer }> = [];
    const r = await this.request({
      cmd: "delta",
      files: filesAbs.map((f) => path.join(this.shadowDir!, toRepoRelative(this.repoRoot, f))),
      ...(exemptAbs.length > 0 ? { apiGuardExempt: exemptAbs.map((p) => this.shadowPathOf(p)) } : {}),
    });
    if (!r.ok && (r.reason ?? "").startsWith("no-op")) {
      // Semantically unchanged file(s): nothing to patch, not a failure — but
      // say so. A no-op on an edit the user believes is real is the one trace
      // of a stale baseline, and it must never vanish silently.
      this.log(`hotpatch: ${label}: ${r.reason}`);
    } else if (!r.ok) {
      this.log(`hotpatch: ${label}: ${r.reason} — using build path`);
      return false;
    } else {
      const updates =
        r.updates ??
        (r.assembly ? [{ assembly: r.assembly, md: r.md!, il: r.il!, pdb: r.pdb! }] : []);
      for (const u of updates) {
        deltas.push({
          assembly: u.assembly,
          md: Buffer.from(u.md, "base64"),
          il: Buffer.from(u.il, "base64"),
          pdb: Buffer.from(u.pdb, "base64"),
        });
      }
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

  private liveHosts(): LiveHost[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.hotDir);
    } catch {
      return [];
    }
    const hosts: LiveHost[] = [];
    for (const e of entries) {
      const pidFile = path.join(this.hotDir, e);
      try {
        process.kill(Number(e), 0); // alive?
        hosts.push({ pidFile, ...parseHostRegistration(fs.readFileSync(pidFile, "utf8")) });
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

  private async buildHelper(
    srcDir: string,
    name: string,
    extraSrcDirs: string[] = []
  ): Promise<string | undefined> {
    const bin = path.join(cacheDirFor(this.repoRoot), `${name.toLowerCase()}-bin`);
    const dll = path.join(bin, `${name}.dll`);
    const stamp = path.join(bin, ".source-stamp");
    const src = [srcDir, ...extraSrcDirs]
      .flatMap((dir) => {
        try {
          return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".cs") || f.endsWith(".csproj") || f.endsWith(".snk"))
            .sort()
            .map((f) => fs.readFileSync(path.join(dir, f)).toString("base64"));
        } catch {
          return [];
        }
      })
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
      // helper-enc is a ProjectReference of the delta service: its sources
      // must participate in the rebuild stamp.
      const dll = await this.buildHelper(this.deltasSrcDir, "ImpactDeltas", [
        path.join(this.deltasSrcDir, "..", "helper-enc"),
      ]);
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
      // Silent by default; IMPACT_ENC_DEBUG=1 surfaces the service's
      // diagnostics (checksum dumps, delta text comparisons) in the log.
      this.proc.stderr!.on("data", (d: Buffer) => {
        if (process.env.IMPACT_ENC_DEBUG === "1") {
          for (const line of d.toString().split("\n")) if (line.trim()) this.log(line.trim());
        }
      });
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

interface LiveHost {
  pidFile: string;
  pipeName: string;
  /** Runtime hot-reload capabilities the host reported; undefined = unknown. */
  capabilities?: string[];
}

/**
 * Fallback capability set for hosts that predate the handshake (registration
 * with no capabilities line). Mirrors the delta service's modern-CoreCLR
 * default; a wrong guess dies at ApplyUpdate and forces the build path.
 */
export const DEFAULT_HOST_CAPABILITIES = [
  "Baseline",
  "AddMethodToExistingType",
  "AddStaticFieldToExistingType",
  "AddInstanceFieldToExistingType",
  "NewTypeDefinition",
  "ChangeCustomAttributes",
  "UpdateParameters",
  "GenericUpdateMethod",
  "GenericAddMethodToExistingType",
  "GenericAddFieldToExistingType",
];

/**
 * Registration file written by the startup hook: line 1 the host's pipe name,
 * line 2 (since #11 P2) its space-separated runtime capability set.
 */
export function parseHostRegistration(content: string): { pipeName: string; capabilities?: string[] } {
  const lines = content.split(/\r?\n/);
  const pipeName = (lines[0] ?? "").trim();
  const caps = (lines[1] ?? "").trim();
  return caps.length > 0 ? { pipeName, capabilities: caps.split(/\s+/) } : { pipeName };
}

/**
 * Capabilities EVERY live host can apply — the only set safe to emit against.
 * A host with an unknown set contributes the pre-handshake default, so mixed
 * old/new fleets behave exactly as before. No hosts → null (caller lets the
 * delta service use its own default).
 */
export function intersectCapabilities(reported: Array<string[] | undefined>): string[] | null {
  if (reported.length === 0) return null;
  const sets = reported.map((caps) => new Set<string>(caps ?? DEFAULT_HOST_CAPABILITIES));
  const out: string[] = [];
  for (const c of sets[0]) if (sets.every((s) => s.has(c))) out.push(c);
  return out;
}

/**
 * Which changed projects may skip the cross-project API-surface guard, and
 * which additional projects must join the session for that to be sound (#22).
 *
 * An owner is exempt only when EVERY transitive dependent (graph reverse
 * edges) has a baseline — then the engine sees the whole consumer set and can
 * judge an API change itself (emit updates for dependents, or rude-edit).
 * Any dependent without a baseline stays invisible to the session, so the
 * guard keeps refusing exactly as it did pre-#22. Dependents WITH baselines
 * are returned for loading either way: recompiling them inside the session is
 * never wrong, and partial coverage still helps body-level edits.
 */
export function apiGuardExemptFor(
  graph: ProjectGraph,
  ownersAbs: string[],
  hasBaseline: (csprojAbs: string) => boolean
): { exemptAbs: string[]; loadAlsoAbs: string[] } {
  const normKey = (p: string): string => path.resolve(p).toLowerCase();
  const exemptAbs: string[] = [];
  const loadAlso = new Set<string>();
  for (const owner of ownersAbs) {
    const seen = new Set<string>([normKey(owner)]);
    const queue = [normKey(owner)];
    let allCovered = true;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const parentKey of graph.referencedBy.get(cur) ?? []) {
        if (seen.has(parentKey)) continue;
        seen.add(parentKey);
        queue.push(parentKey);
        const parent = graph.projects.get(parentKey);
        if (!parent) {
          allCovered = false;
          continue;
        }
        if (hasBaseline(parent.csproj)) loadAlso.add(parent.csproj);
        else allCovered = false;
      }
    }
    if (allCovered) exemptAbs.push(owner);
  }
  return { exemptAbs, loadAlsoAbs: [...loadAlso] };
}

interface DeltaReply {
  ok: boolean;
  reason?: string;
  calls?: number;
  assembly?: string;
  md?: string;
  il?: string;
  pdb?: string;
  /** Solution-wide emits (#22): one entry per touched module. */
  updates?: Array<{ assembly: string; md: string; il: string; pdb: string }>;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
