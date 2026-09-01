import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { failureLocation, parseTrx, trxDurationToMs } from "../core/trx";

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
      <Output><ErrorInfo><Message>Assert.Equal() Failure: 1 &amp;lt; 2</Message><StackTrace>at Ns.CalcTests.Breaks() in /repo/src/CalcTests.cs:line 12</StackTrace></ErrorInfo></Output>
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
  assert.match(breaks.stackTrace ?? "", /CalcTests\.cs:line 12/);
  assert.equal(adds.stackTrace, undefined);

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

test("failureLocation: xunit-style unix frame under the repo", () => {
  const trace =
    "at Ns.CalcTests.Breaks() in /home/u/repo/src/CalcTests.cs:line 42";
  assert.deepEqual(failureLocation(trace, "/home/u/repo"), {
    file: "/home/u/repo/src/CalcTests.cs",
    line: 42,
  });
});

test("failureLocation: first in-repo frame wins over framework frames", () => {
  // NUnit shape: assertion frames from the framework precede the user's frame.
  const trace = [
    "at NUnit.Framework.Assert.That[TActual](TActual actual, IResolveConstraint expression) in /nuget/nunit/Assert.cs:line 300",
    "at Ns.CalcTests.Deep() in /home/u/repo/src/Helpers.cs:line 7",
    "at Ns.CalcTests.Breaks() in /home/u/repo/src/CalcTests.cs:line 42",
  ].join("\n");
  assert.deepEqual(failureLocation(trace, "/home/u/repo"), {
    file: "/home/u/repo/src/Helpers.cs",
    line: 7,
  });
});

test("failureLocation: async state machine and separator lines (MSTest/xunit)", () => {
  const trace = [
    "at Ns.CalcTests.<BreaksAsync>d__3.MoveNext() in C:\\repo\\src\\CalcTests.cs:line 55",
    "--- End of stack trace from previous location ---",
    "at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()",
  ].join("\r\n");
  assert.deepEqual(failureLocation(trace, "C:\\repo"), {
    file: "C:/repo/src/CalcTests.cs",
    line: 55,
  });
});

test("failureLocation: Windows paths compare case-insensitively", () => {
  const trace = "at Ns.T.M() in c:\\Repo\\Src\\T.cs:line 3";
  const loc = failureLocation(trace, "C:\\repo");
  assert.equal(loc?.line, 3);
  assert.equal(loc?.file, "c:/Repo/Src/T.cs");
});

test("failureLocation: shadow-worktree frames map back onto the repo", () => {
  const shadow = "/home/u/.impact/repo-abc123/shadow";
  const trace = `at Ns.CalcTests.Breaks() in ${shadow}/src/CalcTests.cs:line 42`;
  assert.deepEqual(failureLocation(trace, "/home/u/repo", shadow), {
    file: "/home/u/repo/src/CalcTests.cs",
    line: 42,
  });
  // Without the shadow mapping the frame is outside the repo: no location.
  assert.equal(failureLocation(trace, "/home/u/repo"), undefined);
});

test("failureLocation: no 'in file:line' info at all", () => {
  const trace = [
    "at Xunit.Assert.Equal[T](T expected, T actual)",
    "at Ns.CalcTests.Breaks()",
  ].join("\n");
  assert.equal(failureLocation(trace, "/home/u/repo"), undefined);
});

test("failureLocation: frames outside the repo never match", () => {
  const trace = "at Other.T.M() in /home/u/other-repo/T.cs:line 9";
  assert.equal(failureLocation(trace, "/home/u/repo"), undefined);
});
