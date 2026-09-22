import * as assert from "node:assert/strict";
import { test } from "node:test";
import { classifyHookReply, HostPushTally, hostPatched, tallyReply } from "../core/hotpatch";

/**
 * Delta-push protocol: per-host replies and the push-loop decision logic.
 *
 * The old protocol had one failure byte: a host that never LOADED the
 * delta's assembly answered 0 — indistinguishable from a real apply
 * failure. In a repo with several test projects (EDITools shape: 6 warm
 * testhosts, one per test project) every delta targeted at one project's
 * assembly was "rejected" by every other host → "testhost rejected delta
 * for all changes" → the fast path was dead for every edit outside the
 * bottom-most shared libs. The new protocol adds status byte 2
 * ("assembly not loaded") which the push loop must treat as a SKIP for
 * that host — its tests cannot be affected by an assembly it never ran.
 */

function fresh(host: string): HostPushTally {
  return { host, applied: 0, skipped: 0, rejected: false };
}

test("classifyHookReply: 1 = applied, 2 = not-loaded, 0 = rejected", () => {
  assert.equal(classifyHookReply(1), "applied");
  assert.equal(classifyHookReply(2), "not-loaded");
  assert.equal(classifyHookReply(0), "rejected");
});

test("classifyHookReply: garbage bytes fail safe to rejected (build path)", () => {
  assert.equal(classifyHookReply(3), "rejected");
  assert.equal(classifyHookReply(-1), "rejected");
  assert.equal(classifyHookReply(255), "rejected");
});

test("THE BUG: a host that never loaded the assembly is a SKIP, not a rejection", () => {
  // Two warm hosts: A runs tests that reference the edited assembly, B does
  // not. The delta targets only A's assembly. A applies it; B answers
  // "not loaded". The old code read B's answer as a rejection and aborted
  // the whole save to the build path.
  const a = fresh("hostA");
  const b = fresh("hostB");
  tallyReply(a, classifyHookReply(1)); // A: applied
  tallyReply(b, classifyHookReply(2)); // B: assembly never loaded
  assert.equal(b.rejected, false, "not-loaded must NOT read as rejected (old code: 'testhost rejected delta')");
  assert.equal(hostPatched(a), true, "A accepted the delta → patched");
  assert.equal(hostPatched(b), false, "B applied nothing → must not count as patched");
});

test("a genuine apply failure is still fatal for the save", () => {
  const a = fresh("hostA");
  tallyReply(a, classifyHookReply(1));
  tallyReply(a, classifyHookReply(0)); // second delta failed to apply
  assert.equal(a.rejected, true);
});

test("a host that only skipped deltas does not satisfy the no-acceptance guard", () => {
  // Every host answered not-loaded: nobody will run the new code, and a
  // fresh testhost would load the stale on-disk assembly → the push loop
  // must report zero patched hosts → build path.
  const b = fresh("hostB");
  tallyReply(b, classifyHookReply(2));
  tallyReply(b, classifyHookReply(2));
  assert.equal(b.rejected, false);
  assert.equal(hostPatched(b), false);
  assert.equal(b.skipped, 2);
});

test("mixed fleet: applied + not-loaded + (no rejections) → success with patched count", () => {
  const a = fresh("hostA");
  const b = fresh("hostB");
  const c = fresh("hostC");
  tallyReply(a, classifyHookReply(1));
  tallyReply(b, classifyHookReply(2));
  tallyReply(c, classifyHookReply(1));
  assert.equal(
    [a, b, c].filter((t) => hostPatched(t)).length,
    2,
    "exactly the applying hosts count as patched (their hostGen advances)"
  );
});
