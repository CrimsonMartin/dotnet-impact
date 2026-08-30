import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * Fast-path patchability matrix: the improvement criteria for the hot-patch
 * pipeline, driven end-to-end through the delta service (real build → real
 * complog → real EnC session → real deltas).
 *
 * Every edit kind a developer makes during a save is one row. Each row's
 * verdict mirrors what the runner does with it:
 *
 *   - "hit"  — the save stays on the fast path: either deltas came back
 *              (ok:true, non-empty md/il/pdb) or the engine called it a
 *              semantic no-op (reason starts "no-op"), which the runner
 *              treats as patched.
 *   - "miss" — the save falls to the build path; the reason must match the
 *              row's pattern so refusals stay self-explanatory in the log.
 *
 * Improvement criteria (what "better" means, measurably):
 *   1. A "hit" row turning into a miss is a REGRESSION — this test fails.
 *   2. A "miss" row turning into a hit is an IMPROVEMENT — this test fails
 *      too, on purpose: flip the row's expectation in the same commit so the
 *      matrix always documents the real fast-path surface.
 *   3. A miss whose reason stops matching its pattern is a diagnosability
 *      regression (the log line no longer tells the user why).
 *   4. The printed summary line ("delta-matrix: N/M edit kinds fast-pathed,
 *      load=Xms, median delta=Yms") is the baseline number to quote when
 *      claiming a change widened the fast path or made it faster.
 *
 * Rows expected to miss today, and why:
 *   - removed/re-signatured public members: the ApiGuard cross-project
 *     safety valve — a single-project EnC session can't see dependents.
 *   - new [Fact] method: runners discover tests from the dll on disk, so a
 *     hot-patched test would silently never run (#13).
 *   - base-type change: a genuine runtime rude edit (ENCxxxx).
 *   - compile error: nothing to patch; the build path surfaces the error.
 */

const BASELINE = `using System.Linq;

namespace Demo;

public class BaseA { }
public class BaseB { }

public class Calc : BaseA
{
    private int _seed = 1;

    public int Add(int a, int b)
    {
        return a + b;
    }

    public int Doubled(int[] xs)
    {
        return xs.Sum(x => x * 2);
    }

    public int Seed() => _seed;
}
`;

interface Row {
  name: string;
  /** Produce the edited source from the baseline. */
  edit: (src: string) => string;
  /** "hit" = fast path (deltas or no-op); a RegExp = miss whose reason must match. */
  expect: "hit" | RegExp;
}

const MATRIX: Row[] = [
  {
    name: "trivia: trailing comment",
    edit: (s) => s.replace("return a + b;", "return a + b; // sum"),
    expect: "hit",
  },
  {
    name: "trivia: blank line inside body",
    edit: (s) => s.replace("        return a + b;", "\n        return a + b;"),
    expect: "hit",
  },
  {
    name: "method body edit",
    edit: (s) => s.replace("return a + b;", "return a + b + 0;"),
    expect: "hit",
  },
  {
    name: "lambda body edit",
    edit: (s) => s.replace("x * 2", "x * 3"),
    expect: "hit",
  },
  {
    name: "add private method",
    edit: (s) => s.replace("private int _seed = 1;", "private int _seed = 1;\n\n    private int Twice(int a) => a * 2;"),
    expect: "hit",
  },
  {
    name: "add public method",
    edit: (s) => s.replace("public int Seed() => _seed;", "public int Seed() => _seed;\n\n    public int Sub(int a, int b) => a - b;"),
    expect: "hit",
  },
  {
    name: "add instance field",
    edit: (s) => s.replace("private int _seed = 1;", "private int _seed = 1;\n    private int _extra = 2;"),
    expect: "hit",
  },
  {
    name: "add new type",
    edit: (s) => s + "\npublic class Extra\n{\n    public int One() => 1;\n}\n",
    expect: "hit",
  },
  {
    name: "remove public method",
    edit: (s) => s.replace("    public int Seed() => _seed;\n", ""),
    expect: /api change/,
  },
  {
    name: "public signature change",
    edit: (s) => s.replace("public int Add(int a, int b)", "public int Add(int a, int b, int c)"),
    expect: /api change/,
  },
  {
    name: "add [Fact] test method",
    edit: (s) => s.replace("public int Seed() => _seed;", "public int Seed() => _seed;\n\n    [Fact]\n    public void NewTest() { }"),
    expect: /new test method/,
  },
  {
    name: "compile error",
    edit: (s) => s.replace("return a + b;", "return a + ;"),
    expect: /compile error|rude edit|engine refused/,
  },
  {
    name: "base type change (rude edit)",
    edit: (s) => s.replace("public class Calc : BaseA", "public class Calc : BaseB"),
    expect: /rude edit ENC/,
  },
];

interface Reply {
  ok: boolean;
  reason?: string;
  md?: string;
  il?: string;
  pdb?: string;
}

test("fast-path patchability matrix", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const helper = await builtHelper(dotnet);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-matrix-test-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const csproj = path.join(d, "Lib.csproj");
    const source = path.join(d, "Calc.cs");
    fs.writeFileSync(
      csproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    );
    fs.writeFileSync(source, BASELINE);
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

    // Each row runs against a fresh generation-0 session (load re-initializes
    // from the complog baseline), so rows are order-independent.
    let hits = 0;
    const deltaMs: number[] = [];
    let loadMs = 0;
    for (const row of MATRIX) {
      const t0 = Date.now();
      const load = await send({ cmd: "load", binlog: complog, csproj, dll });
      loadMs = Date.now() - t0;
      assert.equal(load.ok, true, `${row.name}: load: ${load.reason}`);

      fs.writeFileSync(source, row.edit(BASELINE));
      const t1 = Date.now();
      const r = await send({ cmd: "delta", csproj, file: source });
      const ms = Date.now() - t1;

      const isHit = r.ok || (r.reason ?? "").startsWith("no-op");
      if (row.expect === "hit") {
        assert.ok(
          isHit,
          `${row.name}: expected fast-path hit, got miss: ${r.reason}`
        );
        if (r.ok) {
          assert.ok(
            (r.md ?? "").length > 0 && (r.il ?? "").length > 0,
            `${row.name}: patch came back with empty deltas`
          );
          deltaMs.push(ms);
        }
        hits++;
      } else {
        assert.ok(
          !isHit,
          `${row.name}: expected build-path miss (${row.expect}) but the edit ` +
            `fast-pathed — if this is a deliberate widening, flip this row's expectation`
        );
        assert.match(
          r.reason ?? "",
          row.expect,
          `${row.name}: miss reason no longer diagnostic`
        );
      }
      fs.writeFileSync(source, BASELINE);
    }

    const sorted = [...deltaMs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    console.log(
      `delta-matrix: ${hits}/${MATRIX.length} edit kinds fast-pathed, ` +
        `load=${loadMs}ms, median delta=${median}ms`
    );
    // Absolute wall-clock guard, deliberately generous for cold CI runners:
    // the fast path exists to beat a multi-second build, so a delta that
    // takes longer than one is a defect regardless of machine speed.
    assert.ok(median < 20_000, `median delta ${median}ms exceeds 20s budget`);
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

test("deltas chain across generations in one session", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return;
  const helper = await builtHelper(dotnet);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-matrix-gen-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const csproj = path.join(d, "Lib.csproj");
    const source = path.join(d, "Calc.cs");
    fs.writeFileSync(
      csproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    );
    fs.writeFileSync(source, BASELINE);
    const binlog = path.join(d, "msbuild.binlog");
    execFileSync(dotnet, ["build", csproj, `-bl:${binlog}`, "--nologo", "-v", "quiet"], {
      cwd: d,
      stdio: "pipe",
      timeout: 300_000,
      env: { ...process.env, MSBUILDTERMINALLOGGER: "off" },
    });
    const dll = path.join(d, "bin", "Debug", "net8.0", "Lib.dll");

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
    assert.equal((await send({ cmd: "snapshot", binlog, complog })).ok, true);
    assert.equal((await send({ cmd: "load", binlog: complog, csproj, dll })).ok, true);

    // Gen 1: body edit. Gen 2: a further edit on top of gen 1's text —
    // the second delta must diff against the committed gen-1 baseline,
    // not the original build.
    fs.writeFileSync(source, BASELINE.replace("return a + b;", "return a + b + 1;"));
    const g1 = await send({ cmd: "delta", csproj, file: source });
    assert.equal(g1.ok, true, `gen1: ${g1.reason}`);

    fs.writeFileSync(source, BASELINE.replace("return a + b;", "return a + b + 2;"));
    const g2 = await send({ cmd: "delta", csproj, file: source });
    assert.equal(g2.ok, true, `gen2: ${g2.reason}`);
    assert.ok((g2.md ?? "").length > 0, "gen2 produced deltas");
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
