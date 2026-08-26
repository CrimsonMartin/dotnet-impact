import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseListedTests } from "../core/discover";

test("VSTest format: classes grouped from display names after marker", () => {
  const stdout = [
    "Determining projects to restore...",
    "The following Tests are available:",
    "    Ns.CalcTests.Adds",
    "    Ns.CalcTests.Subtracts",
    '    Ns.TheoryTests.Case(x: 1, y: "a)b")',
    "    Ns.TheoryTests.Case(x: 2, y: \"z\")",
    "    Other.Deep.Space.MoreTests.Works",
  ].join("\n");
  assert.deepEqual(parseListedTests(stdout), [
    "Ns.CalcTests",
    "Ns.TheoryTests",
    "Other.Deep.Space.MoreTests",
  ]);
});

test("VSTest format: chatter lines after the marker are rejected", () => {
  const stdout = [
    "The following Tests are available:",
    "    Ns.CalcTests.Adds",
    "Test run for /repo/bin/Tests.dll (.NETCoreApp,Version=v8.0)",
  ].join("\n");
  assert.deepEqual(parseListedTests(stdout), ["Ns.CalcTests"]);
});

test("nested classes keep the + form", () => {
  const stdout = ["The following Tests are available:", "  Ns.Outer+Inner.Method"].join("\n");
  assert.deepEqual(parseListedTests(stdout), ["Ns.Outer+Inner"]);
});

test("MTP format (no marker): strict FQN lines accepted, chatter rejected", () => {
  const stdout = [
    "  Determining projects to restore...",
    "  Tests.dll",
    "  MyApp.Tests.CalcTests.Adds",
    "  MyApp.Tests.CalcTests.Divides(x: 4, y: 2)",
    "  Passed!  - Failed: 0",
    "  1.2.3",
  ].join("\n");
  assert.deepEqual(parseListedTests(stdout), ["MyApp.Tests.CalcTests"]);
});

test("MTP format: two-segment lines are too ambiguous and skipped", () => {
  assert.deepEqual(parseListedTests("Class.Method"), []);
});
