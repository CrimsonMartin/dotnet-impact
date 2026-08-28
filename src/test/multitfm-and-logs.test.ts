import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findBuiltDlls } from "../core/staticmap";
import { SessionRunner } from "../core/vstestSession";
import type { ProjectInfo } from "../core/projects";

/** Issue #1 regressions: multi-TFM dll enumeration and testhost log capture. */

function scaffoldBin(structure: Record<string, number>): { root: string; info: ProjectInfo } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-tfm-test-"));
  const projDir = path.join(root, "tests", "T");
  for (const [rel, age] of Object.entries(structure)) {
    const abs = path.join(projDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
    const t = new Date(Date.now() - age * 1000);
    fs.utimesSync(abs, t, t);
  }
  const info = {
    csproj: path.join(projDir, "T.csproj"),
    dir: projDir,
    name: "T",
    assemblyName: "T",
    references: [],
  } as unknown as ProjectInfo;
  return { root, info };
}

test("findBuiltDlls returns one dll per TFM, newest per TFM, ref dirs excluded", () => {
  const { root, info } = scaffoldBin({
    "bin/Debug/net8.0/T.dll": 100,
    "bin/Debug/net48/T.dll": 50,
    "bin/Release/net8.0/T.dll": 10, // newer net8.0 build wins over Debug's
    "bin/Debug/net8.0/ref/T.dll": 0, // reference assembly: never a run target
    "bin/Debug/net8.0/Other.dll": 0,
  });
  try {
    const dlls = findBuiltDlls(root, info, root);
    assert.deepEqual(
      dlls.map((d) => path.relative(path.join(root, "tests", "T"), d)).sort(),
      ["bin/Debug/net48/T.dll", "bin/Release/net8.0/T.dll"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("single-TFM projects still yield exactly one dll", () => {
  const { root, info } = scaffoldBin({ "bin/Debug/net8.0/T.dll": 0 });
  try {
    assert.equal(findBuiltDlls(root, info, root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("helper log messages are collected per pending run", () => {
  const r = new SessionRunner("/nonexistent", "/nonexistent");
  const anyR = r as unknown as {
    pending: Map<number, { tests: unknown[]; logs: string[]; resolve: (v: unknown) => void }>;
    onData: (chunk: string) => void;
  };
  const logs: string[] = [];
  anyR.pending.set(7, { tests: [], logs, resolve: () => undefined });
  anyR.onData(
    '{"id":7,"type":"log","message":"[xUnit.net] starting"}\n' +
      '{"id":7,"type":"log","message":"Console.WriteLine from a test"}\n' +
      '{"id":9,"type":"log","message":"other run — must not leak in"}\n'
  );
  assert.deepEqual(logs, ["[xUnit.net] starting", "Console.WriteLine from a test"]);
});
