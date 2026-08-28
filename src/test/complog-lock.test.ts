import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * Regression: a loaded EnC session's SolutionReader keeps its complog file
 * open (it backs the solution's lazy text loaders), and .NET enforces
 * FileShare even within one process — on Linux via advisory locks. A later
 * "snapshot" for the same project then failed rewriting that complog with
 * "being used by another process", forcing the build path forever after the
 * first rebuild. The build that produced the new binlog invalidated the
 * loaded baseline anyway, so snapshot must evict the matching session before
 * converting.
 */

interface Reply {
  ok: boolean;
  reason?: string;
  calls?: number;
}

test("snapshot succeeds while the same project's session holds the complog", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const helper = await builtHelper(dotnet);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-complog-test-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const csproj = path.join(d, "Lib.csproj");
    fs.writeFileSync(
      csproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    );
    fs.writeFileSync(path.join(d, "Calc.cs"), "namespace Demo;\n\npublic static class Calc\n{\n    public static int Two() => 2;\n}\n");
    const binlog = path.join(d, "msbuild.binlog");
    execFileSync(dotnet, ["build", csproj, `-bl:${binlog}`, "--nologo", "-v", "quiet"], {
      cwd: d,
      stdio: "pipe",
      timeout: 300_000,
      env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
    });
    const dll = path.join(d, "bin", "Debug", "net8.0", "Lib.dll");
    assert.ok(fs.existsSync(dll), "scaffold build produced Lib.dll");

    const rl = readline.createInterface({ input: proc.stdout });
    const pending = new Map<number, (r: Reply) => void>();
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "done") pending.get(msg.id)?.(msg);
      } catch {
        /* chatter */
      }
    });
    let nextId = 1;
    const send = (payload: Record<string, unknown>): Promise<Reply> => {
      const id = nextId++;
      const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
      proc.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      return reply;
    };

    const complog = path.join(d, "Lib.complog");
    const snap1 = await send({ cmd: "snapshot", binlog, complog });
    assert.equal(snap1.ok, true, `first snapshot: ${snap1.reason}`);
    assert.ok((snap1.calls ?? 0) > 0, "real build recorded compiler calls");

    const load = await send({ cmd: "load", binlog: complog, csproj, dll });
    assert.equal(load.ok, true, `load: ${load.reason}`);

    // The session now holds Lib.complog open. A post-rebuild snapshot must
    // still be able to rewrite it (this is the regression).
    const snap2 = await send({ cmd: "snapshot", binlog, complog });
    assert.equal(snap2.ok, true, `snapshot over loaded complog: ${snap2.reason}`);

    // And the fresh complog must be loadable again.
    const reload = await send({ cmd: "load", binlog: complog, csproj, dll });
    assert.equal(reload.ok, true, `reload: ${reload.reason}`);
  } finally {
    try {
      proc.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    } catch {
      /* already gone */
    }
    setTimeout(() => proc.kill(), 2000).unref();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
