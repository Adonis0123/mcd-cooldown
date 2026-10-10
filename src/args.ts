const VALUE_FLAGS = new Set(["port", "city", "keyword", "host"]);

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) {
        throw new Error(`--${body} 需要一个值`);
      }
      flags[body] = next;
      i += 1;
      continue;
    }
    flags[body] = true;
  }
  return { command: positionals[0] ?? "help", positionals: positionals.slice(1), flags };
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}
