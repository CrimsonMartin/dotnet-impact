import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TestOutcome } from "./runner";
import { cacheDirFor, exec, ExecResult, resolveDotnet } from "./util";

interface HelperTest {
  fqn: string;
  display: string;
  outcome: "passed" | "failed" | "skipped";
  durationMs: number;
  message?: string;
}

export interface SessionRunResult {
  ok: boolean;
  outcomes: TestOutcome[];
  output: string;
}

/**
 * Class FQN from a test-case FQN: everything before the last top-level dot.
 * Paren-aware so NUnit parameterized fixtures ("Ns.Fixture(1).Method(2)")
 * keep the fixture args on the class, matching the TRX className.
 */
export function classOf(fqn: string): string {
  let depth = 0;
  let lastDot = -1;
  for (let i = 0; i < fqn.length; i++) {
    const ch = fqn[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "." && depth === 0) lastDot = i;
  }
  return lastDot > 0 ? fqn.slice(0, lastDot) : fqn;
}

/**
 * Persistent test runner: builds and manages the shipped C# helper, which
 * keeps vstest.console + pre-warmed testhost sessions alive between runs so
 * an incremental run costs milliseconds of dispatch instead of seconds of
 * startup. All methods degrade gracefully: any failure marks the runner
 * unavailable and callers fall back to plain `dotnet test`.
 */
