import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs, validateCommandArgs } from "../core/cliArgs";

test("parseCliArgs: command, flags, and positional files separate cleanly", () => {
  const p = parseCliArgs(["run", "src/A.cs", "--base", "origin/main", "src/B.cs", "--staged"]);
  assert.equal(p.command, "run");
  assert.deepEqual(p.files, ["src/A.cs", "src/B.cs"]);
  assert.equal(p.flags.get("--base"), "origin/main");
  assert.equal(p.flags.get("--staged"), true);
  assert.deepEqual(p.errors, []);
});

test("parseCliArgs: value flags never swallow a following flag", () => {
  const p = parseCliArgs(["affected", "--base", "--staged"]);
  assert.deepEqual(p.errors, ["--base requires a value"]);
  // --staged was not consumed as --base's value.
  assert.equal(p.flags.get("--staged"), true);
});

test("parseCliArgs: unknown flags are errors, not silently ignored", () => {
  const p = parseCliArgs(["run", "--jsno"]);
  assert.deepEqual(p.errors, ["unknown flag: --jsno"]);
});

test("parseCliArgs: no command", () => {
  const p = parseCliArgs([]);
  assert.equal(p.command, undefined);
  assert.deepEqual(p.files, []);
});

test("validateCommandArgs: flags and files are rejected per command", () => {
  // --parallel belongs to build-map only; run must not accept-and-ignore it.
  assert.deepEqual(validateCommandArgs(parseCliArgs(["run", "--parallel", "4"])), [
    "--parallel is not valid for run",
  ]);
  assert.deepEqual(validateCommandArgs(parseCliArgs(["build-map", "--staged"])), [
    "--staged is not valid for build-map",
  ]);
  assert.deepEqual(validateCommandArgs(parseCliArgs(["status", "a.cs"])), [
    "status does not take file arguments",
  ]);
  assert.deepEqual(validateCommandArgs(parseCliArgs(["run", "a.cs", "--staged"])), []);
  assert.deepEqual(validateCommandArgs(parseCliArgs(["build-map", "--refresh", "--parallel", "4"])), []);
});
