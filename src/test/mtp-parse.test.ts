import * as assert from "node:assert/strict";
import { test } from "node:test";
import { mtpOutcomes, parseMtpRunOutput } from "../core/mtp";

/* ------------------------------------------------------------------ */
/*  parseMtpRunOutput — edge cases for the MTP exec fallback          */
/* ------------------------------------------------------------------ */

test("parseMtpRunOutput: empty output", () => {
  const result = parseMtpRunOutput("");
  assert.equal(result.failed.length, 0);
  assert.equal(result.counts, null);
});

test("parseMtpRunOutput: no failures, no counts", () => {
  const result = parseMtpRunOutput("Test run succeeded.");
  assert.equal(result.failed.length, 0);
  assert.equal(result.counts, null);
});

test("parseMtpRunOutput: failed test with message lines", () => {
  const stdout = [
    "xUnit.net v3 Microsoft.Testing.Platform Runner v2.0.3",
    "",
    "failed Demo.Tests.CalcTests.Applies_a_percentage_discount (14ms)",
    "  Assert.Equal() Failure: Values differ",
    "  Expected: 91",
    "  Actual:   90",
  ].join("\n");
  const result = parseMtpRunOutput(stdout);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].fqn, "Demo.Tests.CalcTests.Applies_a_percentage_discount");
  assert.ok(result.failed[0].message.includes("Assert.Equal() Failure"));
});

test("parseMtpRunOutput: multiple failures", () => {
  const stdout = [
    "failed A.B.C.Adds (5ms)",
    "  Expected: 1, got 2",
    "failed A.B.C.Subtracts (3ms)",
    "  Expected: -1, got 0",
  ].join("\n");
  const result = parseMtpRunOutput(stdout);
  assert.equal(result.failed.length, 2);
  assert.equal(result.failed[0].fqn, "A.B.C.Adds");
  assert.equal(result.failed[1].fqn, "A.B.C.Subtracts");
});

test("parseMtpRunOutput: counts with extra whitespace", () => {
  const stdout = [
    "Test run summary: Failed! - /x/T.dll",
    "  total:   5",
    "  failed:  1",
    "  succeeded: 3",
    "  skipped: 1",
  ].join("\n");
  const result = parseMtpRunOutput(stdout);
  assert.deepEqual(result.counts, { total: 5, failed: 1, succeeded: 3, skipped: 1 });
});

test("parseMtpRunOutput: counts without total (partial output)", () => {
  const stdout = "Test run summary: Failed!\n  failed: 1";
  const result = parseMtpRunOutput(stdout);
  assert.equal(result.counts, null); // no total → no counts object
});

test("parseMtpRunOutput: failure line with spaces in FQN (NUnit params) — no match", () => {
  // The regex ^failed\s+(\S+)\s+\( requires (\S+)\s+\( to match.
  // A FQN with spaces inside parens like "Demo.Fixture(x: 1, y: 2).Method"
  // causes (\S+) to stop at the first space, leaving "1, y: 2)" before the "(",
  // so the regex fails entirely. BUG: the regex doesn't handle FQNs with
  // spaces inside parens.
  const stdout = 'failed Demo.Fixture(x: 1, y: 2).Method (10ms)\n  Error here';
  const result = parseMtpRunOutput(stdout);
  assert.equal(result.failed.length, 0, "spaces inside parens break the regex");
});

test("parseMtpRunOutput: non-indented line after 'failed' stops message capture", () => {
  // The message collection loop breaks when it encounters a line that
  // doesn't match ^\s+\S (must start with whitespace then non-whitespace).
  const stdout = [
    "failed A.B.C.M (5ms)",
    "Not a message (no leading space)",
    "  This IS a message (but too late — loop already exited)",
  ].join("\n");
  const result = parseMtpRunOutput(stdout);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].message, "", "non-indented line breaks message collection");
});

