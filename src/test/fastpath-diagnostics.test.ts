import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { fastPathDiagnosticEvents, shadowToRepoPath } from "../core/hotpatch";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * Fast-path squigglies: when a save fails to COMPILE on the hot-patch path,
 * the delta service already holds the exact Roslyn diagnostics — the refusal
 * carries them structured (0-based spans, shadow paths) so the extension can
 * show red squigglies in ~100ms instead of waiting for the msbuild path.
 *
 * What must hold:
 *  - a delta over a file with a compile error refuses AND carries a
 *    "diagnostics" array: CS-class id, 0-based span at the error, the file;
 *  - a rude-edit refusal (valid C# the runtime can't hot-patch) carries NO
 *    diagnostics — the build path succeeds and would immediately clear the
 *    squiggly, so surfacing it would flash red on correct code. Same for the
 *    API-surface guard's refusal (it never reaches the compiler);
 *  - TS side: shadow paths map back into the repo and errors group into one
 *    "set" event per owning project for the runner's diagnostics sink.
 */

interface Reply {
  ok: boolean;
  reason?: string;
  updates?: Array<{ assembly: string; md: string; il: string; pdb: string }>;
  diagnostics?: Array<{
    id: string;
    severity: string;
    message: string;
    file: string;
    startLine: number;
    startCol: number;
    endLine?: number;
    endCol?: number;
  }>;
}

const CALC = `namespace Demo;

public class Calc
{
    public int Add(int a, int b)
    {
        return a + b;
    }
}
`;

/** 0-based line/col of the first occurrence of needle in source. */
function positionOf(source: string, needle: string): { line: number; col: number } {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `${needle} present in source`);
  const before = source.slice(0, at).split("\n");
  return { line: before.length - 1, col: before[before.length - 1].length };
}

