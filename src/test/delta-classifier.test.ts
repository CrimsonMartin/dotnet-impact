import * as assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { test } from "node:test";
import { resolveDotnet } from "../core/util";

/**
 * Unit tests for the delta calculator's classification half, driven through
 * the helper's "classify" command (pure: two source texts in, verdict out —
 * no project build, binlog, or dll involved).
 *
 * Regression target (user-reported): adding/removing spacing around a
 * property classified as "structural: non-method change at …PropertyDeclaration…"
 * because members were compared with ToFullString(), which includes trivia.
 */

const HELPER_SRC = path.join(__dirname, "../../helper-deltas");

function dotnetOrNull(): string | null {
  try {
    const dotnet = resolveDotnet();
    execFileSync(dotnet, ["--version"], { stdio: "pipe", timeout: 30_000 });
    return dotnet;
  } catch {
    return null;
  }
}

/** Build the helper into a stamped tmp cache (rebuilds only on source change). */
function builtHelper(dotnet: string): string {
  const bin = path.join(os.tmpdir(), "impact-classifier-test-bin");
  const dll = path.join(bin, "ImpactDeltas.dll");
  const stampFile = path.join(bin, ".source-stamp");
  const src = fs
    .readdirSync(HELPER_SRC)
    .filter((f) => f.endsWith(".cs") || f.endsWith(".csproj"))
    .sort()
    .map((f) => fs.readFileSync(path.join(HELPER_SRC, f), "utf8"))
    .join("\n");
  const want = crypto.createHash("sha1").update(src).digest("hex");
  try {
    if (fs.existsSync(dll) && fs.readFileSync(stampFile, "utf8") === want) return dll;
  } catch {
    /* rebuild */
  }
  execFileSync(
    dotnet,
    ["build", path.join(HELPER_SRC, "ImpactDeltas.csproj"), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
    { stdio: "pipe", timeout: 300_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
  );
  fs.writeFileSync(stampFile, want);
  return dll;
}

interface ClassifyReply {
  ok: boolean;
  reason?: string;
  changed?: string[];
}

/** One helper process for all cases; classify(old, new) over the jsonl protocol. */
async function withClassifier(
  run: (classify: (oldSrc: string, newSrc: string) => Promise<ClassifyReply>) => Promise<void>
): Promise<void> {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK on this machine: nothing to test against
  const dll = builtHelper(dotnet);
  const proc = spawn(dotnet, [dll], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map<number, (r: ClassifyReply) => void>();
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "done") pending.get(msg.id)?.(msg);
    } catch {
      /* chatter */
    }
  });
  let nextId = 1;
  const classify = (oldSrc: string, newSrc: string): Promise<ClassifyReply> => {
    const id = nextId++;
    const reply = new Promise<ClassifyReply>((resolve) => pending.set(id, resolve));
    proc.stdin.write(JSON.stringify({ id, cmd: "classify", old: oldSrc, new: newSrc }) + "\n");
    return reply;
  };
  try {
    await run(classify);
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

    public int Total(int a, int b)
    {
        return a + b;
    }
}
public class Invoices { }
`;

test("whitespace-only edits are never structural", { timeout: 300_000 }, async () => {
  await withClassifier(async (classify) => {
    // Blank line added above a property (the user-reported case).
    let r = await classify(SOURCE, SOURCE.replace("\n    public Invoices?", "\n\n    public Invoices?"));
    assert.equal(r.ok, true, `blank line before property: ${r.reason}`);
    assert.deepEqual(r.changed, []);

    // Blank line removed between members.
    r = await classify(SOURCE, SOURCE.replace("{ get; set; }\n\n    public Invoices?", "{ get; set; }\n    public Invoices?"));
    assert.equal(r.ok, true, `blank line removed: ${r.reason}`);
    assert.deepEqual(r.changed, []);

    // Spacing inside a property's accessor list.
    r = await classify(SOURCE, SOURCE.replace("OriginalFullName { get; set; }", "OriginalFullName { get;  set; }"));
    assert.equal(r.ok, true, `accessor spacing: ${r.reason}`);
    assert.deepEqual(r.changed, []);

    // Trailing whitespace after a method's closing brace.
    r = await classify(SOURCE, SOURCE.replace("return a + b;\n    }", "return a + b;\n    }   "));
    assert.equal(r.ok, true, `trailing whitespace: ${r.reason}`);
    assert.deepEqual(r.changed, []);

    // Indentation change inside a method body (tokens identical).
    r = await classify(SOURCE, SOURCE.replace("        return a + b;", "            return a + b;"));
    assert.equal(r.ok, true, `re-indented body: ${r.reason}`);
    assert.deepEqual(r.changed, []);
  });
});

test("real edits still classify correctly", { timeout: 300_000 }, async () => {
  await withClassifier(async (classify) => {
    // Method body change: patchable, exactly that method.
    let r = await classify(SOURCE, SOURCE.replace("return a + b;", "return a * b;"));
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.changed, ["Edi810`0.M:Total`0(int,int)"]);

    // Property type change: structural.
    r = await classify(SOURCE, SOURCE.replace("public string? OriginalFullName", "public int OriginalFullName"));
    assert.equal(r.ok, false);
    assert.match(r.reason!, /^structural/);

    // New member: structural.
    r = await classify(SOURCE, SOURCE.replace("public class Invoices { }", "public class Invoices { public int N { get; set; } }"));
    assert.equal(r.ok, false);
    assert.match(r.reason!, /^structural/);
  });
});
