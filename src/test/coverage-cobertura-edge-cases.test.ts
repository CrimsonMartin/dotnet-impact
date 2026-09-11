import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseCoberturaHitFiles, parseCoberturaLineHits } from "../core/coverage";

/* ----------------------------------------------------------- */
/*  parseCoberturaHitFiles — edge cases beyond the happy path */
/* ----------------------------------------------------------- */

test("parseCoberturaHitFiles: empty coverage element returns []", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-empty-coverage-"));
  try {
    const xml = `<?xml version="1.0"?><coverage><packages></packages></coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    assert.deepEqual(parseCoberturaHitFiles(p, shadow), []);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaHitFiles: malformed XML (no coverage element) returns []", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-malformed-coverage-"));
  try {
    const xml = `<?xml version="1.0"?><broken>not coverage</broken>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    assert.deepEqual(parseCoberturaHitFiles(p, shadow), []);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaHitFiles: class with no lines element is skipped", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-no-lines-coverage-"));
  try {
    const xml = `<?xml version="1.0"?><coverage><packages><package><classes>
      <class filename="Empty.cs"></class>
    </classes></package></packages></coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    assert.deepEqual(parseCoberturaHitFiles(p, shadow), []);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaHitFiles: multiple packages — hits from all packages included", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-multi-pkg-coverage-"));
  try {
    fs.mkdirSync(path.join(shadow, "pkg1"), { recursive: true });
    fs.mkdirSync(path.join(shadow, "pkg2"), { recursive: true });
    fs.writeFileSync(path.join(shadow, "pkg1", "ClassA.cs"), "");
    fs.writeFileSync(path.join(shadow, "pkg2", "ClassB.cs"), "");

    const xml = `<?xml version="1.0"?><coverage>
      <sources><source>${shadow}</source></sources>
      <packages>
        <package><classes>
          <class filename="pkg1/ClassA.cs"><lines><line number="1" hits="1"/></lines></class>
        </classes></package>
        <package><classes>
          <class filename="pkg2/ClassB.cs"><lines><line number="1" hits="2"/></lines></class>
        </classes></package>
      </packages>
    </coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const files = parseCoberturaHitFiles(p, shadow).sort();
    assert.deepEqual(files, ["pkg1/ClassA.cs", "pkg2/ClassB.cs"]);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaHitFiles: class with filename but no @_filename attribute is skipped", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-no-filename-coverage-"));
  try {
    const xml = `<?xml version="1.0"?><coverage><packages><package><classes>
      <class><lines><line number="1" hits="1"/></lines></class>
    </classes></package></packages></coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    assert.deepEqual(parseCoberturaHitFiles(p, shadow), []);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- */
/*  parseCoberturaLineHits — edge cases                       */
/* ----------------------------------------------------------- */

test("parseCoberturaLineHits: malformed XML returns empty map", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-malformed-lines-coverage-"));
  try {
    const xml = `<?xml version="1.0"?><broken>not coverage</broken>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const hits = parseCoberturaLineHits(p, shadow);
    assert.equal(hits.size, 0);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaLineHits: empty packages returns empty map", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-empty-lines-coverage-"));
  try {
    const xml = `<?xml version="1.0"?><coverage><packages></packages></coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const hits = parseCoberturaLineHits(p, shadow);
    assert.equal(hits.size, 0);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaLineHits: class with no lines element creates empty inner map", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-no-lines-lines-coverage-"));
  try {
    fs.mkdirSync(path.join(shadow, "src"), { recursive: true });
    fs.writeFileSync(path.join(shadow, "src", "Empty.cs"), "");

    const xml = `<?xml version="1.0"?><coverage>
      <sources><source>${shadow}</source></sources>
      <packages><package><classes>
        <class filename="src/Empty.cs"></class>
      </classes></package></packages>
    </coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const hits = parseCoberturaLineHits(p, shadow);
    // Class creates an entry with an empty inner map (no lines to parse)
    assert.equal(hits.size, 1);
    const empty = hits.get("src/Empty.cs");
    assert.ok(empty);
    assert.equal(empty.size, 0, "inner map is empty when no lines element");
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaLineHits: non-numeric line numbers produce NaN keys (NaN <= 0 is false)", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-nolines-num-lines-coverage-"));
  try {
    fs.mkdirSync(path.join(shadow, "src"), { recursive: true });
    fs.writeFileSync(path.join(shadow, "src", "Calc.cs"), "");

    const xml = `<?xml version="1.0"?><coverage>
      <sources><source>${shadow}</source></sources>
      <packages><package><classes>
        <class filename="src/Calc.cs"><lines>
          <line number="abc" hits="1"/>
          <line number="xyz" hits="2"/>
        </lines></class>
      </classes></package></packages>
    </coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const hits = parseCoberturaLineHits(p, shadow);
    // Number("abc") = NaN; NaN <= 0 is false, so NaN keys slip through
    const calc = hits.get("src/Calc.cs");
    assert.ok(calc);
    // NaN is a valid Map key; both entries produce NaN keys, Math.max keeps the highest
    assert.equal(calc.size, 1, "NaN is deduplicated as a Map key");
    assert.equal(calc.get(NaN), 2); // Math.max(1, 2) = 2
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaLineHits: hit='0' lines are kept with value 0", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-zero-hits-coverage-"));
  try {
    fs.mkdirSync(path.join(shadow, "src"), { recursive: true });
    fs.writeFileSync(path.join(shadow, "src", "Cold.cs"), "");

    const xml = `<?xml version="1.0"?><coverage>
      <sources><source>${shadow}</source></sources>
      <packages><package><classes>
        <class filename="src/Cold.cs"><lines>
          <line number="1" hits="0"/>
          <line number="2" hits="0"/>
        </lines></class>
      </classes></package></packages>
    </coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const hits = parseCoberturaLineHits(p, shadow);
    const cold = hits.get("src/Cold.cs");
    assert.ok(cold);
    assert.equal(cold.get(1), 0);
    assert.equal(cold.get(2), 0);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaLineHits: missing @_hits attribute defaults to 0", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-nohits-attr-coverage-"));
  try {
    fs.mkdirSync(path.join(shadow, "src"), { recursive: true });
    fs.writeFileSync(path.join(shadow, "src", "Calc.cs"), "");

    const xml = `<?xml version="1.0"?><coverage>
      <sources><source>${shadow}</source></sources>
      <packages><package><classes>
        <class filename="src/Calc.cs"><lines>
          <line number="1"/><line number="2" hits="5"/>
        </lines></class>
      </classes></package></packages>
    </coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const hits = parseCoberturaLineHits(p, shadow);
    const calc = hits.get("src/Calc.cs");
    assert.ok(calc);
    assert.equal(calc.get(1), 0);
    assert.equal(calc.get(2), 5);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});

test("parseCoberturaLineHits: line number 0 is skipped (invalid)", () => {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "impact-zero-line-coverage-"));
  try {
    fs.mkdirSync(path.join(shadow, "src"), { recursive: true });
    fs.writeFileSync(path.join(shadow, "src", "Calc.cs"), "");

    const xml = `<?xml version="1.0"?><coverage>
      <sources><source>${shadow}</source></sources>
      <packages><package><classes>
        <class filename="src/Calc.cs"><lines>
          <line number="0" hits="10"/>
          <line number="1" hits="3"/>
        </lines></class>
      </classes></package></packages>
    </coverage>`;
    const p = path.join(shadow, "coverage.xml");
    fs.writeFileSync(p, xml);
    const hits = parseCoberturaLineHits(p, shadow);
    const calc = hits.get("src/Calc.cs");
    assert.ok(calc);
    assert.equal(calc.has(0), false);
    assert.equal(calc.get(1), 3);
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }
});
