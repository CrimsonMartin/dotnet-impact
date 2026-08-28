import * as assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRunner } from "../core/vstestSession";

/**
 * Windows dll-lock regression tests (shipped broken through v0.1.8).
 *
 * A warm testhost locks every assembly it loaded — its own test dll AND all
 * dependency dlls. Releasing only the involved test projects' sessions left
 * other warm testhosts holding shared dependencies (Data.Models.dll), so the
 * rebuild died with MSB3027 after ten 1s copy retries. releaseAll() must
 * sweep every session ever started, not a caller-chosen subset.
 */

type Sent = { id?: number; cmd: string; dll?: string };

/** SessionRunner with a stubbed wire: captures sends, acks releases at once. */
function stubbedRunner(): { r: SessionRunner; sent: Sent[] } {
  const r = new SessionRunner("/nonexistent-repo", "/nonexistent-helper");
  const sent: Sent[] = [];
  const anyR = r as unknown as {
    proc: unknown;
    ready: boolean;
    sessionDlls: Set<string>;
    pending: Map<number, { tests: unknown[]; resolve: (v: { ok: boolean }) => void }>;
    send: (msg: Sent) => void;
  };
  anyR.proc = {}; // truthy: release() refuses to talk to a dead helper
  anyR.ready = true;
  anyR.send = (msg) => {
    sent.push(msg);
    if (msg.id !== undefined) anyR.pending.get(msg.id)?.resolve({ ok: true });
  };
  return { r, sent };
}

const dlls = (r: SessionRunner): Set<string> =>
  (r as unknown as { sessionDlls: Set<string> }).sessionDlls;

test("releaseAll releases every tracked session dll, not a subset", async () => {
  const { r, sent } = stubbedRunner();
  dlls(r).add("/shadow/A.Tests/bin/A.Tests.dll");
  dlls(r).add("/shadow/B.Tests/bin/B.Tests.dll");
  dlls(r).add("/shadow/C.Tests/bin/C.Tests.dll");

  await r.releaseAll();

  assert.deepEqual(
    sent.filter((m) => m.cmd === "release").map((m) => m.dll).sort(),
    [
      "/shadow/A.Tests/bin/A.Tests.dll",
      "/shadow/B.Tests/bin/B.Tests.dll",
      "/shadow/C.Tests/bin/C.Tests.dll",
    ]
  );
  assert.equal(dlls(r).size, 0); // nothing left believed-warm after the sweep
});

test("release drops the dll from the sweep set; releaseAll is then a no-op for it", async () => {
  const { r, sent } = stubbedRunner();
  dlls(r).add("/shadow/A.Tests/bin/A.Tests.dll");
  dlls(r).add("/shadow/B.Tests/bin/B.Tests.dll");

  await r.release("/shadow/A.Tests/bin/A.Tests.dll");
  await r.releaseAll();

  const released = sent.filter((m) => m.cmd === "release").map((m) => m.dll);
  assert.deepEqual(released, [
    "/shadow/A.Tests/bin/A.Tests.dll", // the explicit release
    "/shadow/B.Tests/bin/B.Tests.dll", // the sweep: A not re-released
  ]);
});

test("releaseAll without a live helper is a safe no-op", async () => {
  const r = new SessionRunner("/nonexistent-repo", "/nonexistent-helper");
  dlls(r).add("/shadow/A.Tests/bin/A.Tests.dll");
  await r.releaseAll(); // no proc: must neither throw nor hang
});

test("release waits for an in-flight run before talking to the helper", async () => {
  // The helper reads commands serially: a release sent mid-run sits in the
  // stdin buffer while the caller's timeout expires, and a build proceeding
  // on that false ack hits the very dll lock release() exists to prevent.
  const { r, sent } = stubbedRunner();
  dlls(r).add("/shadow/A.Tests/bin/A.Tests.dll");

  let finishRun: () => void = () => undefined;
  (r as unknown as { chain: Promise<unknown> }).chain = new Promise<void>((res) => (finishRun = res));

  const releasing = r.release("/shadow/A.Tests/bin/A.Tests.dll");
  await new Promise((res) => setImmediate(res));
  assert.equal(sent.length, 0, "release must not be sent while a run is in flight");

  finishRun();
  await releasing;
  assert.deepEqual(
    sent.map((m) => m.cmd),
    ["release"]
  );
});
