import * as fs from "fs";
import * as path from "path";

/**
 * Static DI registration parsing (#31 step 3): seed bindings from the
 * registration idiom itself, with zero test runs.
 *
 * Registrations are statically visible in SOURCE (even when the compiler
 * makes them invisible to IL — see the di-fixture toolchain note), so a
 * source pass over the solution finds them:
 *
 *   services.AddScoped<IService, ServiceImpl>()     (two-generic form)
 *   services.TryAddSingleton<IService, ServiceImpl>()
 *   container.RegisterType<IService, ServiceImpl>() (Autofac)
 *   services.AddScoped<IService>(new ServiceImpl())  (single-generic + new)
 *
 * Factory-lambda forms (`AddScoped<IService>(sp => new ServiceImpl(sp))`)
 * and convention-based registrations are out of scope for the parser —
 * those are exactly what Δ-mining (the other path) is for.
 *
 * Names are captured AS WRITTEN and resolved against the static map's type
 * index (helper output). Ambiguous or unresolvable names yield no binding —
 * a false seed costs over-selection, a missed seed costs nothing (mining
 * can still learn the edge later).
 */

const NAME = String.raw`[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:<[^<>]*>)?`;
const TWO_GENERIC = new RegExp(
  String.raw`\b(?:Try)?(?:AddScoped|AddSingleton|AddTransient|RegisterType)\s*<\s*(${NAME})\s*,\s*(${NAME})\s*>`,
  "g"
);
const SINGLE_GENERIC_NEW = new RegExp(
  String.raw`\b(?:AddScoped|AddSingleton|AddTransient)\s*<\s*(${NAME})\s*>\s*\(\s*new\s+(${NAME})\s*[\({]`,
  "g"
);

export interface RegistrationSeed {
  /** Service type name as written in source. */
  service: string;
  /** Implementation type name as written in source. */
  impl: string;
  /** Repo-relative file the call appears in. */
  file: string;
}

/** Extract registration pairs from source text. */
export function parseRegistrations(files: Iterable<{ rel: string; text: string }>): RegistrationSeed[] {
  const out: RegistrationSeed[] = [];
  const seen = new Set<string>();
  for (const { rel, text } of files) {
    for (const re of [TWO_GENERIC, SINGLE_GENERIC_NEW]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const service = m[1];
        const impl = m[2];
        if (service === impl) continue; // self-registration: no edge
        const key = rel + "\u0000" + service + "\u0000" + impl;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ service, impl, file: rel });
      }
    }
  }
  return out;
}

/**
 * Resolve a type name (as written) to its repo-relative files using the
 * static map's type index. Exact FQN first, then the non-generic name, then
 * a UNIQUE short-name match. Ambiguity or absence → null (no seed).
 */
export function resolveTypeName(name: string, types: Record<string, string[]>): string[] | null {
  if (types[name]) return types[name];
  const bare = name.split("<")[0];
  if (bare !== name && types[bare]) return types[bare];
  const short = bare.split(/[.+]/).pop() ?? "";
  if (!short) return null;
  const matches = Object.entries(types).filter(([fqn]) => fqn.split(/[.+]/).pop() === short);
  return matches.length === 1 ? matches[0][1] : null;
}

/**
 * Resolve seeds to binding edges (from = abstraction file, to = impl file).
 * Partial classes span several files: every combination is emitted; a file
 * binding to itself is dropped.
 */
export function resolveSeeds(
  seeds: RegistrationSeed[],
  types: Record<string, string[]>
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const serviceFiles = resolveTypeName(seed.service, types);
    const implFiles = resolveTypeName(seed.impl, types);
    if (!serviceFiles || !implFiles) continue;
    for (const from of serviceFiles)
      for (const to of implFiles) {
        if (from === to) continue;
        const key = from + "\u0000" + to;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from, to });
      }
  }
  return out;
}

const SKIP_DIRS = new Set(["bin", "obj", "node_modules", ".git", ".vs", ".impact", "packages"]);

/** All .cs files in the repo tree (repo-relative + text), junk dirs skipped. */
export function collectCsFiles(root: string): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(p);
      } else if (e.name.toLowerCase().endsWith(".cs")) {
        try {
          out.push({
            rel: path.relative(root, p).split(path.sep).join("/"),
            text: fs.readFileSync(p, "utf8"),
          });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(root);
  return out;
}
