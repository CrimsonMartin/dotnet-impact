import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LearnedBindings } from "../core/bindings";
import { cacheDirFor } from "../core/util";

/**
 * #31 step 3 — seedParsed, as pure unit tests (no dotnet, no build):
 * parsed-registration edges enter the store with source "parsed", never
 * override existing mined evidence, and match pairs case-insensitively.
 */
const A = "src/Lib/IService.cs";
const B = "src/Lib/ServiceImpl.cs";
const now = new Date("2026-09-08T12:00:00Z").toISOString();

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "impact-store-seed-"));
}

test("seedParsed adds parsed edges with confirms=1", () => {
  const root = freshRoot();
  try {
    const store = new LearnedBindings(root);
    const added = store.seedParsed(
      [
        { from: A, to: B },
        { from: A, to: "src/Lib/Other.cs" },
      ],
      now
    );
    assert.equal(added, 2);
    assert.equal(store.count, 2);
    const e = store.bindingsFor(A)[0];
    assert.equal(e.to, B);
    assert.equal(e.source, "parsed");
    assert.equal(e.confirms, 1);
    assert.equal(e.contradicts, 0);

    // Persists across store instances.
    const reloaded = new LearnedBindings(root);
    assert.equal(reloaded.bindingsFor(A).some((b) => b.to === B), true);
    assert.equal(reloaded.bindingsFor(A).some((b) => b.to === "src/Lib/Other.cs"), true);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedParsed skips pairs a binding already covers (mined evidence wins), case-insensitively", () => {
  const root = freshRoot();
  try {
    const store = new LearnedBindings(root);
    // A mined edge exists (lower-cased key, original-case target).
    store.observeMeasurement({
      classFqn: "Ns.T",
      abstractFiles: [A],
      measuredFiles: [B, A],
      staticFiles: [A],
      now,
    });
    assert.equal(store.count, 1);

    // Same pair, different case: not added; the mined edge is untouched.
    const added = store.seedParsed([{ from: A.toLowerCase(), to: B.toUpperCase() }], now);
    assert.equal(added, 0);
    assert.equal(store.count, 1);
    const e = store.bindingsFor(A)[0];
    assert.equal(e.source, "mined", "mined evidence is not overwritten by a seed");
    assert.equal(e.confirms, 1);

    // A different pair is still added.
    assert.equal(store.seedParsed([{ from: A, to: "src/Lib/Other.cs" }], now), 1);
    assert.equal(store.count, 2);
  } finally {
    fs.rmSync(cacheDirFor(root), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
