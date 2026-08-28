import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { test } from "node:test";
import { builtHelper, dotnetOrNull } from "./deltas-helper";

/**
 * Unit tests for the delta service's API guard, driven through the helper's
 * "guard" command (pure: two source texts in, verdict out).
 *
 * With Roslyn's EnC engine deciding patchability, the guard's only job is
 * cross-project safety: the per-project session can't see dependents, so a
 * non-private declaration that DISAPPEARS (removal/rename/re-signature) must
 * force the build path — the engine alone would model it as "add new, keep
 * old alive in metadata" and dependent test assemblies would stay green
 * against an API that no longer compiles.
 *
 * Everything else — whitespace (the historical false-structural bug), body
 * edits, added members — passes through to the engine.
 */

interface GuardReply {
  ok: boolean;
  reason?: string;
}

/** One helper process for all cases; guard(old, new) over the jsonl protocol. */
async function withGuard(
  run: (guard: (oldSrc: string, newSrc: string) => Promise<GuardReply>) => Promise<void>
): Promise<void> {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const dll = await builtHelper(dotnet);
  const proc = spawn(dotnet, [dll], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map<number, (r: GuardReply) => void>();
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "done") pending.get(msg.id)?.(msg);
    } catch {
      /* chatter */
    }
  });
  let nextId = 1;
  const guard = (oldSrc: string, newSrc: string): Promise<GuardReply> => {
    const id = nextId++;
    const reply = new Promise<GuardReply>((resolve) => pending.set(id, resolve));
    proc.stdin.write(JSON.stringify({ id, cmd: "guard", old: oldSrc, new: newSrc }) + "\n");
    return reply;
  };
  try {
    await run(guard);
  } finally {
    try {
      proc.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
    } catch {
      /* already gone */
    }
    setTimeout(() => proc.kill(), 2000).unref();
  }
}

const SOURCE = `namespace Ns;

public class Edi810
{
    public string? OriginalFullName { get; set; }

    public Invoices? Invoices { get; set; }

    private int _cache;

    private int Cached() => _cache;

    public int Total(int a, int b)
    {
        return a + b;
    }
}
public class Invoices { }
`;

test("guard passes whitespace and additive/body edits through to the engine", { timeout: 300_000 }, async () => {
  await withGuard(async (guard) => {
    // Whitespace around and inside members (the historical false-structural bug).
    for (const [label, edited] of [
      ["blank line before property", SOURCE.replace("\n    public Invoices?", "\n\n    public Invoices?")],
      ["blank line removed", SOURCE.replace("{ get; set; }\n\n    public Invoices?", "{ get; set; }\n    public Invoices?")],
      ["accessor spacing", SOURCE.replace("OriginalFullName { get; set; }", "OriginalFullName { get;  set; }")],
      ["re-indented body", SOURCE.replace("        return a + b;", "            return a + b;")],
      // Behavior edits the engine handles.
      ["method body change", SOURCE.replace("return a + b;", "return a * b;")],
      ["added public method", SOURCE.replace("public class Invoices { }", "public class Invoices { public int N() => 1; }")],
      ["added property", SOURCE.replace("public Invoices? Invoices { get; set; }", "public Invoices? Invoices { get; set; }\n\n    public int Extra { get; set; }")],
      // Private surface may change freely: can't break other assemblies.
      ["private member removed", SOURCE.replace("    private int Cached() => _cache;\n", "")],
    ] as const) {
      const r = await guard(SOURCE, edited);
      assert.equal(r.ok, true, `${label}: ${r.reason}`);
    }
  });
});

const TEST_SOURCE = `namespace Ns;

using Xunit;

public class CalcTests
{
    [Fact]
    public void Adds() => Assert.Equal(4, 2 + 2);

    [Theory]
    [InlineData(1)]
    public void Cases(int n) => Assert.True(n > 0);

    private static int Helper() => 1;
}
`;

test("guard refuses newly added test methods (warm sessions can't discover them, #12)", { timeout: 300_000 }, async () => {
  await withGuard(async (guard) => {
    for (const [label, edited] of [
      ["new [Fact]", TEST_SOURCE.replace("    private static int Helper() => 1;", "    [Fact]\n    public void Subtracts() => Assert.Equal(0, 2 - 2);\n\n    private static int Helper() => 1;")],
      ["new [Theory]", TEST_SOURCE.replace("    private static int Helper() => 1;", "    [Theory]\n    [InlineData(2)]\n    public void MoreCases(int n) => Assert.True(n > 1);\n\n    private static int Helper() => 1;")],
      ["new [TestMethod] (MSTest)", TEST_SOURCE.replace("    private static int Helper() => 1;", "    [TestMethod]\n    public void MsTestStyle() { }\n\n    private static int Helper() => 1;")],
      ["new [FactAttribute] long form", TEST_SOURCE.replace("    private static int Helper() => 1;", "    [FactAttribute]\n    public void LongForm() { }\n\n    private static int Helper() => 1;")],
    ] as const) {
      const r = await guard(TEST_SOURCE, edited);
      assert.equal(r.ok, false, `${label} should be refused`);
      assert.match(r.reason ?? "", /^new test method: /, label);
    }

    // Non-test additions and edits inside a test file stay on the fast path.
    for (const [label, edited] of [
      ["new plain helper method", TEST_SOURCE.replace("    private static int Helper() => 1;", "    private static int Helper() => 1;\n\n    public static int Other() => 2;")],
      ["new [InlineData] case on an existing theory", TEST_SOURCE.replace("    [InlineData(1)]", "    [InlineData(1)]\n    [InlineData(5)]")],
      ["test body edit", TEST_SOURCE.replace("Assert.Equal(4, 2 + 2)", "Assert.Equal(4, 1 + 3)")],
    ] as const) {
      const r = await guard(TEST_SOURCE, edited);
      assert.equal(r.ok, true, `${label}: ${r.reason}`);
    }
  });
});

test("guard refuses disappearing non-private declarations", { timeout: 300_000 }, async () => {
  await withGuard(async (guard) => {
    for (const [label, edited] of [
      ["method signature change", SOURCE.replace("public int Total(int a, int b)", "public long Total(long a, long b)")],
      ["property type change", SOURCE.replace("public string? OriginalFullName", "public int OriginalFullName")],
      ["public method removed", SOURCE.replace("    public int Total(int a, int b)\n    {\n        return a + b;\n    }\n", "")],
      ["public type renamed", SOURCE.replace("public class Invoices { }", "public class Invoicing { }")],
      ["property removed", SOURCE.replace("    public Invoices? Invoices { get; set; }\n", "")],
    ] as const) {
      const r = await guard(SOURCE, edited);
      assert.equal(r.ok, false, `${label} should be refused`);
      assert.match(r.reason ?? "", /^api change: /, label);
    }
  });
});
