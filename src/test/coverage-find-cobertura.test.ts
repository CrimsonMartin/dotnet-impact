import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findCoberturaFiles } from "../core/coverage";

/* ----------------------------------------------------------- */
/*  findCoberturaFiles — unit tests                           */
/* ----------------------------------------------------------- */

test("findCoberturaFiles: finds cobertura files in nested directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-"));
  try {
    fs.mkdirSync(path.join(root, "deep", "nested", "path"), { recursive: true });
    fs.writeFileSync(path.join(root, "coverage.cobertura.xml"), "");
    fs.writeFileSync(path.join(root, "deep", "nested", "path", "report.cobertura.xml"), "");
    fs.writeFileSync(path.join(root, "deep", "nested", "path", "other.xml"), "");

    const files = findCoberturaFiles(root).sort();
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith("coverage.cobertura.xml")));
    assert.ok(files.some((f) => f.endsWith("report.cobertura.xml")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findCoberturaFiles: case-insensitive matching", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-case-"));
  try {
    fs.writeFileSync(path.join(root, "COVERAGE.COBERTURA.XML"), "");
    fs.writeFileSync(path.join(root, "Report.Cobertura.Xml"), "");
    fs.writeFileSync(path.join(root, "coverage.xml"), ""); // not a cobertura file
    fs.writeFileSync(path.join(root, "cobertura.json"), ""); // wrong extension

    const files = findCoberturaFiles(root);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.includes("COVERAGE.COBERTURA.XML")));
    assert.ok(files.some((f) => f.includes("Report.Cobertura.Xml")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findCoberturaFiles: empty directory returns empty array", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-empty-"));
  try {
    assert.deepEqual(findCoberturaFiles(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findCoberturaFiles: directory with only non-cobertura files returns empty array", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-no-cov-"));
  try {
    fs.writeFileSync(path.join(root, "result.xml"), "");
    fs.writeFileSync(path.join(root, "coverage.json"), "");
    fs.writeFileSync(path.join(root, "cobertura.cov"), ""); // wrong extension

    assert.deepEqual(findCoberturaFiles(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findCoberturaFiles: directory with .cs files returns empty array", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-cs-"));
  try {
    fs.writeFileSync(path.join(root, "Class.cs"), "");
    fs.writeFileSync(path.join(root, "Program.cs"), "");

    assert.deepEqual(findCoberturaFiles(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findCoberturaFiles: covers multiple formats — MS uses <name>.cobertura.xml, Coverlet uses coverage.cobertura.xml", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-multi-format-"));
  try {
    fs.mkdirSync(path.join(root, "vstest-results"), { recursive: true });
    fs.writeFileSync(path.join(root, "coverage.cobertura.xml"), "coverlet");
    fs.writeFileSync(path.join(root, "vstest-results", "vstest.cobertura.xml"), "vstest");

    const files = findCoberturaFiles(root);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.includes("coverage.cobertura.xml")));
    assert.ok(files.some((f) => f.includes("vstest.cobertura.xml")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findCoberturaFiles: handles unreadable directory gracefully", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-unreadable-"));
  try {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    // Create a directory with no read permissions (may fail on some systems)
    try {
      fs.chmodSync(path.join(root, "sub"), 0o000);
    } catch {
      // On Windows or as root, this may throw — that's fine
      assert.ok(true, "chmod failed as expected");
      return;
    }

    const files = findCoberturaFiles(root);
    // Should not throw; should either find files in root or skip unreadable sub
    assert.ok(Array.isArray(files));
    fs.chmodSync(path.join(root, "sub"), 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findCoberturaFiles: only returns .cobertura.xml files, not .cobertura.xml.bak", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-find-cov-backup-"));
  try {
    fs.writeFileSync(path.join(root, "coverage.cobertura.xml"), "primary");
    fs.writeFileSync(path.join(root, "coverage.cobertura.xml.bak"), "backup");

    const files = findCoberturaFiles(root);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".cobertura.xml"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
