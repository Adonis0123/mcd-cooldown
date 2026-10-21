import { spawnSync } from "node:child_process";

const status = spawnSync("git", ["status", "--porcelain", "--", "dist/src"], { encoding: "utf8" });
if (status.status !== 0) {
  process.stderr.write(status.stderr ?? "");
  process.exit(status.status ?? 1);
}
if (!status.stdout.trim()) process.exit(0);

console.error("dist/src 和已提交的编译结果不一致。请运行 npm run compile，并把 dist/src 提交进仓库。");
process.stderr.write(status.stdout);
const diff = spawnSync("git", ["diff", "--", "dist/src"], { encoding: "utf8" });
process.stderr.write(diff.stdout ?? "");
process.exit(1);