test("parseMtpRunOutput: message lines capped at 8", () => {
  const lines = ["failed A.B.C.M (1ms)"];
  for (let i = 0; i < 12; i++) {
    lines.push(`  Message line ${i}`);
  }
  const result = parseMtpRunOutput(lines.join("\n"));
  assert.ok(result.failed[0].message.length > 0, "should have some message content");
  const msgLines = result.failed[0].message.split("\n");
  assert.ok(msgLines.length <= 8, `max 8 message lines, got ${msgLines.length}`);
});

test("parseMtpRunOutput: indented continuation lines after non-indented line", () => {
  // After the non-indented line breaks the loop, the next indented lines
  // are not captured for the current failure (they'll be ignored entirely).
  const stdout = [
    "failed A.B.C.M (5ms)",
    "  Message part 1",
    "Not a message",
    "  This is separate",
    "failed A.B.C.M2 (3ms)",
    "  Message part 2",
  ].join("\n");
  const result = parseMtpRunOutput(stdout);
  assert.equal(result.failed.length, 2);
  assert.equal(result.failed[0].message, "Message part 1");
  assert.equal(result.failed[1].message, "Message part 2");
});

/* ------------------------------------------------------------------ */
/*  mtpOutcomes — synthesized outcomes from MTP run output            */
/* ------------------------------------------------------------------ */

test("mtpOutcomes: failures + passes from discovered methods", () => {
  const parsed = parseMtpRunOutput([
    "failed Demo.CalcTests.Adds (5ms)",
    "  Expected: 3",
    "Test run summary:",
    "  total: 3",
    "  failed: 1",
    "  succeeded: 1",
    "  skipped: 1",
  ].join("\n"));
  const outcomes = mtpOutcomes(
    ["Demo.CalcTests.Adds", "Demo.CalcTests.Muls", "Demo.CalcTests.Divides"],
    parsed
  );
  assert.equal(outcomes.length, 3);
  const adds = outcomes.find((o) => o.method === "Adds");
  assert.ok(adds && !adds.passed && !adds.skipped, "Adds should be failed");
  const muls = outcomes.find((o) => o.method === "Muls");
  assert.ok(muls && muls.passed, "Muls should be passed");
});

test("mtpOutcomes: empty discovered methods — only failures reported", () => {
  const parsed = parseMtpRunOutput("failed Demo.CalcTests.Adds (5ms)\n  Error");
  const outcomes = mtpOutcomes([], parsed);
  assert.equal(outcomes.length, 1);
  assert.ok(!outcomes[0].passed, "failure must be reported even with no discovery");
});

test("mtpOutcomes: empty arrays — no outcomes", () => {
  const parsed = parseMtpRunOutput("");
  const outcomes = mtpOutcomes([], parsed);
  assert.equal(outcomes.length, 0);
});

test("mtpOutcomes: skipped tests not in discovered methods are not reported", () => {
  const stdout = [
    "failed Demo.CalcTests.Adds (5ms)",
    "Test run summary:",
    "  total: 2",
    "  failed: 1",
    "  succeeded: 0",
    "  skipped: 1",
  ].join("\n");
  const parsed = parseMtpRunOutput(stdout);
  const outcomes = mtpOutcomes(["Demo.CalcTests.Adds"], parsed);
  assert.equal(outcomes.length, 1, "skipped not in discovered → only failure reported");
});

test("mtpOutcomes: un-FQN-shaped failure line (no dot) — classOf from discover returns undefined, skipped", () => {
  // classOf("NotAFQN") from discover.ts returns undefined (no dots)
  // So mtpOutcomes skips it (cls is falsy). This is correct — a line
  // without dots can't be split into class+method.
  const parsed = parseMtpRunOutput("failed NotAFQN (5ms)\n  Error");
  const outcomes = mtpOutcomes(["NotAFQN"], parsed);
  assert.equal(outcomes.length, 0, "no dots → classOf returns undefined → skipped");
});

test("mtpOutcomes: discovered methods not in failures are passed", () => {
  const parsed = parseMtpRunOutput(""); // no failures at all
  const outcomes = mtpOutcomes(
    ["A.B.C.Method1", "A.B.C.Method2"],
    parsed
  );
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((o) => o.passed && !o.skipped), "all should be passed");
});
