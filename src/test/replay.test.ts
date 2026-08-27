import * as assert from "node:assert/strict";
import { test } from "node:test";
import { KnownResult, replayEvents } from "../core/replay";

function known(entries: Array<[string, Partial<KnownResult>]>): Map<string, KnownResult> {
  return new Map(
    entries.map(([fqn, r]) => [
      fqn,
      { classFqn: "Ns.C", passed: true, skipped: false, duration: 5, ...r },
    ])
  );
}

test("replayEvents: untouched tests replay at last known state", () => {
  const k = known([
    ["Ns.C.Passes", { passed: true }],
    ["Ns.C.Fails", { passed: false, message: "boom", duration: 9 }],
    ["Ns.C.Skips", { passed: false, skipped: true }],
  ]);
  const events = replayEvents(k, new Set());
  assert.deepEqual(
    events.map((e) => [e.methodFqn, e.state]),
    [
      ["Ns.C.Passes", "passed"],
      ["Ns.C.Fails", "failed"],
      ["Ns.C.Skips", "skipped"],
    ]
  );
  assert.equal(events[1].message, "boom");
  assert.equal(events[1].duration, 9);
});

test("replayEvents: tests with real results this run are never replayed", () => {
  const k = known([
    ["Ns.C.Ran", { passed: false }],
    ["Ns.C.Untouched", { passed: true }],
  ]);
  const events = replayEvents(k, new Set(["Ns.C.Ran"]));
  assert.deepEqual(
    events.map((e) => e.methodFqn),
    ["Ns.C.Untouched"]
  );
});

test("replayEvents: only terminal states — no queued/started markers (v0.1.2 yellow-icon regression)", () => {
  // Pre-enqueueing the untouched suite flipped every item to the yellow
  // queued icon for the whole run. The replay plan must consist solely of
  // finished states, so the running icons stay subset-only.
  const k = known([
    ["Ns.C.A", { passed: true }],
    ["Ns.C.B", { passed: false }],
    ["Ns.C.D", { skipped: true, passed: false }],
  ]);
  for (const e of replayEvents(k, new Set())) {
    assert.ok(["passed", "failed", "skipped"].includes(e.state));
  }
});

test("replayEvents: empty history replays nothing (first run after reload)", () => {
  assert.deepEqual(replayEvents(new Map(), new Set()), []);
});
