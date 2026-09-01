import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { classOf } from "./discover";
import { TestOutcome } from "./trx";
import { resolveDotnet } from "./util";
import { SessionRunResult } from "./vstestSession";

/**
 * Warm sessions for Microsoft.Testing.Platform test apps — the MTP sibling of
 * the vstest SessionRunner. An MTP test project is a self-hosting executable;
 * launched with `--server --client-host/--client-port` it connects back to a
 * TCP listener we own and speaks LSP-framed JSON-RPC:
 *
 *   → initialize                        (we are the client; we speak first)
 *   → testing/discoverTests {runId}     ← testing/testUpdates/tests …, then
 *                                         a final update with changes:null,
 *                                         then the request's response
 *   → testing/runTests {runId, tests?: [{uid, display-name}]}
 *                                       ← updates with execution-state
 *                                         passed/failed/skipped, error.message,
 *                                         error.stacktrace, time.duration-ms
 *
 * Discovery nodes carry stable uids plus location.type/location.method (xunit
 * v3, MSTest 4+), which is what per-class filtering and attribution key on.
 * MSTest 3.x omits location.* and lists bare method display names; such nodes
 * cannot be attributed to classes, and the caller falls back to the exec path
 * for them.
 *
 * The resident app loads the test assemblies at spawn, which is exactly what
 * the hot-patch pipeline needs: `hookEnv` (startup hook + patch pipe vars) is
 * injected at spawn, the app registers itself like any other testhost, and
 * deltas patch it in memory. A REBUILD is the opposite case — the resident
 * process would keep running the old assemblies — so every use re-stats the
 * dll and recycles the session when the build changed it; the fresh process
 * loads the new bits and the generation-coherence gate resets the patch epoch.
 *
 * Everything degrades: any miss (connect timeout, crash, protocol error)
 * marks the session dead and returns null, and the caller takes the exec
 * fallback (whole-project run through the app's console output).
 */

export interface MtpTestNode {
  uid: string;
  displayName: string;
  /** Class FQN from location.type, else the dotted display name's class part. */
  classFqn: string | null;
  /** Method name from location.method, else the display name's tail. */
  method: string;
}

interface RpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

type NodeRecord = Record<string, unknown>;

const CONNECT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

/** One resident MTP app on one test dll. */
class MtpSession {
  private proc: ChildProcess | null = null;
  private server: net.Server | null = null;
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (msg: RpcMessage) => void>();
  /** Per-runId collector for testing/testUpdates/tests streams. */
  private readonly collectors = new Map<string, { nodes: NodeRecord[]; done: () => void }>();
  dead = false;
  /**
   * size:mtimeMs over every dll in the output dir at spawn. The resident app
   * loaded those bits; a rebuild OR a dependency fan-in copy replacing ANY of
   * them invalidates the session (the test dll alone is not enough — a lib
   * edit rebuilds the lib and fan-copies it here without touching the test
   * dll). Hot patches never touch disk, so fast-path runs keep the session.
   */
  readonly stamp: string;

  constructor(
    readonly dll: string,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    private readonly log: (m: string) => void
  ) {
    this.stamp = outputStamp(dll);
  }

