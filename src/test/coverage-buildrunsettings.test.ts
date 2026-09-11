import * as assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunsettings } from "../core/coverage";

/* ----------------------------------------------------------- */
/*  buildRunsettings — edge cases for assembly name handling  */
/* ----------------------------------------------------------- */

test("buildRunsettings: empty assembly list produces valid XML with no module filters", () => {
  const xml = buildRunsettings([]);
  assert.ok(xml.includes("<RunSettings>"));
  assert.ok(xml.includes("</RunSettings>"));
  // Should not contain any ModulePath entries
  assert.ok(!xml.includes("<ModulePath>"));
  // Coverlet include should be empty
  assert.ok(xml.includes("<Include></Include>"));
});

test("buildRunsettings: assembly names with special XML characters are escaped", () => {
  const xml = buildRunsettings(["My&Company", "Lib<Tests>"]);
  // MS collector: ModulePath should have escaped characters
  assert.ok(xml.includes("My&amp;Company\\."));
  assert.ok(xml.includes("Lib&lt;Tests&gt;\\."));
  // Coverlet include should also be escaped
  assert.ok(xml.includes("[My&amp;Company]*,[Lib&lt;Tests&gt;]*"));
});

test("buildRunsettings: assembly names with dots are escaped (regex metachar)", () => {
  const xml = buildRunsettings(["My.Lib", "Test.Lib.Tests"]);
  // Dots in assembly names must be escaped so they match literal dots, not any char
  assert.ok(xml.includes("My\\.Lib\\."));
  assert.ok(xml.includes("Test\\.Lib\\.Tests\\."));
});

test("buildRunsettings: single assembly name produces valid XML", () => {
  const xml = buildRunsettings(["Single"]);
  assert.ok(xml.includes("<ModulePath>.*[/\\\\]Single\\.(dll|exe)$</ModulePath>"));
  assert.ok(xml.includes("<Include>[Single]*</Include>"));
});

test("buildRunsettings: assembly names with hyphens pass through", () => {
  const xml = buildRunsettings(["My-Lib", "Test-Project"]);
  // Hyphens should appear in both filters
  assert.ok(xml.includes("<ModulePath>.*[/\\\\]My-Lib\\.(dll|exe)$</ModulePath>"));
  assert.ok(xml.includes("<Include>[My-Lib]*,[Test-Project]*</Include>"));
});
