import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalChangeBatcher, isWatchableSource } from "../core/externalWatch";

/**
 * #10 pure-logic surface: the batching, gating, and de-dup decisions behind
 * external-change run triggers, driven with a manual clock and scheduler so
 * every timing rule is deterministic.
 */

/** Manual scheduler: timers fire only when advance() crosses their deadline. */
function harness(over: Partial<{ debounceMs: number; saveDedupMs: number; dirty: Set<string> }> = {}) {
  const dirty = over.dirty ?? new Set<string>();
  let clock = 100_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const batches: string[][] = [];
  const batcher = new ExternalChangeBatcher({
    debounceMs: () => over.debounceMs ?? 1000,
    saveDedupMs: () => over.saveDedupMs ?? 3000,
    isDirtyInEditor: (f) => dirty.has(f),
    onBatch: (files) => batches.push([...files].sort()),
    now: () => clock,
    schedule: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, fn });
      return () => timers.delete(id);
    },
  });
  const advance = (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    clock = target;
  };
  return { batcher, batches, advance, dirty };
}

test("a burst of changes flushes as ONE batch after the rolling window closes", () => {
  const { batcher, batches, advance } = harness();
  assert.equal(batcher.noteChange("/repo/src/A.cs"), "queued");
  advance(400);
  assert.equal(batcher.noteChange("/repo/src/B.cs"), "queued");
  advance(400);
  assert.equal(batcher.noteChange("/repo/src/C.cs"), "queued");
  assert.deepEqual(batches, [], "nothing flushes while the burst is still rolling");

  advance(999);
  assert.deepEqual(batches, [], "window measures from the LAST event");
  advance(1);
  assert.deepEqual(batches, [["/repo/src/A.cs", "/repo/src/B.cs", "/repo/src/C.cs"]]);

  // The next event starts a fresh batch.
  batcher.noteChange("/repo/src/D.cs");
  advance(1000);
  assert.deepEqual(batches[1], ["/repo/src/D.cs"]);
});

test("a save's own watcher echo is dropped inside the dedup window, accepted after it", () => {
  const { batcher, batches, advance } = harness();
  batcher.noteSave("/repo/src/A.cs");
  advance(500);
  assert.equal(batcher.noteChange("/repo/src/A.cs"), "recent-save", "the echo must not double-trigger");
  // A genuinely external change to the same file later runs normally.
  advance(3000);
  assert.equal(batcher.noteChange("/repo/src/A.cs"), "queued");
  advance(1000);
  assert.deepEqual(batches, [["/repo/src/A.cs"]]);
});

test("a file with a dirty editor open is the user's mid-edit — the disk event is ignored", () => {
  const { batcher, batches, advance, dirty } = harness();
  dirty.add("/repo/src/A.cs");
  assert.equal(batcher.noteChange("/repo/src/A.cs"), "dirty-editor");
  assert.equal(batcher.noteChange("/repo/src/B.cs"), "queued", "clean files still queue");
  advance(1000);
  assert.deepEqual(batches, [["/repo/src/B.cs"]]);
});

test("non-source and build-output paths never queue", () => {
  const { batcher } = harness();
  assert.equal(batcher.noteChange("/repo/README.md"), "not-source");
  assert.equal(batcher.noteChange("/repo/src/bin/Debug/gen.cs"), "not-source");
  assert.equal(batcher.noteChange("/repo/src/obj/Debug/x.AssemblyInfo.cs"), "not-source");
  assert.equal(batcher.noteChange("/repo/.git/sneaky.cs"), "not-source");
  assert.equal(batcher.noteChange("C:\\repo\\src\\OBJ\\gen.cs"), "not-source", "Windows separators + case");
  assert.equal(batcher.noteChange("/repo/src/View.razor"), "queued");
  assert.equal(batcher.noteChange("/repo/src/Page.cshtml"), "queued");
});

test("dispose cancels a pending flush; nothing fires afterwards", () => {
  const { batcher, batches, advance } = harness();
  batcher.noteChange("/repo/src/A.cs");
  batcher.dispose();
  advance(5000);
  assert.deepEqual(batches, []);
});

test("isWatchableSource: extension gate is case-insensitive, exclusion is by whole path segment", () => {
  assert.equal(isWatchableSource("/r/A.CS"), true);
  assert.equal(isWatchableSource("/r/binary/A.cs"), true, "'binary' is not the 'bin' segment");
  assert.equal(isWatchableSource("/r/objects/A.cs"), true, "'objects' is not the 'obj' segment");
  assert.equal(isWatchableSource("/r/bin/A.cs"), false);
  assert.equal(isWatchableSource("/r/node_modules/x/A.cs"), false);
  assert.equal(isWatchableSource("/r/A.csproj"), false);
});
