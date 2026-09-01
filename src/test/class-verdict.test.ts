import * as assert from "node:assert/strict";
import { test } from "node:test";
import { classVerdicts, TestOutcome } from "../core/trx";

/**
 * Regression for the v0.4.0 green-icon bug: build-failure skips carry no
 * failures, so the explorer's passed-only class rollup read an all-skipped
 * class as PASSED and painted a green check over grey method rows — stale
 * binaries presented as a verdict. The rollup must say "skipped" there.
 */

const o = (classFqn: string, method: string, r: "pass" | "fail" | "skip"): TestOutcome => ({
  classFqn,
  method,
  passed: r === "pass",
  skipped: r === "skip",
  message: r === "skip" ? "build failed" : undefined,
});

test("classVerdicts: an all-skipped class is skipped, never passed (v0.4.0 green-icon bug)", () => {
  const v = classVerdicts([
    o("Demo.CalcTests", "Demo.CalcTests.Adds", "skip"),
    o("Demo.CalcTests", "Demo.CalcTests.Discounts", "skip"),
  ]);
  assert.equal(v.get("Demo.CalcTests"), "skipped");
});

test("classVerdicts: one real run among skips is a pass; any failure wins over both", () => {
  const v = classVerdicts([
    o("A.T", "A.T.Ran", "pass"),
    o("A.T", "A.T.Skipped", "skip"),
    o("B.T", "B.T.Ran", "pass"),
    o("B.T", "B.T.Broke", "fail"),
    o("B.T", "B.T.Skipped", "skip"),
  ]);
  assert.equal(v.get("A.T"), "passed");
  assert.equal(v.get("B.T"), "failed");
});

test("classVerdicts: theory cases collapse per method; one failing case fails the class", () => {
  const v = classVerdicts([
    o("C.T", 'C.T.Cases(x: 1)', "pass"),
    o("C.T", 'C.T.Cases(x: 2)', "fail"),
  ]);
  assert.equal(v.get("C.T"), "failed");
});

test("classVerdicts: classes roll up independently", () => {
  const v = classVerdicts([
    o("Broken.T", "Broken.T.M1", "skip"),
    o("Fine.T", "Fine.T.M1", "pass"),
  ]);
  assert.equal(v.get("Broken.T"), "skipped");
  assert.equal(v.get("Fine.T"), "passed");
});