test("delta refusals: compile errors carry structured diagnostics; rude edits and guard refusals carry none", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const helper = await builtHelper(dotnet);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-fastpath-diag-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const csproj = path.join(d, "Lib.csproj");
    const calc = path.join(d, "Calc.cs");
    fs.writeFileSync(
      csproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    );
    fs.writeFileSync(calc, CALC);
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
    assert.equal((await send({ cmd: "load", binlog: complog, csproj, dll })).ok, true);

    // A save that does not compile: the refusal must carry the exact error,
    // 0-based, at the undefined identifier — the raw material for squigglies.
    const broken = CALC.replace("return a + b;", "return a + bogus;");
    const want = positionOf(broken, "bogus");
    fs.writeFileSync(calc, broken);
    const err = await send({ cmd: "delta", files: [calc] });
    assert.equal(err.ok, false, "a compile error must refuse the delta");
    assert.ok(err.diagnostics && err.diagnostics.length > 0, `refusal must carry diagnostics (reason: ${err.reason})`);
    const diag = err.diagnostics.find((x) => x.id === "CS0103") ?? err.diagnostics[0];
    assert.match(diag.id, /^CS\d+$/, `compiler-class id, got: ${diag.id}`);
    assert.equal(diag.severity, "error");
    assert.ok(diag.message.length > 0, "diagnostic carries the Roslyn message");
    assert.ok(diag.file.endsWith("Calc.cs"), `diagnostic names the file, got: ${diag.file}`);
    assert.equal(diag.startLine, want.line, "0-based line of the error");
    assert.equal(diag.startCol, want.col, "0-based column of the error");
    assert.ok((diag.endCol ?? 0) > diag.startCol, "span covers the identifier");
    fs.writeFileSync(calc, CALC);

    // The API-surface guard refuses BEFORE the compiler runs: no diagnostics.
    fs.writeFileSync(calc, CALC.replace("public int Add(int a, int b)", "public long Add(long a, long b)"));
    const guarded = await send({ cmd: "delta", files: [calc] });
    assert.equal(guarded.ok, false, "signature change must refuse");
    assert.match(guarded.reason ?? "", /api change/, `guard reason, got: ${guarded.reason}`);
    assert.ok(!("diagnostics" in guarded), "guard refusal must not carry diagnostics");
    fs.writeFileSync(calc, CALC);

    // A rude edit is valid C# — the build path succeeds and would immediately
    // clear the squiggly, so its ENC diagnostic must NOT come back structured.
    // A Baseline-only fleet makes add-method deterministically rude.
    const reload = await send({ cmd: "load", binlog: complog, csproj, dll, caps: ["Baseline"] });
    assert.equal(reload.ok, true, `reload: ${reload.reason}`);
    fs.writeFileSync(
      calc,
      CALC.replace("return a + b;", "return a + b;\n    }\n\n    private int Sub(int a, int b)\n    {\n        return a - b;")
    );
    const rude = await send({ cmd: "delta", files: [calc] });
    assert.equal(rude.ok, false, "add-method under Baseline-only caps must refuse");
    assert.match(rude.reason ?? "", /rude edit ENC|engine refused/i, `rude refusal, got: ${rude.reason}`);
    assert.ok(!("diagnostics" in rude), "rude-edit refusal must not carry diagnostics — the code compiles");
    fs.writeFileSync(calc, CALC);
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

test("shadowToRepoPath: separator normalization, case-insensitive prefix strip, pass-through outside the shadow", () => {
  const mapped = shadowToRepoPath("/tmp/shadow", "/repo", "/tmp/shadow/src/Lib/Calc.cs");
  assert.equal(mapped, path.join("/repo", "src", "Lib", "Calc.cs"));

  // Windows-style delta-service output against a forward-slash shadow dir,
  // and a case difference in the prefix (NTFS): both still strip.
  assert.equal(
    shadowToRepoPath("C:/cache/Shadow", "C:/repo", "C:\\cache\\shadow\\src\\Calc.cs"),
    path.join("C:/repo", "src", "Calc.cs")
  );

  // Trailing slash on the shadow dir must not double-strip or miss.
  assert.equal(shadowToRepoPath("/tmp/shadow/", "/repo", "/tmp/shadow/A.cs"), path.join("/repo", "A.cs"));

  // A path outside the shadow (generated file, SDK source) passes through.
  assert.equal(shadowToRepoPath("/tmp/shadow", "/repo", "/usr/lib/dotnet/x.cs"), "/usr/lib/dotnet/x.cs");
  // A sibling whose name merely starts with the shadow dir's is NOT inside it.
  assert.equal(shadowToRepoPath("/tmp/shadow", "/repo", "/tmp/shadow-other/A.cs"), "/tmp/shadow-other/A.cs");
});

test("fastPathDiagnosticEvents: shadow paths map home, errors group per owning project, unowned files drop", () => {
  const shadowDir = "/tmp/shadow";
  const repoRoot = "/repo";
  const projectRelFor = (abs: string): string | undefined => {
    if (abs.includes(`${path.sep}Lib${path.sep}`)) return "src/Lib/Lib.csproj";
    if (abs.includes(`${path.sep}App${path.sep}`)) return "src/App/App.csproj";
    return undefined; // e.g. a generated file outside any project
  };
  const events = fastPathDiagnosticEvents(
    [
      { id: "CS0103", severity: "error", message: "The name 'bogus' does not exist", file: "/tmp/shadow/src/Lib/Calc.cs", startLine: 6, startCol: 19, endLine: 6, endCol: 24 },
      { id: "CS1002", severity: "error", message: "; expected", file: "/tmp/shadow/src/Lib/Extra.cs", startLine: 3, startCol: 0 },
      { id: "CS0246", severity: "error", message: "type not found", file: "/tmp/shadow/src/App/Main.cs", startLine: 1, startCol: 4 },
      { id: "CS0518", severity: "error", message: "predefined type missing", file: "/tmp/shadow/obj/Gen.cs", startLine: 0, startCol: 0 },
    ],
    shadowDir,
    repoRoot,
    projectRelFor
  );

  assert.equal(events.length, 2, "one set event per owning project; unowned errors dropped");
  const byProject = new Map(events.map((e) => [e.projectRel, e]));
  const lib = byProject.get("src/Lib/Lib.csproj");
  assert.equal(lib?.kind, "set");
  assert.equal(lib?.kind === "set" && lib.diagnostics.length, 2, "Lib's two errors travel together");
  if (lib?.kind === "set") {
    const first = lib.diagnostics[0];
    assert.equal(first.file, path.join("/repo", "src", "Lib", "Calc.cs"), "shadow path mapped back into the repo");
    assert.equal(first.code, "CS0103", "diagnostic id becomes the code");
    assert.equal(first.severity, "error");
    assert.equal(first.startLine, 6);
    assert.equal(first.startCol, 19);
    assert.equal(first.endCol, 24);
    assert.equal(first.project, "src/Lib/Lib.csproj");
  }
  const app = byProject.get("src/App/App.csproj");
  assert.equal(app?.kind === "set" && app.diagnostics.length, 1);
});
