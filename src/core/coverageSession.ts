import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClassCoverageResult, parseCoberturaHitFiles } from "./coverage";
import { MtpSessionRunner } from "./mtpSession";
import { SessionRunner } from "./vstestSession";
import { cacheDirFor, classFilter, exec, resolveDotnet } from "./util";

/**
 * Warm coverage collection for live map refresh (#3).
 *
 * The classic path pays a full `dotnet test --collect` per class (~1.7s of
 * vstest spin-up + collector attach before any test runs). This module keeps
 * the whole pipeline resident instead:
 *
 *   - a `dotnet-coverage collect --server-mode` session per repo,
 *   - statically instrumented COPIES of the built test outputs (instrumented
 *     IL reports to the session by session id — no env, no collector),
 *   - a dedicated warm SessionRunner fleet running those copies,
 *   - `dotnet-coverage snapshot --reset` per class for attribution.
 *
 * Measured ~460ms/class vs ~1,745ms classic (issue #3, 2026-08-31).
 *
 * The copies are deliberate: instrumentation rewrites IL, so these dlls can
 * NEVER share testhosts with the hot-patch fast path (EnC deltas would not
 * apply). This fleet runs no startup hook and registers nowhere.
 *
 * Everything degrades: any miss (tool unavailable, instrument/server/snapshot
 * failure, cold session) returns null and the caller takes the classic
 * per-class collector path.
 */
export class WarmCoverage {
  private readonly cacheDir: string;
  private readonly covRoot: string;
  private readonly sessionId: string;
  private sessions: SessionRunner;
  /**
   * Dedicated warm fleet for MTP test apps' instrumented copies. Static
   * instrumentation is runner-agnostic; only the process hosting the copy
   * differs. No hook env: coverage hosts must never register as patchable.
   */
  private readonly mtpSessions = new MtpSessionRunner((m) => this.log(m));
  private broken = false;
  private toolPath: string | null = null;
  private serverReady = false;
  private starting: Promise<boolean> | null = null;

  constructor(
    private readonly repoRoot: string,
    /** Absolute path to the vstest helper source dir shipped with the extension. */
    helperSrcDir: string,
    private readonly log: (m: string) => void = () => undefined
  ) {
    this.cacheDir = cacheDirFor(repoRoot);
    this.covRoot = path.join(this.cacheDir, "coverage-warm");
    this.sessionId = `impact-cov-${path.basename(this.cacheDir)}`;
    // No runsettings: this fleet must never load the hot-patch startup hook.
    this.sessions = new SessionRunner(repoRoot, helperSrcDir, log);
  }

  /**
   * Collect the source files `classFqn`'s tests execute, via the warm
   * pipeline. Null = infrastructure miss; fall back to the classic path.
   */
  async collectClass(
    shadowDir: string,
    firstPartyAssemblies: string[],
    testDlls: string[],
    classFqn: string,
    signal?: AbortSignal,
    /** True when the project runs on Microsoft.Testing.Platform. */
    mtp = false
  ): Promise<ClassCoverageResult | null> {
    if (this.broken || testDlls.length === 0) return null;
    if (!(await this.ensureServer())) return null;

    // One instrumented copy per built output dir (one per TFM).
    const instrDlls: string[] = [];
    for (const dll of testDlls) {
      const instr = await this.instrumentedCopyFor(dll, firstPartyAssemblies);
      if (!instr) return null;
      instrDlls.push(instr);
    }

    let output = "";
    let passed = true;
    for (const dll of instrDlls) {
      if (signal?.aborted) return null;
      const r = mtp
        ? await this.mtpSessions.runFilter(dll, path.dirname(dll), [classFqn], signal)
        : await this.sessions.runFilter(dll, classFilter([classFqn]), signal);
      if (!r) return null; // session miss: classic path covers every TFM
      passed = passed && r.ok;
      output += r.output;
    }

    const snap = path.join(this.covRoot, "snapshot.cobertura.xml");
    fs.rmSync(snap, { force: true });
    const res = await this.dc(["snapshot", "--reset", "-o", snap, this.sessionId]);
    if (!res || res.code !== 0 || !fs.existsSync(snap)) {
      this.log(`coverage-warm: snapshot failed (${res?.stderr?.slice(0, 200) ?? "no tool"}); classic path`);
      return null;
    }
    const files = parseCoberturaHitFiles(snap, shadowDir);
    return { classFqn, files: files.sort(), passed, output };
  }

  /** Release warm hosts and stop the resident session. */
  dispose(): void {
    this.sessions.dispose();
    this.mtpSessions.dispose();
    if (this.serverReady && this.toolPath) {
      this.serverReady = false;
      void exec(this.toolPath, ["shutdown", this.sessionId], this.cacheDir, 30_000, undefined, dotnetEnv()).catch(
        () => undefined
      );
    }
  }

  // ---- instrumented copies ----

