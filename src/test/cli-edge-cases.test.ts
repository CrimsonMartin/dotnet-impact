import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs, validateCommandArgs } from "../core/cliArgs";

/* ------------------------------------------------------------------ */
/*  CLI argument parsing — edge cases the existing suite misses       */
/* ------------------------------------------------------------------ */

test("parseCliArgs: unknown -- tokens are explicit errors, never silent files", () => {
  // Deliberate design: a token starting with -- that isn't a known flag is
  // rejected loudly instead of being misread as a path (so a typo'd flag
  // can't masquerade as a file argument).
  const p = parseCliArgs(["affected", "--base", "HEAD", "--base.cs"]);
  assert.equal(p.command, "affected");
  assert.deepEqual(p.files, [], "unknown -- tokens never land in files");
  assert.equal(p.flags.get("--base"), "HEAD");
  assert.deepEqual(p.errors, ["unknown flag: --base.cs"]);
});

test("parseCliArgs: multiple value flags consume independently", () => {
  // --base HEAD --parallel 4 should parse as two separate value flags.
  const p = parseCliArgs(["build-map", "--base", "HEAD", "--parallel", "4"]);
  assert.equal(p.command, "build-map");
  assert.equal(p.flags.get("--base"), "HEAD");
  assert.equal(p.flags.get("--parallel"), "4");
});

test("parseCliArgs: value flag at end of args with no value is an error", () => {
  const p = parseCliArgs(["affected", "--base"]);
  assert.deepEqual(p.errors, ["--base requires a value"]);
  // --base should NOT be set in flags.
  assert.equal(p.flags.has("--base"), false);
});

test("parseCliArgs: boolean flag after a value flag that consumed the next token", () => {
  // --base HEAD --staged: HEAD is consumed, --staged is a bool flag.
  const p = parseCliArgs(["affected", "--base", "HEAD", "--staged"]);
  assert.equal(p.flags.get("--base"), "HEAD");
  assert.equal(p.flags.get("--staged"), true);
});

test("parseCliArgs: empty argv returns undefined command and empty files", () => {
  const p = parseCliArgs([]);
  assert.equal(p.command, undefined);
  assert.deepEqual(p.files, []);
  assert.deepEqual(p.flags, new Map());
  assert.deepEqual(p.errors, []);
});

test("parseCliArgs: only a command, no flags or files", () => {
  const p = parseCliArgs(["status"]);
  assert.equal(p.command, "status");
  assert.deepEqual(p.files, []);
  assert.deepEqual(p.flags, new Map());
  assert.deepEqual(p.errors, []);
});

test("parseCliArgs: command with only boolean flags", () => {
  const p = parseCliArgs(["affected", "--staged"]);
  assert.equal(p.command, "affected");
  assert.deepEqual(p.files, []);
  assert.equal(p.flags.get("--staged"), true);
});

test("parseCliArgs: command with only file args (no flags)", () => {
  const p = parseCliArgs(["affected", "a.cs", "b.cs"]);
  assert.equal(p.command, "affected");
  assert.deepEqual(p.files, ["a.cs", "b.cs"]);
});

test("parseCliArgs: files before a value flag — files first, then flags", () => {
  const p = parseCliArgs(["affected", "a.cs", "--base", "HEAD"]);
  assert.equal(p.command, "affected");
  assert.deepEqual(p.files, ["a.cs"]);
  assert.equal(p.flags.get("--base"), "HEAD");
});

test("validateCommandArgs: --parallel 1 is valid (smallest positive integer)", () => {
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["build-map", "--parallel", "1"])),
    []
  );
});

test("validateCommandArgs: --parallel 0 is invalid (not positive)", () => {
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["build-map", "--parallel", "0"])),
    ["--parallel 0 is not valid (expected: a positive integer)"]
  );
});

test("validateCommandArgs: --parallel 9999999999 is valid (large positive integer)", () => {
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["build-map", "--parallel", "9999999999"])),
    []
  );
});

test("validateCommandArgs: --parallel leading zero is invalid", () => {
  // The regex /^[1-9]\d*$/ rejects leading zeros.
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["build-map", "--parallel", "01"])),
    ["--parallel 01 is not valid (expected: a positive integer)"]
  );
});

test("validateCommandArgs: --format empty string is invalid", () => {
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["affected", "--format", ""])),
    ["--format  is not valid (expected: lines, json)"]
  );
});

test("validateCommandArgs: unknown command returns no validation errors from validateCommandArgs", () => {
  // Unknown command: validateCommandArgs should return empty; the CLI handles
  // it via USAGE, not parse validation.
  const p = parseCliArgs(["bogus"]);
  assert.deepEqual(validateCommandArgs(p), [], "unknown command has no command-specific validation");
  // The error will come from the CLI's command switch, not here.
});

test("validateCommandArgs: multiple errors reported together", () => {
  const p = parseCliArgs(["build-map", "--staged", "--parallel", "abc", "a.cs"]);
  const errors = validateCommandArgs(p);
  assert.ok(
    errors.includes("--staged is not valid for build-map"),
    "wrong flag for command"
  );
  assert.ok(
    errors.includes("--parallel abc is not valid (expected: a positive integer)"),
    "invalid parallel value"
  );
});

test("validateCommandArgs: status command accepts no flags", () => {
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["status", "--refresh"])),
    ["--refresh is not valid for status"]
  );
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["status"])),
    []
  );
});

test("validateCommandArgs: build-map accepts --refresh and --if-missing together", () => {
  assert.deepEqual(
    validateCommandArgs(parseCliArgs(["build-map", "--refresh", "--if-missing"])),
    []
  );
});
