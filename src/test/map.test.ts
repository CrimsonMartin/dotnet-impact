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

test("affectedClasses: every unmapped file lands in unknownFiles (not just .cs)", () => {
  const map = freshMap();
  map.update("Ns.ATests", "tests/T.csproj", ["src/a.cs"]);
  const unknown: string[] = [];
  map.affectedClasses(["src/a.cs", "src/new.cs", "proj/App.csproj", "appsettings.json"], unknown);
  assert.deepEqual(unknown, ["src/new.cs", "proj/App.csproj", "appsettings.json"]);
});
