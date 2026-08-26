import { exec } from "./util";

/**
 * List test classes (fully qualified) in a test project by parsing
 * `dotnet test --list-tests` output. Display names are grouped to class level:
 * "Ns.Sub.ClassName.Method(args)" -> "Ns.Sub.ClassName".
 */
export async function discoverTestClasses(csproj: string, cwd: string): Promise<string[]> {
  const res = await exec(
    "dotnet",
    ["test", csproj, "--list-tests", "--nologo", "--verbosity", "quiet"],
    cwd
  );
  const classes = new Set<string>();
  let inList = false;
  for (const raw of res.stdout.split(/\r?\n/)) {
    if (/following Tests are available/i.test(raw)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const line = raw.trim();
    if (!line) continue;
    // Strip theory arguments: Ns.Class.Method(x: 1, y: "a)b")  -> Ns.Class.Method
    const noArgs = line.replace(/\(.*\)$/s, "");
    const lastDot = noArgs.lastIndexOf(".");
    if (lastDot <= 0) continue;
    const cls = noArgs.slice(0, lastDot);
    // Guard against non-test chatter lines (must look like an identifier path).
    if (/^[A-Za-z_][A-Za-z0-9_.+`<>]*$/.test(cls)) classes.add(cls);
  }
  if (res.code !== 0 && classes.size === 0) {
    throw new Error(`test discovery failed for ${csproj}: ${res.stderr || res.stdout}`);
  }
  return [...classes].sort();
}
