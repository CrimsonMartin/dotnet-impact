#!/usr/bin/env node
/**
 * dotnet-impact CLI — same core as the VS Code extension, callable from
 * pre-commit hooks and AI coding agents.
 *
 *   dotnet-impact build-map [--refresh]     build/refresh the impact map (background-safe)
 *   dotnet-impact affected [--base <ref>] [--staged]   print affected test classes
 *   dotnet-impact run [--base <ref>] [--staged]        run affected tests; exit 1 on failure
 *   dotnet-impact status                    map coverage stats
 */
import * as os from "os";
import * as path from "path";
import { Runner } from "./core/runner";
import { git } from "./core/util";

async function findRepoRoot(cwd: string): Promise<string> {
  const res = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (res.code !== 0) throw new Error("not inside a git repository");
  return path.resolve(res.stdout.trim());
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const repoRoot = await findRepoRoot(process.cwd());
  const runner = new Runner(repoRoot);

  switch (cmd) {
    case "build-map": {
      await runner.prepare();
      const configured = Number(arg("--parallel") ?? 0);
      const parallel =
        configured > 0 ? configured : Math.max(1, Math.min(12, os.cpus().length - 2));
      const discovered = await runner.discoverAll({
        parallel,
        onPhase: (message) => process.stderr.write(`${message}\n`),
      });
      const res = await runner.buildMap({
        refresh: has("--refresh"),
        parallel,
        discovered,
        onPhase: (message) => process.stderr.write(`${message}\n`),
        onProgress: (done, total, current) =>
          process.stderr.write(`[${done + 1}/${total}] ${current}\n`),
      });
      console.log(`mapped ${res.mapped} test classes; ${res.failed.length} failures`);
      for (const f of res.failed) console.error(`  failed: ${f}`);
      return 0;
    }
    case "affected": {
      await runner.prepare();
      const changed = await runner.changedFiles(arg("--base"), has("--staged"));
      const affected = runner.computeAffected(changed);
      for (const c of affected.classes) console.log(c);
      for (const p of affected.fallbackProjects) console.log(`project:${p.name}`);
      return 0;
    }
    case "run": {
      await runner.prepare();
      const changed = await runner.changedFiles(arg("--base"), has("--staged"));
      if (changed.length === 0) {
        console.log("no changes detected; nothing to run");
        return 0;
      }
      const affected = runner.computeAffected(changed);
      if (affected.classes.length === 0 && affected.fallbackProjects.length === 0) {
        console.log("no tests affected by this change");
        return 0;
      }
      console.log(
        `running ${affected.classes.length} mapped test classes` +
          (affected.fallbackProjects.length
            ? ` + ${affected.fallbackProjects.length} full project(s) (unmapped files)`
            : "")
      );
      const result = await runner.runAffected(affected);
      const failed = result.outcomes.filter((o) => !o.passed && !o.skipped);
      const skipped = result.outcomes.filter((o) => o.skipped);
      for (const f of failed) console.error(`FAIL ${f.method}\n  ${f.message ?? ""}`);
      console.log(
        `${result.outcomes.length - failed.length - skipped.length}/${result.outcomes.length} passed` +
          (skipped.length ? `, ${skipped.length} skipped` : "") +
          (result.ok ? "" : " — FAILED")
      );
      if (!result.ok && result.outcomes.length === 0) console.error(result.output);
      return result.ok ? 0 : 1;
    }
    case "status": {
      console.log(`impact map: ${runner.map.classCount} test classes mapped`);
      return 0;
    }
    default:
      console.error(
        "usage: dotnet-impact <build-map|affected|run|status> [--base <ref>] [--staged] [--refresh]"
      );
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
