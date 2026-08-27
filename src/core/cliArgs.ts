export interface ParsedArgs {
  command?: string;
  flags: Map<string, string | true>;
  /** Positional paths after the command (hook frameworks pass staged files this way). */
  files: string[];
  errors: string[];
}

const VALUE_FLAGS = new Set(["--base", "--parallel"]);
const BOOL_FLAGS = new Set(["--staged", "--refresh"]);

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
