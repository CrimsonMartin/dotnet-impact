import * as assert from "node:assert/strict";
import { test } from "node:test";
import { classesRecord, parseListedTests } from "../core/discover";

test("VSTest format: method FQNs after marker, theory args stripped and deduped", () => {
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
    "Ns.CalcTests.Adds",
    "Ns.CalcTests.Subtracts",
    "Ns.TheoryTests.Case",
    "Other.Deep.Space.MoreTests.Works",
  ]);
});

test("VSTest format: chatter lines after the marker are rejected", () => {
  const stdout = [
    "The following Tests are available:",
    "    Ns.CalcTests.Adds",
    "Test run for /repo/bin/Tests.dll (.NETCoreApp,Version=v8.0)",
  ].join("\n");
  assert.deepEqual(parseListedTests(stdout), ["Ns.CalcTests.Adds"]);
});

test("nested classes keep the + form", () => {
  const stdout = ["The following Tests are available:", "  Ns.Outer+Inner.Method"].join("\n");
  assert.deepEqual(parseListedTests(stdout), ["Ns.Outer+Inner.Method"]);
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
  assert.deepEqual(parseListedTests(stdout), [
    "MyApp.Tests.CalcTests.Adds",
    "MyApp.Tests.CalcTests.Divides",
  ]);
});

test("MTP format: two-segment lines are too ambiguous and skipped", () => {
  assert.deepEqual(parseListedTests("Class.Method"), []);
});

test("classesRecord collapses per-project methods to distinct classes", () => {
  assert.deepEqual(
    classesRecord({
      "tests/T/T.csproj": ["Ns.B.M2", "Ns.A.M1", "Ns.A.M0", "Ns.Outer+Inner.M"],
      "tests/U/U.csproj": [],
    }),
    {
      "tests/T/T.csproj": ["Ns.A", "Ns.B", "Ns.Outer+Inner"],
      "tests/U/U.csproj": [],
    }
  );
});
