import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);

export function findTokenInTree(root: string, token: string): string[] {
  if (token.length < 8) return [];
  const hits: string[] = [];
  walk(resolve(root), resolve(root), token, hits, 0);
  return hits;
}

function walk(root: string, dir: string, token: string, hits: string[], depth: number): void {
  if (depth > 8 || hits.length >= 20) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    let info;
    try {
      info = lstatSync(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      walk(root, full, token, hits, depth + 1);
      continue;
    }
    if (!info.isFile() || info.size > 512 * 1024) continue;
    const buffer = readFileSync(full);
    if (buffer.includes(0)) continue;
    if (buffer.toString("utf8").includes(token)) hits.push(relative(root, full) || entry);
  }
}
