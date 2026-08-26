import * as assert from "node:assert/strict";
import { test } from "node:test";
import { classFilter, exec, parseStatusZ, resolveDotnet, setDotnetPath } from "../core/util";
import { classOf } from "../core/vstestSession";

test("classOf: plain, theory args, and NUnit parameterized fixtures", () => {
  assert.equal(classOf("Ns.CalcTests.Adds"), "Ns.CalcTests");
  assert.equal(classOf("Ns.CalcTests.Divides(x: 1.5)"), "Ns.CalcTests");
  assert.equal(classOf("Ns.Fixture(1).Method(2)"), "Ns.Fixture(1)");
  assert.equal(classOf("Ns.Outer+Inner.Method"), "Ns.Outer+Inner");
});

test("resolveDotnet: explicit override wins; otherwise a usable value", () => {
  setDotnetPath("/custom/dotnet");
  assert.equal(resolveDotnet(), "/custom/dotnet");
  setDotnetPath(undefined);
  // Without dotnet on PATH this must fall back to a real install or the bare name.
  const resolved = resolveDotnet();
  assert.ok(resolved === "dotnet" || resolved.endsWith("dotnet") || resolved.endsWith("dotnet.exe"));
});

test("exec: abort signal cancels the child promptly", async () => {
  const ctrl = new AbortController();
  const started = Date.now();
  const p = exec("sleep", ["30"], process.cwd(), 60000, ctrl.signal);
  setTimeout(() => ctrl.abort(), 150);
  const res = await p;
  assert.ok(Date.now() - started < 5000, "should not wait for the child");
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /cancelled/);
});

test("exec: missing executable yields an actionable error, not silence", async () => {
  const res = await exec("definitely-not-a-real-command-xyz", [], process.cwd());
  assert.equal(res.code, 1);
  assert.match(res.stderr, /was not found/);
});

test("parseStatusZ: modified, untracked, deleted", () => {
  const out = parseStatusZ(" M src/a.cs\0?? new file.cs\0 D gone.cs\0");
  assert.deepEqual(out, [
    { status: " M", file: "src/a.cs", origin: undefined },
    { status: "??", file: "new file.cs", origin: undefined },
    { status: " D", file: "gone.cs", origin: undefined },
  ]);
});

test("parseStatusZ: rename consumes the origin record", () => {
  const out = parseStatusZ("R  src/New.cs\0src/Old.cs\0 M other.cs\0");
  assert.deepEqual(out, [
    { status: "R ", file: "src/New.cs", origin: "src/Old.cs" },
    { status: " M", file: "other.cs", origin: undefined },
  ]);
});

test("parseStatusZ: worktree-side rename (XY = ' R')", () => {
  const out = parseStatusZ(" R b.cs\0a.cs\0");
  assert.deepEqual(out, [{ status: " R", file: "b.cs", origin: "a.cs" }]);
});

test("parseStatusZ: paths with spaces are not quoted in -z mode", () => {
  const out = parseStatusZ('?? My Folder/My "File".cs\0');
  assert.deepEqual(out, [{ status: "??", file: 'My Folder/My "File".cs', origin: undefined }]);
});

test("classFilter: trailing dot prevents substring over-match", () => {
  assert.equal(classFilter(["Ns.Foo"]), "FullyQualifiedName~Ns.Foo.");
  // "Ns.FooBar.Method" must NOT contain "Ns.Foo." — the over-match Foo vs FooBar.
  assert.ok(!"Ns.FooBar.Method".includes("Ns.Foo."));
  assert.ok("Ns.Foo.Method".includes("Ns.Foo."));
});

test("classFilter: joins classes with | and escapes operator chars", () => {
  assert.equal(
    classFilter(["A.B", "C.D"]),
    "FullyQualifiedName~A.B.|FullyQualifiedName~C.D."
  );
  assert.equal(classFilter(["Ns.We(ird)"]), "FullyQualifiedName~Ns.We\\(ird\\).");
});

test("classFilter: nested class FQNs pass through", () => {
  assert.equal(classFilter(["Ns.Outer+Inner"]), "FullyQualifiedName~Ns.Outer+Inner.");
  assert.ok("Ns.Outer+Inner.Method".includes("Ns.Outer+Inner."));
});
