import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveDotnet } from "../core/util";

/**
 * Shared harness for tests that drive the ImpactDeltas helper
 * (delta-guard.test.ts, complog-lock.test.ts). Not a test file itself —
 * the runner's glob only picks up *.test.js.
 */

const HELPER_SRC = path.join(__dirname, "../../helper-deltas");
const ENC_SRC = path.join(__dirname, "../../helper-enc");

export function dotnetOrNull(): string | null {
  try {
    const dotnet = resolveDotnet();
    execFileSync(dotnet, ["--version"], { stdio: "pipe", timeout: 30_000 });
    return dotnet;
  } catch {
    return null;
  }
}

/**
 * Build the helper into a stamped tmp cache (rebuilds only on source change).
 * node --test runs test files in parallel processes and two of them share this
 * cache: on a cold cache both would launch `dotnet build` of the same csproj
 * at once, racing on obj/ and the output dir (a real CI failure). A mkdir
 * lock serializes the build; the loser re-checks the stamp and reuses it.
 */
export async function builtHelper(dotnet: string): Promise<string> {
  const bin = path.join(os.tmpdir(), "impact-guard-test-bin");
  const dll = path.join(bin, "ImpactDeltas.dll");
  const stampFile = path.join(bin, ".source-stamp");
  const src = [HELPER_SRC, ENC_SRC]
    .flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".cs") || f.endsWith(".csproj") || f.endsWith(".snk"))
        .sort()
        .map((f) => fs.readFileSync(path.join(dir, f)).toString("base64"))
    )
    .join("\n");
  const want = crypto.createHash("sha1").update(src).digest("hex");
  const fresh = (): boolean => {
    try {
      return fs.existsSync(dll) && fs.readFileSync(stampFile, "utf8") === want;
    } catch {
      return false;
    }
  };
  if (fresh()) return dll;

  const lock = bin + ".build-lock";
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      fs.mkdirSync(lock, { recursive: false });
      break;
    } catch {
      try {
        // A crashed builder leaves the lock behind: steal it once it's old.
        if (Date.now() - fs.statSync(lock).mtimeMs > 10 * 60_000) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat: retry immediately
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the helper build lock");
      await sleep(500);
    }
  }
  try {
    if (fresh()) return dll; // the other process built it while we waited
    execFileSync(
      dotnet,
      ["build", path.join(HELPER_SRC, "ImpactDeltas.csproj"), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
      { stdio: "pipe", timeout: 300_000, env: { ...process.env, MSBUILDTERMINALLOGGER: "off" } }
    );
    fs.writeFileSync(stampFile, want);
    return dll;
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}
