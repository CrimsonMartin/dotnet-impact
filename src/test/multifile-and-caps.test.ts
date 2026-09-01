import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * #11 P2/P3, engine-facing half, driven end-to-end through the delta service
 * (real build → real complog → real EnC session).
 *
 * P2 — capabilities gate emission: a load carrying a restricted capability
 * set (what the live testhost runtimes reported) must make the engine REFUSE
 * edits those runtimes can't apply, instead of emitting deltas that would die
 * at ApplyUpdate inside the host. Body edits (Baseline) must keep working.
 *
 * P3 — one save, several files: edits that only compile TOGETHER (a method
 * added in one file, called from another) must hot-patch when sent as one
 * batched "files" request, and the per-file refusal that motivated batching
 * must still show up when the caller sends them separately.
 */

const CALC = `namespace Demo;

public class Calc
{
    public int Add(int a, int b)
    {
        return a + b;
    }
}
`;

const EXTRA = `namespace Demo;

public class Extra
{
    public int One()
    {
        return 1;
    }
}
`;

interface Reply {
  ok: boolean;
  reason?: string;
  updates?: Array<{ assembly: string; md: string; il: string; pdb: string }>;
}

async function withService(
  run: (ctx: {
    d: string;
    csproj: string;
    calc: string;
    extra: string;
    dll: string;
    complog: string;
    send: (payload: Record<string, unknown>) => Promise<Reply>;
  }) => Promise<void>
): Promise<void> {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const helper = await builtHelper(dotnet);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-multifile-caps-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const csproj = path.join(d, "Lib.csproj");
    const calc = path.join(d, "Calc.cs");
    const extra = path.join(d, "Extra.cs");
    fs.writeFileSync(
      csproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    );
    fs.writeFileSync(calc, CALC);
    fs.writeFileSync(extra, EXTRA);
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
    const snap = await send({ cmd: "snapshot", binlog, complog });
    assert.equal(snap.ok, true, `snapshot: ${snap.reason}`);

    await run({ d, csproj, calc, extra, dll, complog, send });
  } finally {
    try {
      proc.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    } catch {
      /* already gone */
    }
    setTimeout(() => proc.kill(), 2000).unref();
    fs.rmSync(d, { recursive: true, force: true });
  }
}

test("caps handshake: a Baseline-only fleet refuses add-method but still patches body edits", { timeout: 600_000 }, async () => {
  await withService(async ({ csproj, calc, dll, complog, send }) => {
    // Session constrained to what a minimal runtime reported.
    const load = await send({ cmd: "load", binlog: complog, csproj, dll, caps: ["Baseline"] });
    assert.equal(load.ok, true, `load: ${load.reason}`);

    // Beyond the fleet's ability: must fall to the build path with the
    // engine's own refusal, not emit a delta the hosts would reject.
    fs.writeFileSync(calc, CALC.replace("return a + b;", "return a + b;\n    }\n\n    private int Sub(int a, int b)\n    {\n        return a - b;"));
    const addMethod = await send({ cmd: "delta", csproj, file: calc });
    assert.equal(addMethod.ok, false, "add-method must be refused when hosts lack AddMethodToExistingType");
    assert.match(addMethod.reason ?? "", /rude edit ENC|engine refused/i, `diagnosable refusal, got: ${addMethod.reason}`);
    fs.writeFileSync(calc, CALC);

    // Within Baseline: body edits still hot-patch.
    const reload = await send({ cmd: "load", binlog: complog, csproj, dll, caps: ["Baseline"] });
    assert.equal(reload.ok, true, `reload: ${reload.reason}`);
    fs.writeFileSync(calc, CALC.replace("return a + b;", "return a + b + 0;"));
    const body = await send({ cmd: "delta", csproj, file: calc });
    assert.equal(body.ok, true, `body edit under Baseline: ${body.reason}`);
    assert.ok((body.updates?.[0]?.md ?? "").length > 0, "body edit must produce a real delta");
    fs.writeFileSync(calc, CALC);
  });
});

test("multi-file save: interdependent edits patch as one batch, and per-file they still cannot", { timeout: 600_000 }, async () => {
  await withService(async ({ csproj, calc, extra, dll, complog, send }) => {
    const editedExtra = EXTRA.replace(
      "    public int One()",
      "    public int Twice(int v)\n    {\n        return v * 2;\n    }\n\n    public int One()"
    );
    const editedCalc = CALC.replace("return a + b;", "return new Extra().Twice(a) + b;");

    // The motivation, pinned: sending only the caller's file refuses (its new
    // dependency isn't in the solution yet). If this ever starts succeeding,
    // per-file emits got smarter and the batch path deserves a rethink.
    assert.equal((await send({ cmd: "load", binlog: complog, csproj, dll })).ok, true);
    fs.writeFileSync(calc, editedCalc);
    const alone = await send({ cmd: "delta", csproj, file: calc });
    assert.equal(alone.ok, false, "caller alone must refuse — Twice doesn't exist in its solution");
    fs.writeFileSync(calc, CALC);

    // The same save, batched: both files enter one emit and patch together.
    assert.equal((await send({ cmd: "load", binlog: complog, csproj, dll })).ok, true);
    fs.writeFileSync(extra, editedExtra);
    fs.writeFileSync(calc, editedCalc);
    const batch = await send({ cmd: "delta", csproj, files: [calc, extra] });
    assert.equal(batch.ok, true, `batched interdependent edits must patch: ${batch.reason}`);
    const u0 = batch.updates?.[0];
    assert.ok((u0?.md ?? "").length > 0 && (u0?.il ?? "").length > 0, "batch must produce a real delta");
    fs.writeFileSync(calc, CALC);
    fs.writeFileSync(extra, EXTRA);
  });
});

test("multi-file save: the API guard still vetoes a batch containing a removed public member", { timeout: 600_000 }, async () => {
  await withService(async ({ csproj, calc, extra, dll, complog, send }) => {
    assert.equal((await send({ cmd: "load", binlog: complog, csproj, dll })).ok, true);
    fs.writeFileSync(calc, CALC.replace("return a + b;", "return a + b + 0;")); // innocent
    fs.writeFileSync(extra, EXTRA.replace("public int One()", "public int One(int unused)")); // visible signature change
    const batch = await send({ cmd: "delta", csproj, files: [calc, extra] });
    assert.equal(batch.ok, false, "a batch with an API-surface change must fall to the build path");
    assert.match(batch.reason ?? "", /api change/, `guard reason survives batching, got: ${batch.reason}`);
    fs.writeFileSync(calc, CALC);
    fs.writeFileSync(extra, EXTRA);
  });
});
