import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseTrx, trxDurationToMs } from "../core/trx";

test("trxDurationToMs: hours, precision, malformed", () => {
  assert.equal(trxDurationToMs("01:02:03.5"), 3723500);
  assert.ok(Math.abs(trxDurationToMs("00:00:00.0012345") - 1.2345) < 0.001);
  assert.equal(trxDurationToMs("garbage"), 0);
  assert.equal(trxDurationToMs(""), 0);
});

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testId="id-1" testName="Ns.CalcTests.Adds" outcome="Passed" duration="00:00:01.500" />
    <UnitTestResult testId="id-2" testName="Ns.CalcTests.Breaks" outcome="Failed" duration="00:00:00.250">
      <Output><ErrorInfo><Message>Assert.Equal() Failure: 1 &amp;lt; 2</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testId="id-3" testName="Ns.CalcTests.SkippedOne" outcome="NotExecuted" />
  </Results>
  <TestDefinitions>
    <UnitTest id="id-1"><TestMethod className="Ns.CalcTests, Tests, Version=1.0" name="Adds" /></UnitTest>
    <UnitTest id="id-2"><TestMethod className="Ns.CalcTests, Tests, Version=1.0" name="Breaks" /></UnitTest>
    <UnitTest id="id-3"><TestMethod className="Ns.CalcTests, Tests, Version=1.0" name="SkippedOne" /></UnitTest>
  </TestDefinitions>
</TestRun>`;

function writeTrx(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impact-trx-test-"));
  const p = path.join(dir, "run.trx");
  fs.writeFileSync(p, content);
  return p;
}

test("parseTrx: passed, failed, and skipped outcomes", () => {
  const outcomes = parseTrx(writeTrx(TRX));
  assert.equal(outcomes.length, 3);

  const adds = outcomes.find((o) => o.method === "Ns.CalcTests.Adds")!;
  assert.equal(adds.passed, true);
  assert.equal(adds.skipped, false);
  assert.equal(adds.durationMs, 1500);
  assert.equal(adds.classFqn, "Ns.CalcTests");

  const breaks = outcomes.find((o) => o.method === "Ns.CalcTests.Breaks")!;
  assert.equal(breaks.passed, false);
  assert.equal(breaks.skipped, false);
  assert.match(breaks.message ?? "", /Assert\.Equal/);

  // The regression this suite guards: skipped must NOT count as failed.
  const skipped = outcomes.find((o) => o.method === "Ns.CalcTests.SkippedOne")!;
  assert.equal(skipped.passed, false);
  assert.equal(skipped.skipped, true);
});

test("parseTrx: class falls back to display-name parsing without a definition", () => {
  const trx = `<?xml version="1.0"?><TestRun><Results>
    <UnitTestResult testId="x" testName="A.B.CTests.Method(arg: 1)" outcome="Passed" />
  </Results></TestRun>`;
  const outcomes = parseTrx(writeTrx(trx));
  assert.equal(outcomes[0].classFqn, "A.B.CTests");
});
