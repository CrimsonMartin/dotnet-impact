import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HOST_CAPABILITIES, intersectCapabilities, parseHostRegistration } from "../core/hotpatch";

/**
 * #11 P2 plumbing, pure-logic half: how testhost registrations are parsed and
 * how per-host capability sets combine into the one set the delta service may
 * emit against. The engine-facing half (restricted caps actually refusing an
 * add-method edit) lives in multifile-and-caps.test.ts.
 */

test("parseHostRegistration: pipe-only (pre-handshake) and pipe+caps formats", () => {
  // Old hook: just the pipe name, possibly with a trailing newline.
  assert.deepEqual(parseHostRegistration("impact-abc123-4242"), { pipeName: "impact-abc123-4242" });
  assert.deepEqual(parseHostRegistration("impact-abc123-4242\n"), { pipeName: "impact-abc123-4242" });

  // New hook: line 2 is the space-separated runtime capability set.
  assert.deepEqual(parseHostRegistration("impact-abc-1\nBaseline AddMethodToExistingType"), {
    pipeName: "impact-abc-1",
    capabilities: ["Baseline", "AddMethodToExistingType"],
  });

  // Windows line endings and stray whitespace must not leak into names.
  assert.deepEqual(parseHostRegistration("impact-abc-1\r\nBaseline  NewTypeDefinition\r\n"), {
    pipeName: "impact-abc-1",
    capabilities: ["Baseline", "NewTypeDefinition"],
  });
});

test("intersectCapabilities: intersection across hosts; unknown hosts contribute the default set", () => {
  // No hosts: nothing to constrain — the delta service uses its own default.
  assert.equal(intersectCapabilities([]), null);

  // One reporting host: its set verbatim.
  assert.deepEqual(intersectCapabilities([["Baseline", "NewTypeDefinition"]]), [
    "Baseline",
    "NewTypeDefinition",
  ]);

  // Mixed fleet: only what EVERY host can apply survives.
  assert.deepEqual(
    intersectCapabilities([
      ["Baseline", "AddMethodToExistingType", "NewTypeDefinition"],
      ["Baseline", "NewTypeDefinition"],
    ]),
    ["Baseline", "NewTypeDefinition"]
  );

  // A pre-handshake host (undefined) behaves exactly as before the handshake:
  // it contributes the default set, so a fleet of only-unknowns changes nothing.
  assert.deepEqual(intersectCapabilities([undefined, undefined]), DEFAULT_HOST_CAPABILITIES);
  assert.deepEqual(
    intersectCapabilities([undefined, ["Baseline", "AddMethodToExistingType"]]),
    ["Baseline", "AddMethodToExistingType"]
  );
});
