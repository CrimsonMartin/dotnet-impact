import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

let dotnetOverride: string | undefined;

/** Explicit dotnet executable path (dotnetImpact.dotnetPath); empty clears the override. */
export function setDotnetPath(p: string | undefined): void {
  dotnetOverride = p || undefined;
}

/**
 * Locate the dotnet executable. GUI-launched VS Code often lacks the shell's
 * PATH, so fall back to DOTNET_ROOT and well-known install locations.
 */
export function resolveDotnet(): string {
  if (dotnetOverride) return dotnetOverride;
  const exe = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return "dotnet";
  }
  const candidates = [
    process.env.DOTNET_ROOT ? path.join(process.env.DOTNET_ROOT, exe) : undefined,
    path.join(os.homedir(), ".dotnet", exe),
    "/usr/share/dotnet/dotnet",
    "/usr/lib/dotnet/dotnet",
    "/usr/local/share/dotnet/dotnet",
    "/snap/bin/dotnet",
    "C:\\Program Files\\dotnet\\dotnet.exe",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return "dotnet"; // let the spawn fail with a clear ENOENT message
}

export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 10 * 60 * 1000
): Promise<ExecResult> {
  let env = process.env;
  if (cmd === "dotnet") {
    cmd = resolveDotnet();
    // An absolute fallback path needs DOTNET_ROOT so the host resolves runtimes.
    if (path.isAbsolute(cmd)) env = { ...process.env, DOTNET_ROOT: path.dirname(cmd) };
  }
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = typeof e?.code === "number" ? e.code : e ? 1 : 0;
        let errText = stderr ?? "";
        if (e?.code === "ENOENT") {
          errText =
            `'${cmd}' was not found. Install the .NET SDK or point the ` +
            `dotnetImpact.dotnetPath setting at the dotnet executable.` +
            (errText ? `\n${errText}` : "");
        }
        resolve({ code, stdout: stdout ?? "", stderr: errText });
      }
    );
  });
}

export async function git(repo: string, args: string[]): Promise<ExecResult> {
  return exec("git", args, repo);
}

/** Cache directory for a repo, outside the repo so we never pollute or trigger watchers. */
export function cacheDirFor(repoRoot: string): string {
  const hash = crypto.createHash("sha1").update(path.resolve(repoRoot).toLowerCase()).digest("hex").slice(0, 12);
  return path.join(os.homedir(), ".dotnet-impact", `${path.basename(repoRoot)}-${hash}`);
}

export function toRepoRelative(repoRoot: string, file: string): string {
  return path.relative(repoRoot, path.resolve(file)).split(path.sep).join("/");
}

export interface StatusEntry {
  /** Two-character XY status from `git status --porcelain`. */
  status: string;
  file: string;
  /** For renames/copies: the path the file came from. */
  origin?: string;
}

/**
 * Parse `git status --porcelain -z` output. NUL-separated records; rename/copy
 * entries are followed by an extra NUL-separated record holding the origin path.
 */
export function parseStatusZ(stdout: string): StatusEntry[] {
  const chunks = stdout.split("\0");
  const out: StatusEntry[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.length < 4) continue;
    const status = chunk.slice(0, 2);
    const file = chunk.slice(3);
    let origin: string | undefined;
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      origin = chunks[++i] || undefined;
    }
    out.push({ status, file, origin });
  }
  return out;
}

/**
 * `dotnet test --filter` expression selecting whole test classes. The trailing
 * dot prevents substring over-match (class `Foo` must not select `FooBar`'s
 * tests): every test FQN is `<class>.<method>`, so `~<class>.` matches exactly
 * the class's own tests. Filter operator characters in names are escaped.
 */
export function classFilter(classes: string[]): string {
  return classes
    .map((c) => `FullyQualifiedName~${c.replace(/([()&|=!~])/g, "\\$1")}.`)
    .join("|");
}
