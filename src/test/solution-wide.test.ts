import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * Solution-wide EnC session (#22), engine-facing half, end to end: two real
 * projects (Lib + Consumer, built the way the runner builds them — per
 * project, BuildProjectReferences=false, own binlog each), loaded into ONE
 * session with the metadata reference rewired into a ProjectReference.
 *
 * What must hold:
 *  - a cross-project edit (public signature change in Lib + call-site fix in
 *    Consumer, one save) emits updates for BOTH modules when the caller
 *    vouches that Lib's dependents are all in the session (apiGuardExempt);
 *  - WITHOUT that exemption the API-surface guard refuses exactly as before
 *    #22 — the relaxation is opt-in per project, computed from the graph;
 *  - single-module emits keep the legacy reply fields, so every pre-#22
 *    caller and test sees an unchanged protocol;
 *  - a load after a committed delta is refused: restarting the session would
 *    re-read disk baselines the hosts have already moved past (generation
 *    chaining), so only a rebuild (build path → reset) may re-shape the
 *    session mid-epoch.
 */

const LIB = `namespace Demo;

public static class Calc
{
    public static int Add(int a, int b)
    {
        return a + b;
    }
}
`;

const CONSUMER = `namespace Demo;

public static class Billing
{
    public static int Total(int a, int b)
    {
        return Calc.Add(a, b);
    }
}
`;

const LIB_EDIT = LIB
  .replace("public static int Add(int a, int b)", "public static int Add(int a, int b, int bonus)")
  .replace("return a + b;", "return a + b + bonus;");

const CONSUMER_EDIT = CONSUMER.replace("return Calc.Add(a, b);", "return Calc.Add(a, b, 0);");

interface Reply {
  ok: boolean;
  reason?: string;
  updates?: Array<{ assembly: string; md: string; il: string; pdb: string }>;
}

test("solution-wide session: cross-project edits emit per-module; guard and epoch rules hold", { timeout: 600_000 }, async () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const helper = await builtHelper(dotnet);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "impact-solution-wide-"));
  const proc = spawn(dotnet, [helper], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    fs.mkdirSync(path.join(d, "src", "Lib"), { recursive: true });
    fs.mkdirSync(path.join(d, "src", "Consumer"), { recursive: true });
    const libCsproj = path.join(d, "src", "Lib", "Lib.csproj");
    const conCsproj = path.join(d, "src", "Consumer", "Consumer.csproj");
    const libCs = path.join(d, "src", "Lib", "Calc.cs");
    const conCs = path.join(d, "src", "Consumer", "Billing.cs");
    fs.writeFileSync(
      libCsproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
    );
    fs.writeFileSync(
      conCsproj,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>' +
        '<ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup></Project>'
    );
    fs.writeFileSync(libCs, LIB);
    fs.writeFileSync(conCs, CONSUMER);

    // Build the way the runner's minimalBuild does: per project, own binlog,
    // no reference re-walk — so each complog holds exactly one compilation.
    const build = (csproj: string, binlog: string) =>
      execFileSync(
        dotnet,
        ["msbuild", csproj, "-t:Build", "-restore", "-p:BuildProjectReferences=false", "-nologo", "-v:q", `-bl:${binlog}`],
        { cwd: d, stdio: "pipe", timeout: 300_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
      );
    const libBinlog = path.join(d, "lib.binlog");
    const conBinlog = path.join(d, "consumer.binlog");
    build(libCsproj, libBinlog);
    build(conCsproj, conBinlog);
    const libDll = path.join(d, "src", "Lib", "bin", "Debug", "net8.0", "Lib.dll");
    const conDll = path.join(d, "src", "Consumer", "bin", "Debug", "net8.0", "Consumer.dll");
    assert.ok(fs.existsSync(libDll) && fs.existsSync(conDll), "scaffold builds produced both dlls");

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

    const libComplog = path.join(d, "lib.complog");
    const conComplog = path.join(d, "consumer.complog");
    assert.equal((await send({ cmd: "snapshot", binlog: libBinlog, complog: libComplog })).ok, true);
    assert.equal((await send({ cmd: "snapshot", binlog: conBinlog, complog: conComplog })).ok, true);

    const loadBoth = async () => {
      const l = await send({ cmd: "load", binlog: libComplog, csproj: libCsproj, dll: libDll });
      assert.equal(l.ok, true, `load Lib: ${l.reason}`);
      const c = await send({ cmd: "load", binlog: conComplog, csproj: conCsproj, dll: conDll });
      assert.equal(c.ok, true, `load Consumer: ${c.reason}`);
    };
    await loadBoth();

    // WITHOUT the exemption, the pre-#22 guard behavior is pinned: a changed
    // public signature refuses, whatever the session could have done.
    fs.writeFileSync(libCs, LIB_EDIT);
    fs.writeFileSync(conCs, CONSUMER_EDIT);
    const guarded = await send({ cmd: "delta", files: [libCs, conCs] });
    assert.equal(guarded.ok, false, "signature change without exemption must refuse");
    assert.match(guarded.reason ?? "", /api change/, `guard reason survives, got: ${guarded.reason}`);

    // WITH the exemption (the extension vouches all dependents are loaded),
    // the same save hot-patches: one emit, one update per touched module.
    // Without the metadata→ProjectReference rewiring this would be a compile
    // error (Consumer would still see the two-parameter Add).
    const cross = await send({ cmd: "delta", files: [libCs, conCs], apiGuardExempt: [libCsproj] });
    assert.equal(cross.ok, true, `cross-project save must hot-patch: ${cross.reason}`);
    const touched = (cross.updates ?? []).map((u) => u.assembly).sort();
    assert.deepEqual(touched, ["Consumer", "Lib"], `one update per module, got: ${touched.join(", ")}`);
    for (const u of cross.updates!) {
      assert.ok(u.md.length > 0 && u.il.length > 0, `${u.assembly}: delta must be non-empty`);
    }

    // Mid-epoch loads are refused after a commit: a session restart would
    // re-baseline from disk while the hosts run the committed generation.
    const midEpoch = await send({ cmd: "load", binlog: libComplog, csproj: libCsproj, dll: libDll });
    assert.equal(midEpoch.ok, false, "load after a committed delta must refuse");
    assert.match(midEpoch.reason ?? "", /mid-epoch/, `diagnosable refusal, got: ${midEpoch.reason}`);

    // Reset (what the build path does), restore, reload: a body-only edit
    // emits exactly one module through the same updates[] shape — the
    // pre-#22 legacy top-level fields are gone from the protocol.
    assert.equal((await send({ cmd: "reset" })).ok, true);
    fs.writeFileSync(libCs, LIB);
    fs.writeFileSync(conCs, CONSUMER);
    await loadBoth();
    fs.writeFileSync(libCs, LIB.replace("return a + b;", "return a + b + 0;"));
    const body = await send({ cmd: "delta", files: [libCs] });
    assert.equal(body.ok, true, `body edit: ${body.reason}`);
    assert.equal(body.updates?.length, 1, "body edit touches one module");
    assert.equal(body.updates?.[0]?.assembly, "Lib");
    assert.ok((body.updates?.[0]?.md ?? "").length > 0, "single-module emit must carry a real delta");
    assert.ok(!("md" in body) && !("assembly" in body), "legacy top-level reply fields must stay gone");
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
