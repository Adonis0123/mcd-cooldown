import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { cliEntryPath, shellToken } from "./claude-setup.js";

const BIN_NAME = "mcd-cooldown";

/** True when a shell can run `mcd-cooldown` without a path prefix. */
export function mcdCooldownOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, BIN_NAME), constants.X_OK);
      return true;
    } catch {
      // This directory does not have the command.
    }
  }
  return false;
}

/**
 * Prefix for a command the user is expected to copy.
 * Global install and npm's bin link use `mcd-cooldown`, including when Claude
 * later runs `node <prefix>/lib/node_modules/.../cli.js` for the status line.
 * `node path/cli.js` from a clone stays `node` plus that path.
 * This does not affect the statusLine or hook command written into Claude settings.
 */
export function userCommand(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): string {
  return resolveUserCommand(cliEntryPath(), env, argv);
}

export function resolveUserCommand(cliPath: string, env: NodeJS.ProcessEnv, argv: readonly string[]): string {
  const invoked = argv[1] ?? "";
  if (invokedBinPointsHere(invoked, cliPath)) return BIN_NAME;
  if (installedBinPointsHere(cliPath)) return BIN_NAME;
  if (!directNodeCli(invoked, cliPath) && mcdCooldownOnPath(env)) return BIN_NAME;
  return `node ${shellToken(cliPath)}`;
}

function invokedBinPointsHere(invoked: string, cliPath: string): boolean {
  if (!invoked || basename(invoked) !== BIN_NAME) return false;
  return entryPointsHere(invoked, cliPath);
}

/** `node path/cli.js`, not the npm bin name. */
function directNodeCli(invoked: string, cliPath: string): boolean {
  if (!invoked || basename(invoked) === BIN_NAME) return false;
  return sameFile(invoked, cliPath);
}

/**
 * npm's global layout keeps a bin link next to the package:
 * `<prefix>/bin/mcd-cooldown` → `<prefix>/lib/node_modules/mcd-cooldown/.../cli.js`
 * (or `<prefix>/node_modules/...` on prefixes without `lib`).
 * Statusline is started as `node` plus that cli path, and the bin directory is
 * often missing from the caller's PATH. The link on disk is enough.
 */
function installedBinPointsHere(cliPath: string): boolean {
  let realCli: string;
  try {
    realCli = realpathSync(cliPath);
  } catch {
    return false;
  }
  if (!isInstalledPackage(realCli)) return false;
  const root = resolve(dirname(realCli), "..", "..");
  const candidates = [
    resolve(root, "..", "..", "..", "bin", BIN_NAME),
    resolve(root, "..", "..", "bin", BIN_NAME),
  ];
  return candidates.some((candidate) => entryPointsHere(candidate, realCli));
}

function isInstalledPackage(realCli: string): boolean {
  const parts = realCli.split(sep);
  const at = parts.lastIndexOf("node_modules");
  return at >= 0 && parts[at + 1] === "mcd-cooldown";
}

function entryPointsHere(candidate: string, cliPath: string): boolean {
  let realCli: string;
  try {
    realCli = realpathSync(cliPath);
    accessSync(candidate, constants.X_OK);
  } catch {
    return false;
  }
  try {
    if (realpathSync(candidate) === realCli) return true;
  } catch {
    // A shim is a regular file; its realpath is not cli.js.
  }
  try {
    const info = lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) return false;
    const text = readFileSync(candidate, "utf8");
    return (text.startsWith("#!") || text.includes("node")) && text.includes(realCli);
  } catch {
    return false;
  }
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
