import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { mapShadowToRepo, parseMsbuildOutput } from "../core/buildDiagnostics";

test("parseMsbuildOutput: canonical error with [proj] suffix", () => {
  const line = `/repo/src/L/Thing.cs(12,34): error CS1002: ; expected [/repo/src/L/L.csproj]`;
  const d = parseMsbuildOutput(line);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0], {
    file: "/repo/src/L/Thing.cs",
    startLine: 11,
    startCol: 33,
    endLine: undefined,
    endCol: undefined,
    severity: "error",
    code: "CS1002",
    message: "; expected",
    project: "/repo/src/L/L.csproj",
  });
});

test("parseMsbuildOutput: 4-tuple span carries end positions", () => {
  const d = parseMsbuildOutput(`/repo/A.cs(3,5,3,20): error CS0103: name does not exist`);
  assert.equal(d.length, 1);
  assert.equal(d[0].startLine, 2);
  assert.equal(d[0].startCol, 4);
  assert.equal(d[0].endLine, 2);
  assert.equal(d[0].endCol, 19);
});

test("parseMsbuildOutput: warning severity", () => {
  const d = parseMsbuildOutput(`/repo/A.cs(1,1): warning CS0168: variable declared but never used`);
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, "warning");
  assert.equal(d[0].code, "CS0168");
});

test("parseMsbuildOutput: project-level diagnostics without a span (NU/MSB)", () => {
  const text = [
    `/repo/src/L/L.csproj : error NU1105: Unable to find project information`,
    `MSBUILD : error MSB3073: The command "false" exited with code 1. [/repo/src/L/L.csproj]`,
  ].join("\n");
  const d = parseMsbuildOutput(text);
  assert.equal(d.length, 2);
  assert.equal(d[0].code, "NU1105");
  assert.equal(d[0].file, "/repo/src/L/L.csproj");
  assert.equal(d[0].startLine, 0);
  assert.equal(d[0].startCol, 0);
  assert.equal(d[1].code, "MSB3073");
  assert.equal(d[1].project, "/repo/src/L/L.csproj");
});

test("parseMsbuildOutput: summary-block repeats dedupe to one diagnostic", () => {
  const line = `/repo/A.cs(2,3): error CS1002: ; expected [/repo/A.csproj]`;
  const text = ["Build FAILED.", line, "", "    " + line, "    1 Error(s)"].join("\n");
  const d = parseMsbuildOutput(text);
  assert.equal(d.length, 1);
});

test("parseMsbuildOutput: multi-TFM repeats per framework dedupe too", () => {
  const text = [
    `/repo/A.cs(2,3): error CS1002: ; expected [/repo/A.csproj::TargetFramework=net8.0]`,
    `/repo/A.cs(2,3): error CS1002: ; expected [/repo/A.csproj::TargetFramework=net9.0]`,
  ].join("\n");
  assert.equal(parseMsbuildOutput(text).length, 1);
});

test("parseMsbuildOutput: CRLF line endings", () => {
  const text = `/repo/A.cs(1,2): error CS0246: type not found\r\n/repo/B.cs(3,4): error CS0246: type not found\r\n`;
  const d = parseMsbuildOutput(text);
  assert.equal(d.length, 2);
  assert.equal(d[0].file, "/repo/A.cs");
  assert.equal(d[1].file, "/repo/B.cs");
});

test("parseMsbuildOutput: Windows path with spaces and parens binds the LAST paren group", () => {
  const d = parseMsbuildOutput(
    `C:\\Program Files (x86)\\My App\\Thing.cs(7,9): error CS1002: ; expected`
  );
  assert.equal(d.length, 1);
  assert.equal(d[0].file, `C:\\Program Files (x86)\\My App\\Thing.cs`);
  assert.equal(d[0].startLine, 6);
  assert.equal(d[0].startCol, 8);
});

test("parseMsbuildOutput: relative paths resolve against cwd", () => {
  const d = parseMsbuildOutput(`src/Thing.cs(1,1): error CS1002: ; expected`, "/shadow");
  assert.equal(d[0].file, path.resolve("/shadow", "src/Thing.cs"));
});

test("parseMsbuildOutput: unrelated output lines parse to nothing", () => {
  const text = [
    "  Determining projects to restore...",
    "  L -> /shadow/src/L/bin/Debug/net8.0/L.dll",
    "Time Elapsed 00:00:01.23",
  ].join("\n");
  assert.equal(parseMsbuildOutput(text).length, 0);
});

test("mapShadowToRepo: shadow paths rejoin onto the repo root", () => {
  assert.equal(
    mapShadowToRepo("/cache/shadow/src/L/Thing.cs", "/cache/shadow", "/repo"),
    path.join("/repo", "src/L/Thing.cs")
  );
});

test("mapShadowToRepo: case-insensitive prefix and mixed separators (Windows)", () => {
  assert.equal(
    mapShadowToRepo("c:\\Cache\\Shadow\\src\\Thing.cs", "C:\\cache\\shadow", "D:\\repo"),
    path.join("D:\\repo", "src/Thing.cs")
  );
});

test("mapShadowToRepo: non-shadow paths pass through unchanged", () => {
  assert.equal(mapShadowToRepo("/elsewhere/Thing.cs", "/cache/shadow", "/repo"), "/elsewhere/Thing.cs");
  // A sibling dir sharing the prefix string must not map either.
  assert.equal(
    mapShadowToRepo("/cache/shadow2/Thing.cs", "/cache/shadow", "/repo"),
    "/cache/shadow2/Thing.cs"
  );
});
