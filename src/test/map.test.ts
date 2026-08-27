import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ImpactMap } from "../core/map";

function freshMap(): ImpactMap {
  // Point the map at a repo path that has no cache on disk.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "impact-map-test-"));
  return new ImpactMap(fake);
}

test("affectedClasses: mapped file returns its classes", () => {
  const map = freshMap();
  map.update("Ns.ATests", "tests/T.csproj", ["src/a.cs", "src/shared.cs"]);
  map.update("Ns.BTests", "tests/T.csproj", ["src/b.cs", "src/shared.cs"]);
  assert.deepEqual(map.affectedClasses(["src/a.cs"]), ["Ns.ATests"]);
  assert.deepEqual(map.affectedClasses(["src/shared.cs"]), ["Ns.ATests", "Ns.BTests"]);
});

test("affectedClasses: lookup is case-insensitive and slash-normalized", () => {
  const map = freshMap();
  map.update("Ns.ATests", "tests/T.csproj", ["src/A.cs"]);
  assert.deepEqual(map.affectedClasses(["src/a.cs"]), ["Ns.ATests"]);
  assert.deepEqual(map.affectedClasses([`src${path.sep}A.cs`]), ["Ns.ATests"]);
});

test("updateStatic: fills gaps and refreshes static rows, never clobbers coverage", () => {
  const map = freshMap();
  assert.equal(map.updateStatic("Ns.A", "t/T.csproj", ["a.cs"]), true); // new row
  assert.equal(map.updateStatic("Ns.A", "t/T.csproj", ["a.cs", "b.cs"]), true); // static→static ok
  map.update("Ns.B", "t/T.csproj", ["b.cs"]); // coverage row
  assert.equal(map.updateStatic("Ns.B", "t/T.csproj", ["x.cs"]), false); // static loses
  assert.deepEqual(map.entry("Ns.B")!.files, ["b.cs"]);
  assert.equal(map.updateStatic("Ns.B", "t/T.csproj", ["x.cs"], true), true); // refresh forces
  assert.equal(map.entry("Ns.B")!.source, "static");
});

test("prune: removes dead classes and dead projects, keeps undiscovered ones", () => {
  const map = freshMap();
  map.update("Ns.Alive", "tests/A/A.csproj", ["src/a.cs"]);
  map.update("Ns.Dead", "tests/A/A.csproj", ["src/b.cs"]);
  map.update("Ns.InFailedProject", "tests/B/B.csproj", ["src/c.cs"]);
  map.update("Ns.InDeletedProject", "tests/Gone/Gone.csproj", ["src/d.cs"]);

  const removed = map.prune(
    new Map([["tests/A/A.csproj", new Set(["Ns.Alive"])]]), // A discovered; B failed discovery
    new Set(["tests/A/A.csproj", "tests/B/B.csproj"]) // Gone is no longer a test project
  );

  assert.deepEqual(removed.sort(), ["Ns.Dead", "Ns.InDeletedProject"]);
  assert.ok(map.has("Ns.Alive"));
  assert.ok(map.has("Ns.InFailedProject")); // no evidence it died
  assert.ok(!map.has("Ns.Dead"));
  assert.ok(!map.has("Ns.InDeletedProject"));
});

test("affectedClasses: every unmapped file lands in unknownFiles (not just .cs)", () => {
  const map = freshMap();
  map.update("Ns.ATests", "tests/T.csproj", ["src/a.cs"]);
  const unknown: string[] = [];
  map.affectedClasses(["src/a.cs", "src/new.cs", "proj/App.csproj", "appsettings.json"], unknown);
  assert.deepEqual(unknown, ["src/new.cs", "proj/App.csproj", "appsettings.json"]);
});
