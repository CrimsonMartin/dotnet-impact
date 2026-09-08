import * as assert from "node:assert/strict";
import { test } from "node:test";
import { collectCsFiles, parseRegistrations, resolveSeeds, resolveTypeName } from "../core/registrations";

const TYPES: Record<string, string[]> = {
  "Demo.IService": ["src/Lib/IService.cs"],
  "Demo.ServiceImpl": ["src/Lib/ServiceImpl.cs"],
  "Other.IService": ["src/Other/IService.cs"], // ambiguous short name
  "Demo.IRepo": ["src/Lib/IRepo.cs", "src/Lib/IRepo.Part.cs"], // partial
  "Demo.SqlRepo": ["src/Lib/SqlRepo.cs"],
};

test("parseRegistrations: two-generic and single-generic+new forms", () => {
  const text = `
    services.AddScoped<IService, ServiceImpl>();
    services.TryAddSingleton<MyNS.IFoo<Bar>, MyNS.FooImpl>();
    container.RegisterType<IFoo, FooImpl>();
    services.AddScoped<IService>(new ServiceImpl());
    services.AddSingleton<IService>(new ServiceImpl(42) { });
    services.AddScoped<IService, ServiceImpl >( );
  `;
  const seeds = parseRegistrations([{ rel: "a.cs", text }]);
  // Identical (file, service, impl) pairs dedupe to one seed.
  const pairs = seeds.map((s) => `${s.service}->${s.impl}`).sort();
  assert.deepEqual(pairs, [
    "IFoo->FooImpl",
    "IService->ServiceImpl",
    "MyNS.IFoo<Bar>->MyNS.FooImpl",
  ]);
  assert.ok(seeds.every((s) => s.file === "a.cs"));
});

test("parseRegistrations: self-registration and non-DI methods are ignored", () => {
  const text = `
    services.AddScoped<IService, IService>();
    list.AddRange<A, B>();
    var x = Builder.Create<Foo, Bar>();
  `;
  assert.deepEqual(parseRegistrations([{ rel: "a.cs", text }]), []);
});

test("parseRegistrations: multiline pretty-printed calls still match", () => {
  const text = `services
      .AddScoped<
          IService,
          ServiceImpl
      >();`;
  const seeds = parseRegistrations([{ rel: "a.cs", text }]);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].service, "IService");
  assert.equal(seeds[0].impl, "ServiceImpl");
});

test("resolveTypeName: exact FQN, then non-generic, then unique short name", () => {
  assert.deepEqual(resolveTypeName("Demo.IService", TYPES), ["src/Lib/IService.cs"]);
  assert.deepEqual(resolveTypeName("Demo.ServiceImpl", TYPES), ["src/Lib/ServiceImpl.cs"]);
  // Generic argument as written resolves via the non-generic name.
  assert.deepEqual(resolveTypeName("Demo.IService<int>", TYPES), ["src/Lib/IService.cs"]);
  // Unique short name.
  assert.deepEqual(resolveTypeName("IService", TYPES), null); // ambiguous: two IServices
  assert.deepEqual(resolveTypeName("SqlRepo", TYPES), ["src/Lib/SqlRepo.cs"]);
  // Unknown name.
  assert.deepEqual(resolveTypeName("Demo.Ghost", TYPES), null);
});

test("resolveSeeds: file pairs, partials expanded, self-file pairs dropped, unknown dropped", () => {
  const seeds = parseRegistrations([
    {
      rel: "src/Lib/Root.cs",
      text: `
        services.AddScoped<IRepo, SqlRepo>();
        services.AddSingleton<IService, Ghost>();
        services.AddTransient<Demo.IService, ServiceImpl>();
      `,
    },
  ]);
  const edges = resolveSeeds(seeds, TYPES).sort((a, b) => a.from + a.to < b.from + b.to ? -1 : 1);
  // IRepo (2 files, partial) × SqlRepo (1 file) + IService × ServiceImpl.
  const asJson = (xs: Array<{ from: string; to: string }>) =>
    xs.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(
    asJson(edges),
    asJson([
      { from: "src/Lib/IRepo.cs", to: "src/Lib/SqlRepo.cs" },
      { from: "src/Lib/IRepo.Part.cs", to: "src/Lib/SqlRepo.cs" },
      { from: "src/Lib/IService.cs", to: "src/Lib/ServiceImpl.cs" },
    ])
  );
});

test("collectCsFiles: walks the tree, skips junk dirs", () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  const root = mkdtempSync(join(tmpdir(), "impact-reg-walk-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src", "bin"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "A.cs"), "x");
    writeFileSync(join(root, "src", "bin", "Gen.cs"), "x");
    writeFileSync(join(root, "node_modules", "pkg", "P.cs"), "x");
    writeFileSync(join(root, "README.md"), "x");
    const files = collectCsFiles(root);
    assert.deepEqual(files.map((f) => f.rel), ["src/A.cs"]);
    assert.equal(files[0].text, "x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
