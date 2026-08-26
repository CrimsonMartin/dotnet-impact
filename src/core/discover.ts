import { exec } from "./util";

/** A test's FQN must look like an identifier path (namespaces, nesting, generics). */
const FQN_RE = /^[A-Za-z_][A-Za-z0-9_.+`<>]*$/;
/** Chatter we must never mistake for a test in marker-less (MTP) output. */
const FILE_LIKE_RE = /\.(dll|exe|cs|csproj|trx|json|xml)$/i;

/** Strip theory arguments: Ns.Class.Method(x: 1, y: "a)b") -> Ns.Class.Method */
function stripArgs(name: string): string {
  return name.replace(/\(.*\)$/s, "");
}

function classOf(displayName: string): string | undefined {
  const noArgs = stripArgs(displayName);
  const lastDot = noArgs.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  const cls = noArgs.slice(0, lastDot);
  return FQN_RE.test(cls) ? cls : undefined;
}

/**
 * Extract test class FQNs from `dotnet test --list-tests` output.
 *
 * VSTest prints a "The following Tests are available:" marker followed by one
 * indented display name per line. Microsoft.Testing.Platform (xunit v3, MTP
 * runners) prints test IDs without that marker, mixed with build chatter — in
 * that mode only strict FQN-shaped lines with at least a namespace segment are
 * accepted, and file-like lines (Foo.dll) are rejected.
 */
export function parseListedTests(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const classes = new Set<string>();
  const markerAt = lines.findIndex((l) => /following tests are available/i.test(l));

  if (markerAt >= 0) {
    for (const raw of lines.slice(markerAt + 1)) {
      const line = raw.trim();
      if (!line) continue;
      const cls = classOf(line);
      if (cls) classes.add(cls);
    }
    return [...classes].sort();
  }

  // MTP-style output: no marker. Accept only unambiguous test lines.
  for (const raw of lines) {
    const line = stripArgs(raw.trim());
    if (!line || FILE_LIKE_RE.test(line)) continue;
    if (!FQN_RE.test(line)) continue;
    // Require Namespace.Class.Method (>= 2 dots) so chatter like
    // "Determining projects to restore" or "Tests.dll" never qualifies.
    if (line.split(".").length < 3) continue;
    const cls = classOf(line);
    if (cls) classes.add(cls);
  }
  return [...classes].sort();
}

/**
 * List test classes (fully qualified) in a test project via
 * `dotnet test --list-tests`.
 */
export async function discoverTestClasses(csproj: string, cwd: string): Promise<string[]> {
  const res = await exec(
    "dotnet",
    ["test", csproj, "--list-tests", "--nologo", "--verbosity", "quiet"],
    cwd
  );
  const classes = parseListedTests(res.stdout);
  if (res.code !== 0 && classes.length === 0) {
    throw new Error(`test discovery failed for ${csproj}: ${res.stderr || res.stdout}`);
  }
  return classes;
}
