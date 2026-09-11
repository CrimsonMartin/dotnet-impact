import * as assert from "node:assert/strict";
import { test } from "node:test";
import { classOf } from "../core/vstestSession";

/* ------------------------------------------------------------------ */
/*  classOf (vstestSession.ts) — standalone unit tests                */
/*  Extracts the CLASS FQN from a METHOD FQN by finding the LAST      */
/*  top-level dot and returning everything before it.                 */
/* ------------------------------------------------------------------ */

test("classOf: method FQN — class is everything before the last dot", () => {
  assert.equal(classOf("Ns.CalcTests.Adds"), "Ns.CalcTests");
});

test("classOf: multi-segment method FQN", () => {
  // Last dot is between FooTests and Method
  assert.equal(classOf("A.B.C.Tests.FooTests.Method"), "A.B.C.Tests.FooTests");
  assert.equal(classOf("Very.Deep.Namespace.Sub.FooTests.Method"), "Very.Deep.Namespace.Sub.FooTests");
});

test("classOf: bare class FQN (one dot) — namespace returned (treated as method part)", () => {
  assert.equal(classOf("Ns.CalcTests"), "Ns");
});

test("classOf: bare class name (no dot at all) — returns whole string", () => {
  assert.equal(classOf("NoClassHere"), "NoClassHere");
});

test("classOf: NUnit parameterized fixtures keep args on the class", () => {
  assert.equal(classOf("Ns.Fixture(1).Method"), "Ns.Fixture(1)");
  assert.equal(classOf("Ns.Fixture(a: 1, b: 2).Method"), "Ns.Fixture(a: 1, b: 2)");
});

test("classOf: nested classes with + are left intact", () => {
  assert.equal(classOf("Outer+Inner.Method"), "Outer+Inner");
  assert.equal(classOf("A.B+Inner+Nested.M"), "A.B+Inner+Nested");
});

test("classOf: dots inside parens must NOT split the FQN", () => {
  // "Ns.Fixture(key: \"a.b\").Method" — dots inside parens are skipped.
  // The last top-level dot is after the closing paren.
  const result = classOf("Ns.Fixture(key: \"a.b\").Method");
  assert.equal(result, "Ns.Fixture(key: \"a.b\")");
});

test("classOf: deeply nested parens with multiple dots", () => {
  // A(B(C).D).Method — class should be "A(B(C).D)"
  assert.equal(classOf("A(B(C).D).Method"), "A(B(C).D)");
});

test("classOf: empty string returns empty string", () => {
  assert.equal(classOf(""), "");
});
