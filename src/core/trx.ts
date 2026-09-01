import { XMLParser } from "fast-xml-parser";
import * as fs from "fs";

export interface TestOutcome {
  classFqn: string;
  method: string;
  passed: boolean;
  /** Test was skipped (e.g. [Fact(Skip=...)]); passed is false but it is not a failure. */
  skipped: boolean;
  message?: string;
  /** Raw ErrorInfo.StackTrace; resolve to a source line via failureLocation(). */
  stackTrace?: string;
  durationMs?: number;
}

/**
 * Roll per-outcome results up to a class verdict the way the explorer groups
 * them: theory cases collapse into one method (display args stripped), a
 * method is skipped only when every case skipped, and the class is
 *  - "failed":  any method really failed;
 *  - "passed":  none failed and at least one actually ran;
 *  - "skipped": every method skipped — e.g. "build failed", where painting
 *    the class green would present stale binaries as a verdict (the v0.4.0
 *    green-icon bug: skips have no failures, so a passed-only rollup read
 *    them as passes).
 */
export function classVerdicts(outcomes: TestOutcome[]): Map<string, "passed" | "failed" | "skipped"> {
  const byMethod = new Map<string, TestOutcome[]>();
  for (const o of outcomes) {
    const key = o.method.replace(/\(.*\)$/s, "");
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key)!.push(o);
  }
  const verdicts = new Map<string, "passed" | "failed" | "skipped">();
  for (const results of byMethod.values()) {
    const cls = results[0].classFqn;
    const mine = results.some((r) => !r.passed && !r.skipped)
      ? "failed"
      : results.every((r) => r.skipped)
        ? "skipped"
        : "passed";
    const cur = verdicts.get(cls);
    // Precedence: failed > passed > skipped.
    verdicts.set(
      cls,
      cur === "failed" || mine === "failed" ? "failed" : cur === "passed" || mine === "passed" ? "passed" : "skipped"
    );
  }
  return verdicts;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseTrx(trxPath: string): TestOutcome[] {
  const xml = fs.readFileSync(trxPath, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    isArray: (name) => ["UnitTestResult", "UnitTest"].includes(name),
  });
  const doc = parser.parse(xml);
  const results = doc?.TestRun?.Results?.UnitTestResult ?? [];
  const defs = doc?.TestRun?.TestDefinitions?.UnitTest ?? [];
  const classByTestId = new Map<string, string>();
  for (const d of defs) {
    const id = d["@_id"];
    const cls = d?.TestMethod?.["@_className"];
    if (id && cls) classByTestId.set(id, String(cls).split(",")[0]);
  }
  const outcomes: TestOutcome[] = [];
  for (const r of results) {
    const testName: string = decodeXml(r["@_testName"] ?? "");
    const cls =
      classByTestId.get(r["@_testId"]) ??
      testName.replace(/\(.*\)$/s, "").split(".").slice(0, -1).join(".");
    const duration: string | undefined = r["@_duration"];
    const outcome: string = r["@_outcome"] ?? "";
    outcomes.push({
      classFqn: cls,
      method: testName,
      passed: outcome === "Passed",
      skipped: outcome === "NotExecuted" || outcome === "Skipped" || outcome === "Inconclusive",
      message: r?.Output?.ErrorInfo?.Message
        ? decodeXml(String(r.Output.ErrorInfo.Message))
        : undefined,
      stackTrace: r?.Output?.ErrorInfo?.StackTrace
        ? decodeXml(String(r.Output.ErrorInfo.StackTrace))
        : undefined,
      durationMs: duration ? trxDurationToMs(duration) : undefined,
    });
  }
  return outcomes;
}

/**
 * Pick the failing assert line out of a stack trace: the first frame of the
 * form `at Ns.Cls.Method() in /path/File.cs:line 42` whose file lives under
 * repoRoot. Tests run against the shadow worktree, so frames under shadowDir
 * are mapped back onto repoRoot before the containment check. Path comparison
 * is case-insensitive and separator-agnostic (TRX may carry Windows paths).
 * Returns the repo-side path and 1-based line, or undefined when no frame
 * resolves into the repo.
 */
export function failureLocation(
  stackTrace: string,
  repoRoot: string,
  shadowDir?: string
): { file: string; line: number } | undefined {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const rootNorm = norm(repoRoot);
  const rootLower = rootNorm.toLowerCase();
  const shadowLower = shadowDir ? norm(shadowDir).toLowerCase() : undefined;
  for (const m of stackTrace.matchAll(/\bin (.+?):line (\d+)/g)) {
    let file = norm(m[1]);
    if (shadowLower && file.toLowerCase().startsWith(shadowLower + "/")) {
      file = rootNorm + file.slice(shadowLower.length);
    }
    const lower = file.toLowerCase();
    if (lower === rootLower || lower.startsWith(rootLower + "/")) {
      return { file, line: Number(m[2]) };
    }
  }
  return undefined;
}

export function trxDurationToMs(d: string): number {
  const m = d.match(/^(\d+):(\d+):([\d.]+)$/);
  if (!m) return 0;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}
