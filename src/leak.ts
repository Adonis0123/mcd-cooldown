import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  ".npm",
  ".cache",
  ".pnpm-store",
  "bower_components",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".yarn",
]);

/** Top-level home folders that are not project source. Only applied on a home scan. */
const HOME_TOP_SKIP = new Set(["Library", "Applications", "Movies", "Music", "Pictures"]);

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".wasm",
  ".pyc",
  ".class",
  ".jar",
  ".exe",
  ".dmg",
  ".iso",
  ".7z",
  ".bz2",
  ".xz",
  ".sqlite",
  ".db",
  ".pack",
  ".bin",
]);

export interface LeakScanOptions {
  /** Absolute directories whose contents are the program's own state, not a project leak. */
  ignore?: readonly string[];
  /** Skip dot-directories and bulky media folders that sit directly in the scan root. */
  skipTopHiddenDirs?: boolean;
  maxFiles?: number;
  maxEntries?: number;
}

export interface LeakScan {
  hits: string[];
  truncated: boolean;
}

export function findTokenInTree(root: string, token: string, options?: LeakScanOptions): string[] {
  return scanForToken(root, token, options).hits;
}

export function scanForToken(root: string, token: string, options: LeakScanOptions = {}): LeakScan {
  if (token.length < 8) return { hits: [], truncated: false };
  const hits: string[] = [];
  const resolved = resolve(root);
  const ignore = (options.ignore ?? []).map((item) => resolve(item));
  if (ignore.some((dir) => pathInside(dir, resolved))) return { hits, truncated: false };
  const state = { files: 0, entries: 0, truncated: false };
  walk(resolved, resolved, token, hits, 0, {
    ignore,
    skipTopHiddenDirs: options.skipTopHiddenDirs === true,
    maxFiles: options.maxFiles ?? 2500,
    maxEntries: options.maxEntries ?? 8000,
    state,
  });
  return { hits, truncated: state.truncated };
}

export function pathInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

interface WalkOptions {
  ignore: string[];
  skipTopHiddenDirs: boolean;
  maxFiles: number;
  maxEntries: number;
  state: { files: number; entries: number; truncated: boolean };
}

function walk(root: string, dir: string, token: string, hits: string[], depth: number, options: WalkOptions): void {
  if (depth > 8 || hits.length >= 20 || options.state.truncated) return;
  if (options.ignore.some((item) => pathInside(item, dir))) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (hits.length >= 20 || options.state.truncated) return;
    options.state.entries += 1;
    if (options.state.entries > options.maxEntries) {
      options.state.truncated = true;
      return;
    }
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (options.ignore.some((item) => pathInside(item, full))) continue;
    let info;
    try {
      info = lstatSync(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (depth === 0 && options.skipTopHiddenDirs && (entry.startsWith(".") || HOME_TOP_SKIP.has(entry))) continue;
      walk(root, full, token, hits, depth + 1, options);
      continue;
    }
    if (!info.isFile() || info.size > 512 * 1024) continue;
    if (BINARY_EXT.has(extname(entry).toLowerCase())) continue;
    if (options.state.files >= options.maxFiles) {
      options.state.truncated = true;
      return;
    }
    options.state.files += 1;
    const buffer = readFileSync(full);
    if (buffer.includes(0)) continue;
    if (buffer.toString("utf8").includes(token)) hits.push(relative(root, full) || entry);
  }
}
