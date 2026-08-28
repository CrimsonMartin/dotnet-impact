import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildProjectGraph, sourceStamp, testProjects } from "../core/projects";

/**
 * Regression: git worktrees living inside the repo (Claude Code keeps them at
 * .claude/worktrees/<name>/, each a full checkout with a `.git` file) and
 * nested clones (`.git` directory) are separate repositories. Scanning their
 * csproj copies produced one duplicate, forever-childless Test Explorer
 * project node per worktree — childless because the shadow worktree never
 * contains another repo's files, so discovery for the phantom project can't
 * build. The graph walk must not descend into a directory that has its own
 * `.git` entry.
 */

const TEST_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" />
    <ProjectReference Include="..\\..\\src\\Lib\\Lib.csproj" />
  </ItemGroup>
</Project>`;

/** Lib + Lib.Tests, as a copy of the repo layout rooted at `root`. */
function scaffoldTree(root: string): void {
  fs.mkdirSync(path.join(root, "src", "Lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "Lib.Tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "Lib", "Lib.csproj"), `<Project Sdk="Microsoft.NET.Sdk"></Project>`);
  fs.writeFileSync(path.join(root, "src", "Lib", "Calc.cs"), "class Calc {}");
  fs.writeFileSync(path.join(root, "tests", "Lib.Tests", "Lib.Tests.csproj"), TEST_CSPROJ);
  fs.writeFileSync(path.join(root, "tests", "Lib.Tests", "CalcTests.cs"), "class CalcTests {}");
}

test("project graph ignores in-repo worktrees and nested clones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "impact-nested-repo-test-"));
  scaffoldTree(root);

  // A Claude Code worktree: full checkout marked by a `.git` FILE.
  const wt = path.join(root, ".claude", "worktrees", "fix-things");
  scaffoldTree(wt);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "fix-things")}\n`);

  // A nested clone: marked by a `.git` DIRECTORY.
  const clone = path.join(root, "vendor", "other-repo");
  scaffoldTree(clone);
  fs.mkdirSync(path.join(clone, ".git"), { recursive: true });

  const graph = buildProjectGraph(root);
  assert.deepEqual(
    testProjects(graph).map((p) => p.csproj).sort(),
    [path.join(root, "tests", "Lib.Tests", "Lib.Tests.csproj")],
    "exactly one Lib.Tests — no phantom projects from the worktree or the nested clone"
  );
  assert.equal(graph.projects.size, 2, "Lib + Lib.Tests only");
});

test("sourceStamp ignores files inside a nested repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "impact-nested-stamp-test-"));
  fs.writeFileSync(path.join(dir, "A.cs"), "class A {}");
  const nested = path.join(dir, "embedded");
  fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
  fs.writeFileSync(path.join(nested, "B.cs"), "class B {}");

  const s1 = sourceStamp(dir);
  assert.ok(s1.startsWith("1:"), `nested repo's B.cs must not count (got ${s1})`);
  fs.utimesSync(path.join(nested, "B.cs"), new Date(), new Date(Date.now() + 60_000));
  assert.equal(sourceStamp(dir), s1, "touching a nested repo's file must not change the stamp");
});
