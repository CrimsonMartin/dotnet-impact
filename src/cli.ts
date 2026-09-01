#!/usr/bin/env node
/**
 * Impact CLI — same core as the VS Code extension, callable from
 * pre-commit hooks and AI coding agents.
 *
 *   impact build-map [--refresh] [--parallel <n>] [--if-missing]   build/refresh the impact map
 *   impact affected [file ...] [--base <ref>] [--staged] [--format lines|json]
 *   impact run [file ...] [--base <ref>] [--staged] [--ci]         run affected tests
 *   impact status
 *
 * Selection (CLI-only; the extension keeps its own save-driven path):
 *   file args     exactly those files — lint-staged / pre-commit pass staged
 *                 filenames as trailing arguments, agents pass what they edited
 *   --staged      the index only: the tight pre-commit mode
 *   --base <ref>  <ref>...HEAD plus the dirty tree
 *   (default)     auto-detected base...HEAD plus the dirty tree — pre-push,
 *                 CI, post-commit verification
 *
 * Exit codes are the contract (stdout may change): 0 = affected tests passed,
 * or nothing to do; 1 = test failure or internal error; 2 = usage. And
 * infrastructure never blocks a commit: no map yet, or the shadow lock held
 * by another impact process, warns on stderr and exits 0. (build-map is the
 * infrastructure step itself, so a held lock there exits 1 — nothing was
 * built and the caller must know.)
 *
 * --ci (run only) flips that last rule for pipelines, where a soft skip would
 * green-light an untested PR: a missing map or a held shadow lock exits 1
 * with the reason. Selection and test semantics are otherwise identical (the
 * CLI never wires warm sessions or hot patching — every run is the plain
 * build + dotnet test path already, which is exactly right on a throwaway
 * runner). See docs/ci.md for the pipeline recipe.
 */
import * as os from "os";
import * as path from "path";
import { cliChangedFiles } from "./core/changeset";
import { parseCliArgs, validateCommandArgs } from "./core/cliArgs";
import { acquireShadowLock } from "./core/lock";
import { Runner } from "./core/runner";
import { git } from "./core/util";

const USAGE =
  "usage: impact <build-map|affected|run|status> [file ...] " +
  "[--base <ref>] [--staged] [--refresh] [--parallel <n>] " +
  "[--if-missing] [--format lines|json] [--ci]";

async function findRepoRoot(cwd: string): Promise<string> {
  const res = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (res.code !== 0) throw new Error("not inside a git repository");
  return path.resolve(res.stdout.trim());
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const argErrors = [...parsed.errors, ...validateCommandArgs(parsed)];
  if (argErrors.length > 0) {
    for (const e of argErrors) console.error(e);
    console.error(USAGE);
    return 2;
  }
  const repoRoot = await findRepoRoot(process.cwd());
  const runner = new Runner(repoRoot);
  const base = parsed.flags.get("--base") as string | undefined;
  const staged = parsed.flags.has("--staged");

  // An explicit base the user typed must resolve; a typo'd ref in a pre-push
  // hook must not silently select nothing and green-light the push.
  if (base) {
    const ok = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (ok.code !== 0) {
      console.error(`--base ${base}: unknown revision`);
      return 2;
    }
  }

  /** File args or git-derived selection, as repo-relative-friendly paths. */
  const selectFiles = async (): Promise<string[]> =>
    parsed.files.length > 0
      ? // Hook frameworks differ: lint-staged passes absolute paths,
        // pre-commit repo-relative (cwd = repo root). Resolving against cwd
        // handles both plus paths typed from a subdirectory.
        parsed.files.map((f) => path.resolve(process.cwd(), f))
      : cliChangedFiles(repoRoot, { base, staged });

  switch (parsed.command) {
    case "build-map": {
      // The cached-CI no-op: a restored cache already holds the map, so the
      // pipeline step costs nothing. `--refresh` composes for a forced pass.
      if (parsed.flags.has("--if-missing") && !parsed.flags.has("--refresh") && runner.map.classCount > 0) {
        console.log(`impact map present (${runner.map.classCount} test classes); skipping build`);
        return 0;
      }
      const release = await acquireShadowLock(repoRoot);
      if (!release) {
        console.error("another impact process holds the shadow worktree; try again shortly");
        return 1;
      }
      try {
        await runner.prepare();
        const configured = Number(parsed.flags.get("--parallel") ?? 0);
        const parallel =
          configured > 0 ? configured : Math.max(1, Math.min(12, os.cpus().length - 2));
        const discovered = await runner.discoverAll({
          parallel,
          onPhase: (message) => process.stderr.write(`${message}\n`),
        });
        const res = await runner.buildMap({
          refresh: parsed.flags.has("--refresh"),
          discovered,
          onPhase: (message) => process.stderr.write(`${message}\n`),
          onProgress: (done, total, current) =>
            process.stderr.write(`[${done + 1}/${total}] ${current}\n`),
        });
        console.log(`mapped ${res.mapped} test classes; ${res.failed.length} failures`);
        for (const f of res.failed) console.error(`  failed: ${f}`);
        return 0;
      } finally {
        release();
      }
    }
    case "affected": {
      if (parsed.files.length > 0 && (base || staged)) {
        console.error("file arguments and --base/--staged are mutually exclusive");
        console.error(USAGE);
        return 2;
      }
      const json = parsed.flags.get("--format") === "json";
      if (runner.map.classCount === 0) {
        console.error("no impact map yet — run `impact build-map` first; skipping");
        // JSON consumers still get a parseable answer; mapReady lets a
        // pipeline distinguish "cold map, fall back to the full suite" from
        // "nothing affected".
        if (json) console.log(JSON.stringify({ mapReady: false, classes: [], projects: [], changedFiles: [] }));
        return 0;
      }
      // Selection only: no shadow, no lock — cheap enough for any hook.
      const affected = runner.computeAffected(await selectFiles());
      if (json) {
        console.log(
          JSON.stringify({
            mapReady: true,
            classes: affected.classes,
            projects: affected.fallbackProjects.map((p) => p.name),
            changedFiles: affected.changedFiles,
          })
        );
        return 0;
      }
      for (const c of affected.classes) console.log(c);
      for (const p of affected.fallbackProjects) console.log(`project:${p.name}`);
      return 0;
    }
    case "run": {
      if (parsed.files.length > 0 && (base || staged)) {
        console.error("file arguments and --base/--staged are mutually exclusive");
        console.error(USAGE);
        return 2;
      }
      // Never block a commit on infrastructure: a cold start (shadow create +
      // solution build) belongs in `impact build-map`, not inside `git commit`.
      // In --ci mode the same conditions FAIL the job instead — a pipeline
      // that silently skips its tests green-lights untested code (#24).
      const ci = parsed.flags.has("--ci");
      if (runner.map.classCount === 0) {
        console.error(
          "no impact map yet — run `impact build-map` first;" + (ci ? " failing (--ci)" : " skipping")
        );
        return ci ? 1 : 0;
      }
      const release = await acquireShadowLock(repoRoot);
      if (!release) {
        console.error(
          "another impact process holds the shadow worktree — " + (ci ? "failing (--ci)" : "skipped")
        );
        return ci ? 1 : 0;
      }
      try {
        await runner.prepare();
        const changed = await selectFiles();
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
      } finally {
        release();
      }
    }
    case "status": {
      console.log(`impact map: ${runner.map.classCount} test classes mapped`);
      return 0;
    }
    default:
      console.error(USAGE);
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
