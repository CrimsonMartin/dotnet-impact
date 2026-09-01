import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "./util";

/** A test's FQN must look like an identifier path (namespaces, nesting, generics). */
const FQN_RE = /^[A-Za-z_][A-Za-z0-9_.+`<>]*$/;
/** Chatter we must never mistake for a test in marker-less (MTP) output. */
const FILE_LIKE_RE = /\.(dll|exe|cs|csproj|trx|json|xml)$/i;

/** Strip theory arguments: Ns.Class.Method(x: 1, y: "a)b") -> Ns.Class.Method */
function stripArgs(name: string): string {
  return name.replace(/\(.*\)$/s, "");
}

/** Containing class of a method FQN, or undefined if the name isn't FQN-shaped. */
export function classOf(displayName: string): string | undefined {
  const noArgs = stripArgs(displayName);
  const lastDot = noArgs.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  const cls = noArgs.slice(0, lastDot);
  return FQN_RE.test(cls) ? cls : undefined;
}

/**
 * Extract test method FQNs (theory args stripped, deduped) from
 * `dotnet test --list-tests` output.
 *
 * VSTest prints a "The following Tests are available:" marker followed by one
 * indented display name per line. Microsoft.Testing.Platform (xunit v3, MTP
 * runners) prints test IDs without that marker, mixed with build chatter — in
 * that mode only strict FQN-shaped lines with at least a namespace segment are
 * accepted, and file-like lines (Foo.dll) are rejected.
 */
export function parseListedTests(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const methods = new Set<string>();
  const markerAt = lines.findIndex((l) => /following tests are available/i.test(l));

  if (markerAt >= 0) {
    for (const raw of lines.slice(markerAt + 1)) {
      const line = stripArgs(raw.trim());
      if (!line) continue;
      if (FQN_RE.test(line) && classOf(line)) methods.add(line);
    }
    return [...methods].sort();
  }

  // MTP-style output: no marker. Accept only unambiguous test lines.
  for (const raw of lines) {
    const line = stripArgs(raw.trim());
    if (!line || FILE_LIKE_RE.test(line)) continue;
    if (!FQN_RE.test(line)) continue;
    // Require Namespace.Class.Method (>= 2 dots) so chatter like
    // "Determining projects to restore" or "Tests.dll" never qualifies.
    if (line.split(".").length < 3) continue;
    if (classOf(line)) methods.add(line);
  }
  return [...methods].sort();
}

/** Collapse a per-project methods record to the distinct classes it contains. */
export function classesRecord(
  discovered: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [rel, methods] of Object.entries(discovered)) {
    const classes = new Set<string>();
    for (const m of methods) {
      const cls = classOf(m);
      if (cls) classes.add(cls);
    }
    out[rel] = [...classes].sort();
  }
  return out;
}

/**
 * List test methods (fully qualified, theory args stripped) in a test project
 * via `dotnet test --list-tests`.
 */
export async function discoverTests(
  csproj: string,
  cwd: string,
  noBuild = false
): Promise<string[]> {
  const res = await exec(
    "dotnet",
    ["test", csproj, "--list-tests", ...(noBuild ? ["--no-build"] : []), "--nologo", "--verbosity", "quiet"],
    cwd
  );
  const methods = parseListedTests(res.stdout);
  if (res.code !== 0 && methods.length === 0) {
    throw new Error(`test discovery failed for ${csproj}: ${res.stderr || res.stdout}`);
  }
  // NUnit and MSTest adapters list bare display names ("Adds"), not FQNs —
  // parseListedTests rightly drops those, which used to leave their projects
  // with an EMPTY test tree. vstest's FQN listing recovers the real names.
  if (hasBareListedNames(res.stdout)) {
    const fqns = await listFqnsViaVstest(csproj, cwd);
    const merged = new Set([...methods, ...fqns]);
    return [...merged].sort();
  }
  return methods;
}

/**
 * True when the VSTest marker section contains entries that are display names
 * rather than FQNs (no containing class) — the NUnit/MSTest listing shape.
 */
export function hasBareListedNames(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/);
  const markerAt = lines.findIndex((l) => /following tests are available/i.test(l));
  if (markerAt < 0) return false;
  return lines
    .slice(markerAt + 1)
    .map((l) => stripArgs(l.trim()))
    .some((l) => l.length > 0 && !classOf(l));
}

/**
 * FQN listing straight from vstest: `dotnet vstest <dll>
 * --ListFullyQualifiedTests --ListTestsTargetPath:<file>` writes one FQN per
 * line regardless of the adapter's display-name convention. Requires the
 * built dll (the `dotnet test --list-tests` call just built it, or ran
 * --no-build against an existing build).
 */
async function listFqnsViaVstest(csproj: string, cwd: string): Promise<string[]> {
  const projDir = path.dirname(path.isAbsolute(csproj) ? csproj : path.join(cwd, csproj));
  const dll = newestBuiltDll(projDir, path.basename(csproj, ".csproj"));
  if (!dll) return [];
  const target = path.join(os.tmpdir(), `impact-fqns-${process.pid}-${Date.now()}.txt`);
  try {
    await exec(
      "dotnet",
      ["vstest", dll, "--ListFullyQualifiedTests", `--ListTestsTargetPath:${target}`],
      cwd
    );
    if (!fs.existsSync(target)) return [];
    const out = new Set<string>();
    for (const raw of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
      const line = stripArgs(raw.trim());
      if (line && FQN_RE.test(line) && classOf(line)) out.add(line);
    }
    return [...out].sort();
  } finally {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Newest <projDir>/bin/…/<assembly>.dll (ref/ dirs excluded). */
function newestBuiltDll(projDir: string, assemblyName: string): string | undefined {
  let best: { p: string; mtime: number } | undefined;
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name.toLowerCase() !== "ref") walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase() === `${assemblyName.toLowerCase()}.dll`) {
        let mtime: number;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          continue; // replaced between readdir and stat
        }
        if (!best || mtime > best.mtime) best = { p, mtime };
      }
    }
  };
  walk(path.join(projDir, "bin"), 0);
  return best?.p;
}