  /**
   * Mirror the built output dir of `testDll` into the coverage root and
   * statically instrument its first-party assemblies. Re-mirrors whenever any
   * source first-party dll changed (a rebuild replaced outputs), releasing
   * the warm host that has the old copy loaded first (Windows file locks).
   */
  private async instrumentedCopyFor(testDll: string, firstParty: string[]): Promise<string | null> {
    const srcDir = path.dirname(testDll);
    const copyDir = path.join(this.covRoot, "bin", hash(srcDir));
    const stampFile = path.join(copyDir, ".impact-cov-stamp");
    const instrDll = path.join(copyDir, path.basename(testDll));

    const wanted = stampOf(srcDir, firstParty);
    if (wanted === null) return null; // source outputs vanished mid-look
    try {
      if (fs.readFileSync(stampFile, "utf8") === wanted && fs.existsSync(instrDll)) return instrDll;
    } catch {
      /* cold or stale: rebuild the copy */
    }

    await this.sessions.release(instrDll); // old copy may be loaded in a warm host
    fs.rmSync(copyDir, { recursive: true, force: true });
    try {
      fs.cpSync(srcDir, copyDir, { recursive: true });
    } catch (e) {
      this.log(`coverage-warm: copy failed for ${srcDir}: ${(e as Error).message}`);
      return null;
    }

    for (const name of firstParty) {
      const target = path.join(copyDir, `${name}.dll`);
      if (!fs.existsSync(target)) continue; // not a dependency of this test project
      const tmp = target + ".instr";
      const res = await this.dc(["instrument", "--session-id", this.sessionId, "-o", tmp, target]);
      if (!res || res.code !== 0) {
        this.log(`coverage-warm: instrument failed for ${name}: ${res?.stderr?.slice(0, 200) ?? "no tool"}`);
        fs.rmSync(copyDir, { recursive: true, force: true });
        return null;
      }
      fs.renameSync(tmp, target);
    }
    fs.writeFileSync(stampFile, wanted);
    return instrDll;
  }

  // ---- resident session + tool ----

  private async ensureServer(): Promise<boolean> {
    if (this.broken) return false;
    if (this.serverReady) return true;
    this.starting ??= this.startServer();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  private async startServer(): Promise<boolean> {
    if (this.serverReady) return true;
    const tool = await this.ensureTool();
    if (!tool) {
      this.broken = true;
      return false;
    }
    fs.mkdirSync(this.covRoot, { recursive: true });
    // A daemon left over from a crashed session would collide on the id.
    await exec(tool, ["shutdown", this.sessionId], this.cacheDir, 30_000, undefined, dotnetEnv()).catch(
      () => undefined
    );
    const res = await this.dc([
      "collect",
      "--server-mode",
      "--background",
      "--session-id",
      this.sessionId,
      "-f",
      "cobertura",
      "-o",
      path.join(this.covRoot, "server.cobertura.xml"),
    ]);
    if (!res || res.code !== 0) {
      this.log(`coverage-warm: server start failed (${res?.stderr?.slice(0, 200) ?? "no tool"}); classic path`);
      this.broken = true;
      return false;
    }
    this.serverReady = true;
    this.log("coverage-warm: resident collection session ready");
    return true;
  }

  /**
   * Find dotnet-coverage: PATH, the shared install under ~/.impact, or a
   * one-time `dotnet tool install --tool-path` (needs network; a failure
   * pins this session to the classic path, never errors a refresh).
   */
  private async ensureTool(): Promise<string | null> {
    if (this.toolPath) return this.toolPath;
    const exe = process.platform === "win32" ? "dotnet-coverage.exe" : "dotnet-coverage";
    const shared = path.join(os.homedir(), ".impact", "dc-tool");
    // PATH, the default global-tool dir, then our own shared install.
    for (const candidate of [exe, path.join(os.homedir(), ".dotnet", "tools", exe), path.join(shared, exe)]) {
      const probe = await exec(candidate, ["--version"], this.repoRoot, 30_000, undefined, dotnetEnv()).catch(
        () => null
      );
      if (probe && probe.code === 0) return (this.toolPath = candidate);
    }
    this.log("coverage-warm: installing dotnet-coverage (one-time)…");
    const install = await exec(
      "dotnet",
      ["tool", "install", "--tool-path", shared, "dotnet-coverage"],
      this.repoRoot,
      5 * 60_000
    ).catch(() => null);
    if (!install || install.code !== 0) {
      this.log(`coverage-warm: tool install failed; classic path (${(install?.stderr ?? "").slice(0, 200)})`);
      return null;
    }
    const installed = path.join(shared, exe);
    const probe = await exec(installed, ["--version"], this.repoRoot, 30_000, undefined, dotnetEnv()).catch(() => null);
    return probe && probe.code === 0 ? (this.toolPath = installed) : null;
  }

  private async dc(args: string[]): Promise<{ code: number; stdout: string; stderr: string } | null> {
    const tool = await this.ensureTool();
    if (!tool) return null;
    return exec(tool, args, this.cacheDir, 120_000, undefined, dotnetEnv()).catch(() => null);
  }
}

/**
 * Freshness stamp of an output dir's first-party dlls (size+mtime): any
 * rebuild that replaced a dll invalidates the instrumented mirror.
 */
function stampOf(dir: string, firstParty: string[]): string | null {
  const rows: string[] = [];
  for (const name of [...firstParty].sort()) {
    const p = path.join(dir, `${name}.dll`);
    try {
      const st = fs.statSync(p);
      rows.push(`${name}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* not a dependency here */
    }
  }
  return rows.length > 0 ? rows.join("\n") : null;
}

/**
 * DOTNET_ROOT + PATH for global-tool shims: the dotnet-coverage launcher
 * needs the runtime host resolvable even when VS Code inherited a GUI PATH
 * without it (the reason resolveDotnet exists).
 */
function dotnetEnv(): NodeJS.ProcessEnv | undefined {
  const dotnet = resolveDotnet();
  if (!path.isAbsolute(dotnet)) return undefined; // dotnet already on PATH
  const dir = path.dirname(dotnet);
  return { DOTNET_ROOT: dir, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
