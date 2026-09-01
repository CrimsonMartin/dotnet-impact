import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * #28, guard layer: pairing a complog with a FOREIGN build's dll/pdb — the
 * same sources compiled in a different tree, so every PDB document path
 * differs — must be refused at load. The v0.2.7 checksum guard only compared
 * checksums for PDB documents whose paths matched the complog's; a wholesale
 * path mismatch verified nothing and loaded a baseline Roslyn would silently
 * ignore (every edit "no changes to apply", zero diagnostics, green).
 */

const SRC = `namespace Demo;

public static class Calc
{
    public static int Add(int a, int b)
    {
        return a + b;
    }
}
`;

interface Reply {
  ok: boolean;
  reason?: string;
  md?: string;
}

test("a complog paired with a foreign build's dll/pdb is refused at load", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const helper = await builtHelper(dotnet);

  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "impact-foreign-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "impact-foreign-b-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const build = (d: string, binlog?: string) => {
      fs.writeFileSync(
        path.join(d, "Lib.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
      );
      fs.writeFileSync(path.join(d, "Calc.cs"), SRC);
      execFileSync(
        dotnet,
        ["build", path.join(d, "Lib.csproj"), ...(binlog ? [`-bl:${binlog}`] : []), "--nologo", "-v", "quiet"],
        { cwd: d, stdio: "pipe", timeout: 300_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
      );
      return path.join(d, "bin", "Debug", "net8.0", "Lib.dll");
    };
    const binlog = path.join(dirA, "a.binlog");
    const dllA = build(dirA, binlog);
    const dllB = build(dirB); // identical sources, different tree → different PDB paths

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

    const complog = path.join(dirA, "a.complog");
    assert.equal((await send({ cmd: "snapshot", binlog, complog })).ok, true);

    // Foreign pair: refused up front with a diagnosable reason.
    const csprojA = path.join(dirA, "Lib.csproj");
    const foreign = await send({ cmd: "load", binlog: complog, csproj: csprojA, dll: dllB });
    assert.equal(foreign.ok, false, "a foreign build's dll must not become the EnC baseline");
    assert.match(foreign.reason ?? "", /baseline mismatch.*foreign build/, `got: ${foreign.reason}`);

    // Sanity: the matched pair still loads and a real edit still deltas.
    const good = await send({ cmd: "load", binlog: complog, csproj: csprojA, dll: dllA });
    assert.equal(good.ok, true, `matched pair must load: ${good.reason}`);
    fs.writeFileSync(path.join(dirA, "Calc.cs"), SRC.replace("return a + b;", "return a + b + 1;"));
    const delta = await send({ cmd: "delta", csproj: csprojA, file: path.join(dirA, "Calc.cs") });
    assert.equal(delta.ok, true, `real edit on the matched pair must delta: ${delta.reason}`);
    assert.ok((delta.md ?? "").length > 0, "delta came back empty");
  } finally {
    try {
      proc.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    } catch {
      /* already gone */
    }
    setTimeout(() => proc.kill(), 2000).unref();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
