import * as assert from "node:assert/strict";
import { test } from "node:test";
import { LiveTesting, LiveTestingHost, LiveTestingTimers } from "../core/liveTesting";

/**
 * The Impact eye: on → saves run (debounced); paused → the in-flight run is
 * cancelled and changes wait; resume → what changed meanwhile runs at once.
 */

function harness(inFlight: { files: string[] | undefined } | null = null) {
  const runs: Array<string[] | undefined> = [];
  const changes: boolean[] = [];
  let aborts = 0;
  const host: LiveTestingHost = {
    run: (files) => runs.push(files),
    abortInFlight: () => {
      const r = inFlight;
      inFlight = null;
      if (r) aborts++;
      return r;
    },
    onChange: (on) => changes.push(on),
    debounceMs: () => 300,
  };
  // Manual timers: `fire()` runs whatever is scheduled.
  let scheduled: (() => void) | undefined;
  const timers: LiveTestingTimers = {
    set: (fn) => {
      scheduled = fn;
      return fn;
    },
    clear: (h) => {
      if (h && h === scheduled) scheduled = undefined;
    },
  };
  const live = new LiveTesting(host, timers);
  const fire = () => {
    const fn = scheduled;
    scheduled = undefined;
    fn?.();
  };
  return { live, runs, changes, fire, aborts: () => aborts, scheduled: () => scheduled !== undefined };
}

test("starts on: a save runs its file after the debounce; rapid saves coalesce", () => {
  const h = harness();
  assert.equal(h.live.on, true);
  h.live.noteSave("a.cs");
  h.live.noteSave("b.cs");
  h.live.noteSave("a.cs");
  assert.deepEqual(h.runs, [], "nothing until the debounce fires");
  h.fire();
  assert.deepEqual(h.runs, [["a.cs", "b.cs"]]);
  h.fire();
  assert.equal(h.runs.length, 1, "no phantom run once pending is drained");
});

test("external changes run immediately while on", () => {
  const h = harness();
  h.live.noteChanged(["x.cs", "y.cs"]);
  assert.deepEqual(h.runs, [["x.cs", "y.cs"]]);
});

test("pause cancels the in-flight run and stops the pending debounce", () => {
  const h = harness({ files: ["flying.cs"] });
  h.live.noteSave("queued.cs");
  h.live.pause();
  assert.equal(h.live.on, false);
  assert.equal(h.aborts(), 1, "in-flight run cancelled at once");
  assert.equal(h.scheduled(), false, "debounce cleared");
  assert.deepEqual(h.changes, [false]);
  h.fire();
  assert.deepEqual(h.runs, [], "nothing runs while paused");
});

test("saves and external changes while paused accumulate; resume runs them once", () => {
  const h = harness({ files: ["flying.cs"] });
  h.live.pause();
  h.live.noteSave("a.cs");
  h.live.noteChanged(["b.cs"]);
  h.live.noteSave("a.cs");
  assert.deepEqual(h.runs, []);
  assert.equal(h.scheduled(), false, "no debounce armed while paused");
  h.live.resume();
  assert.equal(h.live.on, true);
  assert.deepEqual(h.changes, [false, true]);
  assert.deepEqual(h.runs, [["flying.cs", "a.cs", "b.cs"]], "cancelled run's files + pause-time changes, once");
});

test("resume with nothing pending runs nothing", () => {
  const h = harness();
  h.live.pause();
  h.live.resume();
  assert.deepEqual(h.runs, []);
});

test("a cancelled full-suite run is resumed as a full-suite run", () => {
  const h = harness({ files: undefined });
  h.live.pause();
  h.live.noteSave("a.cs");
  h.live.resume();
  assert.deepEqual(h.runs, [undefined], "full suite subsumes the individual files");
});

test("pause/resume are idempotent; toggle flips", () => {
  const h = harness();
  h.live.pause();
  h.live.pause();
  h.live.resume();
  h.live.resume();
  assert.deepEqual(h.changes, [false, true]);
  h.live.toggle();
  assert.equal(h.live.on, false);
  h.live.toggle();
  assert.equal(h.live.on, true);
  assert.deepEqual(h.changes, [false, true, false, true]);
});

test("dispose drops a pending debounce", () => {
  const h = harness();
  h.live.noteSave("a.cs");
  h.live.dispose();
  assert.equal(h.scheduled(), false);
});
