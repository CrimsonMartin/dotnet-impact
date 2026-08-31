import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * Regression test for the stale-baseline green lie (shipped in v0.2.4,
 * root-caused from the README gif re-recording session).
 *
 * Any build that bypasses the snapshot path — test discovery's solution
 * build, a manual `dotnet build` of the shadow — rewrites the dll+pdb while
 * binlogs.json still points at the previous complog. Loading that pair used
 * to succeed; Roslyn's EnC engine then held every baseline document
 * out-of-sync and answered EVERY subsequent edit with "no changes to apply",
 * which the runner treated as a benign no-op: saves stayed on the fast path,
 * testhosts kept executing the stale assembly, and a breaking edit stayed
 * GREEN with no diagnostic anywhere.
 *
 * The fix refuses the mismatched pair at load time (PDB checksum vs complog
 * text), so the runner falls to the build path, rebuilds, re-snapshots, and
 * the next save is coherent again.
 */

const V1 = `namespace Demo;

public static class Calc
{
    public static int Discount(int price, int pct)
    {
        return price - price * pct / 100;
    }
}
`;

interface Reply {
  ok: boolean;
  reason?: string;
  md?: string;
}

test("mismatched complog/dll baseline is refused at load, matched pair still deltas", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const helper = await builtHelper(dotnet);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-stale-baseline-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const csproj = path.join(d, "Lib.csproj");
    const source = path.join(d, "Calc.cs");
    fs.writeFileSync(
      csproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    );
    const build = (binlog: string) =>
      execFileSync(dotnet, ["build", csproj, `-bl:${binlog}`, "--nologo", "-v", "quiet"], {
        cwd: d,
        stdio: "pipe",
        timeout: 300_000,
        env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
      });

    // Build v1 and freeze its baseline, exactly like the runner does.
    fs.writeFileSync(source, V1);
    const binlog1 = path.join(d, "v1.binlog");
    build(binlog1);
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

    const complog1 = path.join(d, "v1.complog");
    assert.equal((await send({ cmd: "snapshot", binlog: binlog1, complog: complog1 })).ok, true);

    // An out-of-band build (discovery's solution build, a manual dotnet
    // build): source changed, dll+pdb rewritten, complog NOT refreshed.
    fs.writeFileSync(source, V1.replace("price * pct / 100", "price * pct / 100 + 1"));
    build(path.join(d, "v2.binlog"));

    // The poisoned pair must be refused up front…
    const staleLoad = await send({ cmd: "load", binlog: complog1, csproj, dll });
    assert.equal(staleLoad.ok, false, "mismatched complog/dll pair must not load");
    assert.match(
      staleLoad.reason ?? "",
      /baseline mismatch/,
      "refusal must name the baseline mismatch so the runner's log explains the build-path fall-through"
    );

    // …and the recovery path (rebuild → fresh snapshot → load → real edit)
    // must produce a real delta, never a "no-op".
    const binlog3 = path.join(d, "v3.binlog");
    fs.utimesSync(source, new Date(), new Date());
    build(binlog3);
    const complog3 = path.join(d, "v3.complog");
    assert.equal((await send({ cmd: "snapshot", binlog: binlog3, complog: complog3 })).ok, true);
    const goodLoad = await send({ cmd: "load", binlog: complog3, csproj, dll });
    assert.equal(goodLoad.ok, true, `coherent pair must load: ${goodLoad.reason}`);

    fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("price -", "price +"));
    const r = await send({ cmd: "delta", csproj, file: source });
    assert.equal(r.ok, true, `a real edit on a coherent baseline must delta: ${r.reason}`);
    assert.ok((r.md ?? "").length > 0, "delta came back empty");
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
