import { constants } from "node:fs";
import { accessSync } from "node:fs";
import { delimiter, join } from "node:path";
import { cliEntryPath, shellToken } from "./claude-setup.js";

/** True when a shell can run `mcd-cooldown` without a path prefix. */
export function mcdCooldownOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "mcd-cooldown"), constants.X_OK);
      return true;
    } catch {
      // This directory does not have the command.
    }
  }
  return false;
}

/**
 * Prefix for a command the user is expected to copy.
 * After a global install or `npm link` this is `mcd-cooldown`.
 * Otherwise it is `node` plus this install's cli path.
 */
export function userCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (mcdCooldownOnPath(env)) return "mcd-cooldown";
  return `node ${shellToken(cliEntryPath())}`;
}