export class SessionRunner {
  private proc: ChildProcess | undefined;
  private ready = false;
  private broken = false;
  private startFailures = 0;
  private disposed = false;
  private nextId = 1;
  private buffer = "";
  private starting: Promise<boolean> | null = null;
  private readonly pending = new Map<
    number,
    { tests: HelperTest[]; resolve: (r: { ok: boolean; error?: string }) => void }
  >();
  /** Serializes runs: the helper handles one command at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private stderrTail: string[] = [];

  constructor(
    private readonly repoRoot: string,
    /** Absolute path to the helper source dir shipped with the extension. */
    private readonly helperSrcDir: string,
    private readonly log: (msg: string) => void = () => undefined,
    /** Optional runsettings file applied to every session/run (hot-patch env). */
    private readonly runsettingsFile?: string
  ) {}

  get available(): boolean {
    return !this.broken;
  }

  private helperBinDir(): string {
    return path.join(cacheDirFor(this.repoRoot), "helper-bin");
  }

  private async findVstestConsole(): Promise<string | undefined> {
    const res = await exec("dotnet", ["--list-sdks"], this.repoRoot);
    // lines like: "10.0.400 [/home/user/.dotnet/sdk]"
    let best: { version: string; p: string } | undefined;
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/^(\d+\.\d+\.\d+[^ ]*) \[(.+)\]$/);
      if (!m) continue;
      const p = path.join(m[2], m[1], "vstest.console.dll");
      if (!fs.existsSync(p)) continue;
      if (!best || compareVersions(m[1], best.version) > 0) best = { version: m[1], p };
    }
    return best?.p;
  }

  private async buildHelper(): Promise<string | undefined> {
    const bin = this.helperBinDir();
    const dll = path.join(bin, "ImpactRunner.dll");
    const stamp = path.join(bin, ".source-stamp");
    const src =
      fs.readFileSync(path.join(this.helperSrcDir, "Program.cs"), "utf8") +
      fs.readFileSync(path.join(this.helperSrcDir, "ImpactRunner.csproj"), "utf8");
    try {
      if (fs.existsSync(dll) && fs.readFileSync(stamp, "utf8") === hash(src)) return dll;
    } catch {
      /* rebuild */
    }
    this.log("building persistent test runner helper (one-time)…");
    const res: ExecResult = await exec(
      "dotnet",
      ["build", path.join(this.helperSrcDir, "ImpactRunner.csproj"), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
      this.helperSrcDir,
      5 * 60 * 1000
    );
    if (res.code !== 0 || !fs.existsSync(dll)) {
      this.log(`helper build failed: ${(res.stderr || res.stdout).slice(0, 500)}`);
      return undefined;
    }
    fs.writeFileSync(stamp, hash(src));
    return dll;
  }

  /** Start (or confirm) the helper. Returns false if unavailable. */
  async ensureStarted(): Promise<boolean> {
    if (this.broken) return false;
    if (this.proc && this.ready) return true;
    this.starting ??= this.start();
    const ok = await this.starting;
    if (!ok) this.starting = null;
    return ok;
  }

  private async start(): Promise<boolean> {
    try {
      this.disposed = false;
      this.buffer = ""; // a killed helper may have left a partial line behind
      const vstest = await this.findVstestConsole();
      if (!vstest) {
        this.log("no vstest.console.dll found in any SDK; persistent sessions off");
        this.broken = true; // structural: no retry will change this
        return false;
      }
      const dll = await this.buildHelper();
      if (!dll) {
        this.broken = true; // structural: helper source doesn't build here
        return false;
      }
      if (this.disposed) return false; // disposed while we were building
      const dotnet = resolveDotnet();
      const env = { ...process.env };
      if (path.isAbsolute(dotnet)) {
        env.DOTNET_ROOT = path.dirname(dotnet);
        env.PATH = `${path.dirname(dotnet)}${path.delimiter}${env.PATH ?? ""}`;
      }
      const helperArgs = [dll, vstest];
      if (this.runsettingsFile) helperArgs.push(this.runsettingsFile);
      this.proc = spawn(dotnet, helperArgs, { cwd: this.repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
      this.proc.on("error", (e) => {
        this.log(`helper spawn error: ${String(e)}`);
        this.ready = false;
        this.proc = undefined;
        for (const [, p] of this.pending) p.resolve({ ok: false, error: "helper spawn error" });
        this.pending.clear();
      });
      this.proc.stdin!.on("error", () => undefined); // EPIPE after a crash: handled via exit
      this.proc.stdout!.on("data", (d: Buffer) => this.onData(d.toString()));
      this.proc.stderr!.on("data", (d: Buffer) => {
        this.stderrTail = [...this.stderrTail, d.toString()].slice(-20);
      });
      this.proc.on("exit", () => {
        this.ready = false;
        this.proc = undefined;
        // Reject anything in flight; callers fall back.
        for (const [, p] of this.pending) p.resolve({ ok: false, error: "helper exited" });
        this.pending.clear();
      });
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 30_000);
        this.onReady = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      if (!ok) {
        this.log(`helper did not become ready; stderr: ${this.stderrTail.join("").slice(-500)}`);
        this.dispose();
        // Transient (slow cold start, contention): retry on later runs, give up
        // for the session only after repeated failures.
        if (++this.startFailures >= 3) this.broken = true;
        return false;
      }
      this.startFailures = 0;
      this.ready = true;
      this.log("persistent test session runner ready");
      return true;
    } catch (e) {
      this.log(`session runner start failed: ${String(e)}`);
      if (++this.startFailures >= 3) this.broken = true;
      return false;
    }
  }

  private onReady: () => void = () => undefined;

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; type?: string; tests?: HelperTest[]; ok?: boolean; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-protocol noise
      }
      if (msg.type === "ready") {
        this.onReady();
        continue;
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      if (msg.type === "results" && msg.tests) p.tests.push(...msg.tests);
      if (msg.type === "done") {
        this.pending.delete(msg.id!);
        p.resolve({ ok: msg.ok === true, error: msg.error });
      }
    }
  }

  private send(cmd: object): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(cmd) + "\n");
    } catch {
      /* dead helper: pending entries resolve via the exit handler */
    }
  }

  /**
   * Run tests in `dll` (optionally filtered). Returns null when the runner is
   * unavailable — the caller must fall back to `dotnet test`.
   */
  async runFilter(
    dll: string,
    filter: string | undefined,
    signal?: AbortSignal
  ): Promise<SessionRunResult | null> {
    if (!(await this.ensureStarted())) return null;
    const task = this.chain.then(async (): Promise<SessionRunResult | null> => {
      if (signal?.aborted || !this.proc) return null;
      const id = this.nextId++;
      const tests: HelperTest[] = [];
      const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        this.pending.set(id, { tests, resolve });
      });
      const onAbort = () => {
        // No per-run cancel in the protocol: kill the helper; it respawns next run.
        this.dispose();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.sessionDlls.add(dll);
      this.send({ id, cmd: "run", dll, filter });
      const res = await done;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return null;
      if (!res.ok && tests.length === 0) {
        this.log(`session run failed (${res.error ?? "unknown"}); falling back`);
        return null;
      }
      // Zero matches must not read as green (dotnet test fails on a stale
      // filter; mirror that so a renamed class surfaces instead of vanishing).
      if (tests.length === 0) {
        return {
          ok: false,
          outcomes: [],
          output: `no tests matched${filter ? ` filter: ${filter}` : ""} in ${path.basename(dll)}\n`,
        };
      }
      const outcomes: TestOutcome[] = tests.map((t) => ({
        classFqn: classOf(t.fqn),
        method: t.display || t.fqn,
        passed: t.outcome === "passed",
        skipped: t.outcome === "skipped",
        message: t.message ?? undefined,
        durationMs: t.durationMs,
      }));
      return {
        ok: res.ok && outcomes.every((o) => o.passed || o.skipped),
        outcomes,
        output: "",
      };
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  /** Every dll a session was ever started for; the release-all sweep target. */
  private readonly sessionDlls = new Set<string>();

  /** Stop the session holding `dll` so a rebuild can overwrite it (Windows locks). */
  async release(dll: string): Promise<void> {
    if (!this.proc || !this.ready) return;
    this.sessionDlls.delete(dll);
    const id = this.nextId++;
    const done = new Promise<{ ok: boolean }>((resolve) => {
      this.pending.set(id, { tests: [], resolve });
    });
    this.send({ id, cmd: "release", dll });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    this.pending.delete(id); // a timed-out release must not leak its entry
  }

  /**
   * Stop every warm session before a build: on Windows any testhost locks not
   * just its own test dll but every dependency assembly it loaded, so a
   * rebuild of a shared project fails unless all of them let go.
   */
  async releaseAll(): Promise<void> {
    for (const dll of [...this.sessionDlls]) await this.release(dll);
  }

  /** `immediate` skips the graceful window — use when the host is exiting. */
  dispose(immediate = false): void {
    this.disposed = true;
    const proc = this.proc;
    try {
      this.send({ cmd: "shutdown" });
      if (immediate) proc?.kill();
      else setTimeout(() => proc?.kill(), 2000);
    } catch {
      /* ignore */
    }
    this.ready = false;
    this.proc = undefined;
    this.starting = null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function hash(s: string): string {
  // Content stamp for rebuild detection; not security-sensitive.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
