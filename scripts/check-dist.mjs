import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, ".dist-check");
const tsc = join(root, "node_modules/typescript/lib/tsc.js");

if (!existsSync(tsc)) {
  console.error("缺少 typescript。请先在仓库里执行 npm install。");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json", "--outDir", outDir, "--pretty", "false"], {
  cwd: root,
  encoding: "utf8",
});
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout ?? "");
  process.stderr.write(compiled.stderr ?? "");
  rmSync(outDir, { recursive: true, force: true });
  process.exit(compiled.status ?? 1);
}

const expected = join(outDir, "src");
const actual = join(root, "dist/src");
const diffs = compareTrees(expected, actual);
rmSync(outDir, { recursive: true, force: true });
if (diffs.length === 0) process.exit(0);

console.error("dist/src 和当前源码不一致。请运行 npm run compile，并把 dist/src 一并提交。");
for (const line of diffs.slice(0, 30)) console.error(line);
if (diffs.length > 30) console.error(`还有 ${diffs.length - 30} 处差异。`);
process.exit(1);

function compareTrees(expectedDir, actualDir) {
  const diffs = [];
  const expectedFiles = listFiles(expectedDir);
  const actualFiles = existsSync(actualDir) ? listFiles(actualDir) : [];
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  for (const file of expectedFiles) {
    if (!actualSet.has(file)) {
      diffs.push(`缺少 dist/src/${file}`);
      continue;
    }
    const left = readFileSync(join(expectedDir, file));
    const right = readFileSync(join(actualDir, file));
    if (!left.equals(right)) diffs.push(`内容不同 dist/src/${file}`);
  }
  for (const file of actualFiles) {
    if (!expectedSet.has(file)) diffs.push(`多出来的 dist/src/${file}`);
  }
  return diffs;
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}
