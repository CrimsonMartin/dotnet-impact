import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildRunsettings, parseCoberturaHitFiles } from "../core/coverage";

test("buildRunsettings: first-party module filters for both collectors", () => {
  const xml = buildRunsettings(["Lib", "Lib.Tests"]);
  // MS collector: regex module paths, dots escaped, separator-agnostic.
  assert.ok(xml.includes("<ModulePath>.*[/\\\\]Lib\\.(dll|exe)$</ModulePath>"));
  assert.ok(xml.includes("<ModulePath>.*[/\\\\]Lib\\.Tests\\.(dll|exe)$</ModulePath>"));
  // Coverlet fallback: assembly-name include filters.
  assert.ok(xml.includes("<Include>[Lib]*,[Lib.Tests]*</Include>"));
  assert.ok(xml.includes("<Format>cobertura</Format>"));
});

test("parseCoberturaHitFiles: only files with executed lines, shadow-relative", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-cov-test-"));
  fs.mkdirSync(path.join(shadow, "src"), { recursive: true });
  fs.writeFileSync(path.join(shadow, "src", "Hit.cs"), "");
  fs.writeFileSync(path.join(shadow, "src", "Cold.cs"), "");

  const xml = `<?xml version="1.0"?>
<coverage>
  <sources><source>${shadow}</source></sources>
  <packages><package><classes>
    <class filename="src/Hit.cs"><lines><line number="1" hits="3"/><line number="2" hits="0"/></lines></class>
    <class filename="src/Cold.cs"><lines><line number="1" hits="0"/></lines></class>
  </classes></package></packages>
</coverage>`;
  const p = path.join(shadow, "coverage.cobertura.xml");
  fs.writeFileSync(p, xml);

  assert.deepEqual(parseCoberturaHitFiles(p, shadow), ["src/Hit.cs"]);
});

test("parseCoberturaHitFiles: files outside the shadow keep absolute paths", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-cov-test-"));
  const outside = path.join(os.tmpdir(), "elsewhere", "Gen.cs");
  const xml = `<?xml version="1.0"?>
<coverage><sources></sources><packages><package><classes>
  <class filename="${outside}"><lines><line number="1" hits="1"/></lines></class>
</classes></package></packages></coverage>`;
  const p = path.join(shadow, "coverage.cobertura.xml");
  fs.writeFileSync(p, xml);

  const files = parseCoberturaHitFiles(p, shadow);
  assert.equal(files.length, 1);
  assert.ok(path.isAbsolute(files[0]));
});
