import { classOf } from "./discover";
import { TestOutcome } from "./trx";
import { exec } from "./util";

/**
 * Microsoft.Testing.Platform support: the exec fallback surfaces.
 *
 * MTP-native test projects (xunit v3 without the VSTest adapter, MSTest/NUnit
 * with their MTP runners enabled) are self-hosting executables. The VSTest
 * surfaces impact is built on go dark against them, silently:
 *
 *   - `dotnet test --list-tests` exits 0 with EMPTY output (the MSBuild
 *     passthrough runs no listing), so discovery finds nothing;
 *   - `--logger trx --results-directory` is accepted and ignored — no TRX is
 *     written, so runs report ok/fail (exit codes are correct) with ZERO
 *     per-test outcomes;
 *   - vstest.console cannot host them;
 *   - `--collect "Code Coverage"` is ignored — no report.
 *
 * Impact therefore runs MTP projects through the platform's own surfaces.
 * The PREFERRED path is the warm server-mode session (mtpSession.ts):
 * resident app, stable test-node uids, per-class filtering, per-test
 * outcomes, and hot-patchable hosts. THIS module is the fallback for when no
 * warm session is available — the app's console device, shared by every MTP
 * runner:
 *
 *   - `dotnet exec <app.dll> --list-tests` prints the standard
 *     "The following Tests are available:" listing (FQNs on xunit v3; bare
 *     display names on MSTest, which cannot be attributed to classes);
 *   - a run prints one `failed <FQN> (<duration>)` line per failing test,
 *     indented failure details, and a `Test run summary:` block; exit 0 =
 *     pass, non-zero = fail.
 *
 * The fallback executes the whole project per invocation and synthesizes
 * per-method outcomes — failed methods from the run output, passed methods
 * from the discovery listing minus the failures. Hot patch stays gated on
 * this path: a fresh MTP process loads disk assemblies, so an "applied"
 * patch would run stale code green.
 */

export interface MtpRunParse {
  /** Failing tests, FQN + first message line, in output order. */
  failed: Array<{ fqn: string; message: string }>;
  /** The summary block's counts, when the run printed one. */
  counts: { total: number; failed: number; succeeded: number; skipped: number } | null;
}

/**
 * Parse an MTP app's run output. `failed <FQN> (<duration>)` lines are the
 * platform's per-test failure records; the indented lines that follow are the
 * assertion message and stack.
 */
export function parseMtpRunOutput(stdout: string): MtpRunParse {
  const lines = stdout.split(/\r?\n/);
  const failed: Array<{ fqn: string; message: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^failed\s+(\S+)\s+\(/);
    if (!m) continue;
    const messageLines: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && messageLines.length < 8; j++) {
      messageLines.push(lines[j].trim());
    }
    failed.push({ fqn: m[1], message: messageLines.join("\n") });
  }
  const grab = (name: string): number | null => {
    const m = stdout.match(new RegExp(`^\\s*${name}:\\s*(\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const total = grab("total");
  return {
    failed,
    counts:
      total === null
        ? null
        : {
            total,
            failed: grab("failed") ?? 0,
            succeeded: grab("succeeded") ?? 0,
            skipped: grab("skipped") ?? 0,
          },
  };
}

/**
 * Synthesize per-method outcomes for an MTP project run: failures verbatim
 * from the run output, passes for every discovered method the run did not
 * fail. `discoveredMethods` comes from the discovery listing — when it is
 * empty (discovery raced a rebuild) only the failures are reported, which
 * still turns the tree red where it matters.
 */
export function mtpOutcomes(discoveredMethods: string[], parsed: MtpRunParse): TestOutcome[] {
  const failedSet = new Set(parsed.failed.map((f) => f.fqn));
  const outcomes: TestOutcome[] = [];
  for (const f of parsed.failed) {
    const cls = classOf(f.fqn);
    if (!cls) continue; // un-FQN-shaped chatter that matched the line pattern
    outcomes.push({
      classFqn: cls,
      method: f.fqn.slice(cls.length + 1),
      passed: false,
      skipped: false,
      message: f.message,
    });
  }
  for (const m of discoveredMethods) {
    if (failedSet.has(m)) continue;
    const cls = classOf(m);
    if (!cls) continue;
    outcomes.push({ classFqn: cls, method: m.slice(cls.length + 1), passed: true, skipped: false });
  }
  return outcomes;
}

/** List an MTP app's tests via its own runner (`dotnet exec <dll> --list-tests`). */
export async function mtpListTests(dll: string, cwd: string): Promise<{ code: number; stdout: string }> {
  const res = await exec("dotnet", ["exec", dll, "--list-tests"], cwd, 5 * 60_000);
  return { code: res.code, stdout: res.stdout };
}

/** Run an MTP app (whole project; MTP filter options are runner-specific). */
export async function mtpRun(
  dll: string,
  cwd: string,
  signal?: AbortSignal
): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec("dotnet", ["exec", dll], cwd, 10 * 60_000, signal);
}
