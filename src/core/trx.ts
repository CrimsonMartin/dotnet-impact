import { XMLParser } from "fast-xml-parser";
import * as fs from "fs";

export interface TestOutcome {
  classFqn: string;
  method: string;
  passed: boolean;
  /** Test was skipped (e.g. [Fact(Skip=...)]); passed is false but it is not a failure. */
  skipped: boolean;
  message?: string;
  durationMs?: number;
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
      durationMs: duration ? trxDurationToMs(duration) : undefined,
    });
  }
  return outcomes;
}

export function trxDurationToMs(d: string): number {
  const m = d.match(/^(\d+):(\d+):([\d.]+)$/);
  if (!m) return 0;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}
