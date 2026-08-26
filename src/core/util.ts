import { execFile } from "child_process";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 10 * 60 * 1000
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((err as unknown as { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
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