  async start(): Promise<boolean> {
    try {
      const server = net.createServer();
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (server.address() as net.AddressInfo).port;

      const dotnet = resolveDotnet();
      const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
      if (path.isAbsolute(dotnet)) {
        env.DOTNET_ROOT = path.dirname(dotnet);
        env.PATH = `${path.dirname(dotnet)}${path.delimiter}${process.env.PATH ?? ""}`;
      }
      this.proc = spawn(
        dotnet,
        ["exec", this.dll, "--server", "--client-host", "127.0.0.1", "--client-port", String(port)],
        { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"] }
      );
      this.proc.on("exit", () => this.kill("app exited"));
      this.proc.on("error", () => this.kill("spawn failed"));
      this.proc.stdout?.on("data", () => undefined);
      this.proc.stderr?.on("data", () => undefined);

      const sock = await new Promise<net.Socket | null>((resolve) => {
        const t = setTimeout(() => resolve(null), CONNECT_TIMEOUT_MS);
        server.once("connection", (s) => {
          clearTimeout(t);
          resolve(s);
        });
      });
      if (!sock) {
        this.kill("connect timeout");
        return false;
      }
      this.sock = sock;
      sock.on("data", (d) => this.onData(d));
      sock.on("close", () => this.kill("socket closed"));
      sock.on("error", () => this.kill("socket error"));

      const init = await this.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "impact", version: "1" },
        capabilities: { testing: { debuggerProvider: false } },
      });
      if (!init || init.error) {
        this.kill("initialize failed");
        return false;
      }
      return true;
    } catch (e) {
      this.kill(`start failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Discover the app's tests; null on any session failure. */
  async discover(): Promise<MtpTestNode[] | null> {
    const nodes = await this.roundTrip("testing/discoverTests", {});
    if (nodes === null) return null;
    return nodes
      .filter((n) => n["execution-state"] === "discovered" && typeof n.uid === "string")
      .map((n) => toTestNode(n));
  }

  /** Run everything (uids undefined) or exactly the given nodes. */
  async run(uids: Array<{ uid: string; displayName: string }> | undefined, signal?: AbortSignal): Promise<TestOutcome[] | null> {
    const params: Record<string, unknown> =
      uids === undefined ? {} : { tests: uids.map((u) => ({ uid: u.uid, "display-name": u.displayName })) };
    const abort = () => this.kill("aborted");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const nodes = await this.roundTrip("testing/runTests", params);
      if (nodes === null) return null;
      const outcomes: TestOutcome[] = [];
      for (const raw of nodes) {
        const state = raw["execution-state"];
        if (state !== "passed" && state !== "failed" && state !== "skipped") continue;
        const node = toTestNode(raw);
        if (!node.classFqn) continue; // unattributable (MSTest 3.x): caller's exec path covers it
        outcomes.push({
          classFqn: node.classFqn,
          method: node.method,
          passed: state === "passed",
          skipped: state === "skipped",
          message:
            state === "failed"
              ? [raw["error.message"], raw["error.stacktrace"]].filter(Boolean).join("\n")
              : undefined,
          durationMs: typeof raw["time.duration-ms"] === "number" ? (raw["time.duration-ms"] as number) : undefined,
        });
      }
      return outcomes;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  /** One request whose result is the accumulated testUpdates stream. */
  private async roundTrip(method: string, extraParams: Record<string, unknown>): Promise<NodeRecord[] | null> {
    if (this.dead || !this.sock) return null;
    const runId = randomUUID(); // the server binds runId as a GUID
    const nodes: NodeRecord[] = [];
    let streamDone: () => void = () => undefined;
    const stream = new Promise<void>((resolve) => (streamDone = resolve));
    this.collectors.set(runId, { nodes, done: streamDone });
    try {
      const resp = await this.request(method, { runId, ...extraParams });
      if (!resp || resp.error) return null;
      await Promise.race([stream, new Promise((r) => setTimeout(r, 5_000))]);
      return this.dead ? null : nodes;
    } finally {
      this.collectors.delete(runId);
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<RpcMessage | null> {
    if (this.dead || !this.sock) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<RpcMessage | null>((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        this.kill("request timeout");
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      try {
        this.sock!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      } catch {
        this.kill("write failed");
        resolve(null);
      }
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.slice(0, headerEnd).toString("utf8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
      this.buf = this.buf.slice(headerEnd + 4 + len);
      let msg: RpcMessage;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.method === "testing/testUpdates/tests" && msg.params) {
        const runId = String(msg.params.runId ?? "");
        const collector = this.collectors.get(runId);
        if (collector) {
          const changes = msg.params.changes as Array<{ node?: NodeRecord }> | null;
          if (changes === null) collector.done(); // end-of-stream marker
          else for (const c of changes ?? []) if (c?.node) collector.nodes.push(c.node);
        }
      } else if (msg.id !== undefined && !msg.method) {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } else if (msg.id !== undefined && msg.method) {
        // Server-to-client request (debugger attach etc.): decline politely.
        const body2 = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null });
        try {
          this.sock?.write(`Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`);
        } catch {
          /* dying anyway */
        }
      }
      // client/log and telemetry/update notifications are dropped.
    }
  }

  kill(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.log(`mtp session (${path.basename(this.dll)}): ${reason}`);
    for (const [, resolve] of this.pending) resolve({ jsonrpc: "2.0", error: reason });
    this.pending.clear();
    for (const [, c] of this.collectors) c.done();
    this.collectors.clear();
    try {
      this.sock?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }
}

/**
 * The warm-session pool: one resident MTP app per test dll, recycled whenever
 * a rebuild replaces the dll on disk. `hookEnv` (when given) rides along on
 * every spawn so the apps join the hot-patch pipeline like any testhost.
 */
export class MtpSessionRunner {
  private readonly sessions = new Map<string, MtpSession>();
  private broken = false;

  constructor(
    private readonly log: (m: string) => void = () => undefined,
    private readonly hookEnv: Record<string, string> = {}
  ) {}

  get available(): boolean {
    return !this.broken;
  }

  /** Discovered nodes for a test dll; null on any session miss. */
  async discover(dll: string, cwd: string): Promise<MtpTestNode[] | null> {
    const s = await this.ensure(dll, cwd);
    if (!s) return null;
    const nodes = await s.discover();
    if (nodes === null) this.drop(dll);
    return nodes;
  }

  /**
   * Run the dll's tests for the given classes (undefined = all). Attribution
   * needs class info on the nodes; when discovery yields none (MSTest 3.x),
   * this is a miss and the caller's exec path takes over.
   */
  async runFilter(dll: string, cwd: string, classFqns: string[] | undefined, signal?: AbortSignal): Promise<SessionRunResult | null> {
    const s = await this.ensure(dll, cwd);
    if (!s) return null;
    let picked: Array<{ uid: string; displayName: string }> | undefined;
    if (classFqns !== undefined) {
      const nodes = await s.discover();
      if (nodes === null) {
        this.drop(dll);
        return null;
      }
      const wanted = new Set(classFqns);
      const attributable = nodes.filter((n) => n.classFqn !== null);
      if (attributable.length === 0) return null; // MSTest 3.x shape
      picked = attributable
        .filter((n) => wanted.has(n.classFqn!))
        .map((n) => ({ uid: n.uid, displayName: n.displayName }));
      if (picked.length === 0) return { ok: true, outcomes: [], output: "" };
    }
    const outcomes = await s.run(picked, signal);
    if (outcomes === null) {
      this.drop(dll);
      return null;
    }
    return {
      ok: outcomes.every((o) => o.passed || o.skipped),
      outcomes,
      output: outcomes
        .filter((o) => !o.passed && !o.skipped)
        .map((o) => `failed ${o.classFqn}.${o.method}\n${o.message ?? ""}\n`)
        .join(""),
    };
  }

  async release(dll: string): Promise<void> {
    this.drop(dll);
  }

  async releaseAll(): Promise<void> {
    for (const dll of [...this.sessions.keys()]) this.drop(dll);
  }

  dispose(): void {
    void this.releaseAll();
  }

  private async ensure(dll: string, cwd: string): Promise<MtpSession | null> {
    if (this.broken) return null;
    const existing = this.sessions.get(dll);
    if (existing) {
      // A rebuild replaced the dll: the resident app still runs the OLD
      // assemblies, so recycle. (Hot patches leave the file untouched — the
      // session survives exactly when its in-memory state is the truth.)
      if (!existing.dead && existing.stamp === outputStamp(dll)) return existing;
      this.drop(dll);
    }
    if (!fs.existsSync(dll)) return null;
    const s = new MtpSession(dll, cwd, this.hookEnv, this.log);
    const ok = await s.start();
    if (!ok) return null;
    this.sessions.set(dll, s);
    this.log(`mtp session ready: ${path.basename(dll)}`);
    return s;
  }

  private drop(dll: string): void {
    const s = this.sessions.get(dll);
    if (s) {
      s.kill("released");
      this.sessions.delete(dll);
    }
  }
}

function toTestNode(raw: NodeRecord): MtpTestNode {
  const displayName = String(raw["display-name"] ?? "");
  const locType = typeof raw["location.type"] === "string" ? (raw["location.type"] as string) : null;
  const locMethod = typeof raw["location.method"] === "string" ? (raw["location.method"] as string) : null;
  let classFqn = locType;
  let method = locMethod ?? displayName;
  if (!classFqn && displayName.includes(".")) {
    // xunit-style dotted display name: split it the way the tree does.
    const cls = classOf(displayName);
    if (cls) {
      classFqn = cls;
      method = displayName.slice(cls.length + 1);
    }
  }
  return { uid: String(raw.uid), displayName, classFqn, method };
}

function outputStamp(dll: string): string {
  try {
    const dir = path.dirname(dll);
    const rows: string[] = [];
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.toLowerCase().endsWith(".dll")) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        rows.push(`${f}:${st.size}:${st.mtimeMs}`);
      } catch {
        /* replaced mid-stat: the next stamp differs, which is the point */
      }
    }
    return rows.join("\n") || "missing";
  } catch {
    return "missing";
  }
}
