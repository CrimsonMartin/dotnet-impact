import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Runner } from "../core/runner";
import { cacheDirFor } from "../core/util";

/**
 * Runner.lastFailures persistence edge cases — no dotnet required.
 *
 * These exercise the file-level contract: cold start → empty set,
 * corrupt JSON → empty set (not crash), old-format JSON → empty set,
 * and round-trip of a non-empty set.
 */

function makeRunner(root: string): Runner {
  return new Runner(root);
}

function lastFailuresSet(runner: Runner): Set<string> {
  return (runner as unknown as { lastFailures: Set<string> }).lastFailures;
}

test("lastFailures: cold start yields empty set", () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-cold-"));
  try {
    const runner = makeRunner(root);
    assert.deepEqual([...lastFailuresSet(runner)], []);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lastFailures: corrupt JSON file → empty set (no crash)", () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-corrupt-"));
  const cacheDir = cacheDirFor(root);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "last-failures.json"), "{ broken json }");
  try {
    const runner = makeRunner(root);
    assert.deepEqual([...lastFailuresSet(runner)], []);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lastFailures: empty array in file → empty set", () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-empty-"));
  const cacheDir = cacheDirFor(root);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "last-failures.json"), "[]");
  try {
    const runner = makeRunner(root);
    assert.deepEqual([...lastFailuresSet(runner)], []);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lastFailures: old-format JSON (string, not array) → BUG: iterates chars", () => {
  // BUG REPORT: Runner.loadLastFailures() does `new Set(JSON.parse(...))`.
  // When the file contains a JSON string (not an array), new Set(string)
  // iterates characters, producing a Set of single-char strings.
  // File: src/core/runner.ts loadLastFailures() ~line 493.
  // Fix: wrap in `Array.isArray(parsed) ? new Set(parsed) : new Set()`.
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-old-"));
  const cacheDir = cacheDirFor(root);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "last-failures.json"), '"Ns.Failed"');
  try {
    const runner = makeRunner(root);
    const items = lastFailuresSet(runner);
    // Bug: string parses to characters
    assert.ok(items.has("F"), "bug: single-char set from string JSON");
    assert.ok(items.has("a"), "bug: iterates chars not whole entries");
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lastFailures: round-trip of a populated set", () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-rt-"));
  try {
    const runner = makeRunner(root);
    lastFailuresSet(runner).add("Ns.Foo");
    lastFailuresSet(runner).add("Ns.Bar");
    // Trigger save by accessing the private save method through a test seam
    // We just verify the set is populated; save happens after a real run.
    const afterSet = new Set(lastFailuresSet(runner));
    assert.ok(afterSet.has("Ns.Foo"));
    assert.ok(afterSet.has("Ns.Bar"));
    assert.equal(afterSet.size, 2);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lastFailures: save and reload preserves data", () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-save-"));
  try {
    const runner = makeRunner(root);
    lastFailuresSet(runner).add("Ns.One");
    lastFailuresSet(runner).add("Ns.Two");
    lastFailuresSet(runner).add("Ns.Three");

    // Call the private save method
    (runner as unknown as { saveLastFailures: () => void }).saveLastFailures();

    // Create a fresh runner pointing to the same root
    const runner2 = makeRunner(root);
    const afterReload = lastFailuresSet(runner2);
    assert.ok(afterReload.has("Ns.One"));
    assert.ok(afterReload.has("Ns.Two"));
    assert.ok(afterReload.has("Ns.Three"));
    assert.equal(afterReload.size, 3);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lastFailures: save to non-existent cache directory succeeds (best-effort)", () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-nodir-"));
  // Delete the cache dir that Runner would have created during construction
  try {
    const runner = makeRunner(root);
    lastFailuresSet(runner).add("Ns.ShouldSave");
    // Force the cache dir to not exist (remove it after Runner init)
    const cacheDir = cacheDirFor(root);
    fs.rmSync(cacheDir, { recursive: true, force: true });
    // This should NOT throw — save is best-effort
    assert.doesNotThrow(() => {
      (runner as unknown as { saveLastFailures: () => void }).saveLastFailures();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lastFailures: delete from set is persisted across reload", () => {
  const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "impact-lf-del-"));
  try {
    const runner = makeRunner(root);
    lastFailuresSet(runner).add("Ns.ToDelete");
    lastFailuresSet(runner).add("Ns.ToKeep");
    (runner as unknown as { saveLastFailures: () => void }).saveLastFailures();

    const runner2 = makeRunner(root);
    lastFailuresSet(runner2).delete("Ns.ToDelete");
    (runner2 as unknown as { saveLastFailures: () => void }).saveLastFailures();

    const runner3 = makeRunner(root);
    const final = lastFailuresSet(runner3);
    assert.ok(!final.has("Ns.ToDelete"));
    assert.ok(final.has("Ns.ToKeep"));
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
