import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { dotnetOrNull, runStaticHelperOnDiRepo, scaffoldDiRepo } from "./di-fixture";

/**
 * #31 step 1/2 prerequisite: the helper emits, per test class, the files of
 * DIRECTLY referenced abstractions. On the DI fixture the premise holds:
 * the static closure sees IService.cs (a TypeRef the tests really emit) but
 * NOT ServiceImpl.cs (the DI binding is a call-site generic instantiation,
 * invisible to token-level scanning) — and abstractFiles names the
 * abstraction the dynamic edge will be attributed to.
 */
test("static map: abstractFiles and types index on the DI fixture", { timeout: 600_000 }, () => {
  const dotnet = dotnetOrNull();
  if (!dotnet) return; // no SDK: nothing to test against
  const root = scaffoldDiRepo();
  return runStaticHelperOnDiRepo(dotnet, root)
    .then((result) => {
      const a = result.classes["Demo.Tests.ATests"];
      const b = result.classes["Demo.Tests.BTests"];
      assert.ok(a && b, `both test classes mapped (got ${Object.keys(result.classes).join(", ")})`);

      // The premise: the dynamic edge is invisible to the static closure —
      // the convention-based registration names the implementation in no IL
      // token (reflection discovery), so no toolchain can see it statically.
      assert.ok(a.files.includes("src/Lib/IService.cs"), "closure sees the abstraction");
      assert.ok(!a.files.includes("src/Lib/ServiceImpl.cs"), "closure does NOT see the impl");
      assert.ok(!b.files.includes("src/Lib/ServiceImpl.cs"), "closure does NOT see the impl (B)");
      assert.ok(a.files.includes("src/FakeDi/Container.cs"), "closure sees the container");
      assert.ok(a.files.includes("tests/T/App.cs"), "closure sees the composition root");

      // …and the direct abstractions are reported.
      assert.ok(a.abstractFiles.includes("src/Lib/IService.cs"), `abstractFiles (A): ${a.abstractFiles}`);
      assert.ok(b.abstractFiles.includes("src/Lib/IService.cs"), "abstractFiles (B)");
      assert.ok(
        !a.abstractFiles.includes("src/FakeDi/Container.cs"),
        "concrete container is not an abstraction"
      );

      // The type index resolves the names the registration parser will find.
      assert.deepEqual(result.types["Demo.IService"], ["src/Lib/IService.cs"]);
      assert.deepEqual(result.types["Demo.ServiceImpl"], ["src/Lib/ServiceImpl.cs"]);
      assert.deepEqual(result.types["Demo.FakeDi.Container"], ["src/FakeDi/Container.cs"]);
    })
    .finally(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
});
