export interface ParsedArgs {
  command?: string;
  flags: Map<string, string | true>;
  /** Positional paths after the command (hook frameworks pass staged files this way). */
  files: string[];
  errors: string[];
}

const VALUE_FLAGS = new Set(["--base", "--parallel", "--format"]);
const BOOL_FLAGS = new Set(["--staged", "--refresh", "--if-missing", "--ci"]);

const COMMAND_FLAGS: Record<string, string[]> = {
  "build-map": ["--refresh", "--parallel", "--if-missing"],
  affected: ["--base", "--staged", "--format"],
  run: ["--base", "--staged", "--ci"],
  status: [],
};
const FILE_COMMANDS = new Set(["affected", "run"]);

/** Output formats `affected` can emit; "lines" is the default line-per-item form. */
export const AFFECTED_FORMATS = ["lines", "json"] as const;

/** Per-command validation: a flag the command ignores is an error, not a no-op. */
export function validateCommandArgs(p: ParsedArgs): string[] {
  const errors: string[] = [];
  const allowed = p.command !== undefined ? COMMAND_FLAGS[p.command] : undefined;
  if (!allowed) return errors; // unknown command: usage handles it
  for (const f of p.flags.keys()) {
    if (!allowed.includes(f)) errors.push(`${f} is not valid for ${p.command}`);
  }
  if (p.files.length > 0 && !FILE_COMMANDS.has(p.command!)) {
    errors.push(`${p.command} does not take file arguments`);
  }
  const format = p.flags.get("--format");
  if (typeof format === "string" && !(AFFECTED_FORMATS as readonly string[]).includes(format)) {
    errors.push(`--format ${format} is not valid (expected: ${AFFECTED_FORMATS.join(", ")})`);
  }
  // A typo'd count must not silently fall back to the default width.
  const parallel = p.flags.get("--parallel");
  if (typeof parallel === "string" && !/^[1-9]\d*$/.test(parallel)) {
    errors.push(`--parallel ${parallel} is not valid (expected: a positive integer)`);
  }
  return errors;
}

/**
 * Split argv into command, flags, and positional file paths. Value-taking
 * flags consume exactly the next token; anything else that isn't a flag is a
 * positional path, so `impact run a.cs --staged` can be rejected explicitly
 * instead of misread.
 */
export function parseCliArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const files: string[] = [];
  const errors: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      if (VALUE_FLAGS.has(tok)) {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith("--")) errors.push(`${tok} requires a value`);
        else {
          flags.set(tok, val);
          i++;
        }
      } else if (BOOL_FLAGS.has(tok)) {
        flags.set(tok, true);
      } else {
        errors.push(`unknown flag: ${tok}`);
      }
    } else if (command === undefined) {
      command = tok;
    } else {
      files.push(tok);
    }
  }
  return { command, flags, files, errors };
}
