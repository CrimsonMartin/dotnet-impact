import * as fs from "fs";
import * as path from "path";
import { ProjectGraph, ProjectInfo, testProjects } from "./projects";
import { cacheDirFor, exec, toRepoRelative } from "./util";

export interface StaticMapResult {
  /** test class FQN -> { csproj (repo-relative), files (repo-relative) } */
  classes: Record<string, { csproj: string; files: string[] }>;
  skipped: Array<{ assembly: string; reason: string }>;
}

/** Newest built dll for a project inside `rootDir` (skips ref/ metadata assemblies). */
export function findBuiltDll(rootDir: string, info: ProjectInfo, repoRoot: string): string | undefined {
  const rel = path.relative(repoRoot, info.dir);
  const binDir = path.join(rootDir, rel, "bin");
  let best: { p: string; mtime: number } | undefined;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name.toLowerCase() !== "ref") walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase() === `${info.assemblyName.toLowerCase()}.dll`) {
        const mtime = fs.statSync(p).mtimeMs;
        if (!best || mtime > best.mtime) best = { p, mtime };
      }
    }
  };
  walk(binDir, 0);
  return best?.p;
}

/**
 * Build (once) and run the ImpactStaticMap helper: reads the built assemblies'
 * IL metadata + portable PDBs and returns each test class's transitive
 * type-reference closure as source files. Requires the shadow to be built.
 */
export class StaticMapper {
  constructor(
    private readonly repoRoot: string,
    /** Helper source dir shipped with the extension (helper-static/). */
    private readonly helperSrcDir: string,
    private readonly log: (msg: string) => void = () => undefined
  ) {}

  private async ensureHelper(): Promise<string | undefined> {
    const bin = path.join(cacheDirFor(this.repoRoot), "staticmap-bin");
    const dll = path.join(bin, "ImpactStaticMap.dll");
    const stamp = path.join(bin, ".source-stamp");
    const src =
      fs.readFileSync(path.join(this.helperSrcDir, "Program.cs"), "utf8") +
      fs.readFileSync(path.join(this.helperSrcDir, "ImpactStaticMap.csproj"), "utf8");
    const want = hash(src);
    try {
      if (fs.existsSync(dll) && fs.readFileSync(stamp, "utf8") === want) return dll;
    } catch {
      /* rebuild */
    }
    this.log("building static map helper (one-time)…");
    const res = await exec(
      "dotnet",
      ["build", path.join(this.helperSrcDir, "ImpactStaticMap.csproj"), "-c", "Release", "-o", bin, "--nologo", "-v", "quiet"],
      this.helperSrcDir,
      5 * 60 * 1000
    );
    if (res.code !== 0 || !fs.existsSync(dll)) {
      this.log(`static map helper build failed: ${(res.stderr || res.stdout).slice(0, 400)}`);
      return undefined;
    }
    fs.writeFileSync(stamp, want);
    return dll;
  }

  /**
   * Compute the static map over `shadowDir`'s built assemblies. Returns null
   * when the helper is unavailable or produces nothing usable — callers fall
   * back to the coverage path.
   */
  async compute(shadowDir: string, graph: ProjectGraph): Promise<StaticMapResult | null> {
    const helper = await this.ensureHelper();
    if (!helper) return null;

    const testSet = new Set(testProjects(graph).map((p) => p.csproj.toLowerCase()));
    const assemblies: Array<{ csproj: string; dll: string; isTest: boolean }> = [];
    const missing: string[] = [];
    for (const p of graph.projects.values()) {
      const dll = findBuiltDll(shadowDir, p, this.repoRoot);
      if (dll) {
        assemblies.push({
          csproj: toRepoRelative(this.repoRoot, p.csproj),
          dll,
          isTest: testSet.has(p.csproj.toLowerCase()),
        });
      } else {
        missing.push(p.name);
      }
    }
    if (missing.length > 0) this.log(`static map: no built output for ${missing.join(", ")}`);
    if (assemblies.length === 0) return null;

    const inputFile = path.join(cacheDirFor(this.repoRoot), "staticmap-input.json");
    fs.mkdirSync(path.dirname(inputFile), { recursive: true });
    fs.writeFileSync(inputFile, JSON.stringify(assemblies));

    const res = await exec(
      "dotnet",
      [helper, "--repo-root", shadowDir, "--assemblies", inputFile],
      shadowDir,
      5 * 60 * 1000
    );
    if (res.code !== 0) {
      this.log(`static map helper failed: ${(res.stderr || res.stdout).slice(0, 400)}`);
      return null;
    }
    try {
      const parsed = JSON.parse(res.stdout) as StaticMapResult;
      for (const s of parsed.skipped ?? []) {
        this.log(`static map skipped ${path.basename(s.assembly)}: ${s.reason}`);
      }
      return parsed;
    } catch (e) {
      this.log(`static map output unparseable: ${String(e)}`);
      return null;
    }
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
