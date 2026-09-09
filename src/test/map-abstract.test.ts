import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ImpactMap } from "../core/map";
import { cacheDirFor } from "../core/util";

/**
 * #31 step 1 — the schema side, as pure unit tests (no dotnet, no build):
 * MapEntry.abstractFiles is a static fact that survives the coverage
 * replacement, and rows written before the field existed keep working.
 */
function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "impact-map-abstract-"));
}

test("updateStatic stores abstractFiles on the row", () => {
  const root = freshRoot();
  try {
    const map = new ImpactMap(root);
    map.updateStatic("Ns.T", "tests/T.csproj", ["src/A.cs"], false, ["src/IService.cs", "src/IRepo.cs"]);
    const e = map.entry("Ns.T")!;
    assert.equal(e.source, "static");
    assert.deepEqual(e.abstractFiles, ["src/IService.cs", "src/IRepo.cs"]);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coverage update preserves abstractFiles from the static row it replaces", () => {
  const root = freshRoot();
  try {
    const map = new ImpactMap(root);
    map.updateStatic("Ns.T", "tests/T.csproj", ["src/A.cs"], false, ["src/IService.cs"]);
    map.update("Ns.T", "tests/T.csproj", ["src/A.cs", "src/ServiceImpl.cs"]);
    const e = map.entry("Ns.T")!;
    assert.equal(e.source, "coverage");
    assert.deepEqual(e.files, ["src/A.cs", "src/ServiceImpl.cs"]);
    assert.deepEqual(e.abstractFiles, ["src/IService.cs"], "mining needs the abstractions of coverage rows");
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rows without abstractFiles (new or old schema) read as empty, not broken", () => {
  const root = freshRoot();
  try {
    const map = new ImpactMap(root);
    // No prior row: coverage row simply has no abstractFiles.
    map.update("Ns.New", "tests/T.csproj", ["src/A.cs"]);
    assert.deepEqual(map.entry("Ns.New")!.abstractFiles ?? [], []);

    // Old schema: a map file written before the field existed.
    fs.mkdirSync(cacheDirFor(root), { recursive: true });
    fs.writeFileSync(
      path.join(cacheDirFor(root), "impact-map.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "Ns.Old": { csproj: "tests/T.csproj", files: ["src/B.cs"], source: "static", updatedAt: "2026-01-01T00:00:00Z" },
        },
      })
    );
    const reloaded = new ImpactMap(root);
    const e = reloaded.entry("Ns.Old")!;
    assert.equal(e.abstractFiles, undefined, "absent, not []");
    assert.deepEqual(e.abstractFiles ?? [], [], "consumers use ?? []");
    assert.deepEqual(reloaded.affectedClasses(["src/B.cs"]), ["Ns.Old"], "old rows still select");

    // A refresh over an old row adopts the field from the static result.
    assert.equal(reloaded.updateStatic("Ns.Old", "tests/T.csproj", ["src/B.cs"], true, ["src/I.cs"]), true);
    assert.deepEqual(reloaded.entry("Ns.Old")!.abstractFiles, ["src/I.cs"]);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("forced static refresh replaces a coverage row and its abstractFiles", () => {
  const root = freshRoot();
  try {
    const map = new ImpactMap(root);
    map.updateStatic("Ns.T", "tests/T.csproj", ["src/A.cs"], false, ["src/I1.cs"]);
    map.update("Ns.T", "tests/T.csproj", ["src/A.cs", "src/S.cs"]);
    // Non-forced static write must not clobber the coverage row.
    assert.equal(map.updateStatic("Ns.T", "tests/T.csproj", ["src/A2.cs"], false, ["src/I2.cs"]), false);
    assert.equal(map.entry("Ns.T")!.source, "coverage");
    // Forced (full map refresh) replaces it wholesale.
    assert.equal(map.updateStatic("Ns.T", "tests/T.csproj", ["src/A2.cs"], true, ["src/I2.cs"]), true);
    assert.equal(map.entry("Ns.T")!.source, "static");
    assert.deepEqual(map.entry("Ns.T")!.abstractFiles, ["src/I2.cs"]);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("abstractFiles survive save/load round-trips", () => {
  const root = freshRoot();
  try {
    const map = new ImpactMap(root);
    map.updateStatic("Ns.T", "tests/T.csproj", ["src/A.cs"], false, ["src/IService.cs"]);
    map.update("Ns.T", "tests/T.csproj", ["src/A.cs", "src/S.cs"]);
    map.save();
    const reloaded = new ImpactMap(root);
    assert.equal(reloaded.entry("Ns.T")!.source, "coverage");
    assert.deepEqual(reloaded.entry("Ns.T")!.abstractFiles, ["src/IService.cs"]);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
