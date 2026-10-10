import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderDemo } from "../src/demo.js";
import { VERSION } from "../src/version.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("required contest files are present and the declaration is unchanged", () => {
  const declaration = readFileSync(join(root, "CONTEST_DECLARATION.md"));
  assert.equal(createHash("sha256").update(declaration).digest("hex"), "cd28101bcb29cc8fb24b372fe91ce6b42c4a1487a54e01f7ade0c8c6a84241b7");
  for (const file of ["README.md", "MCP_INTEGRATION.md", "mcp-config.example.json", "docs/contest-issue.md"]) {
    assert.equal(statSync(join(root, file)).isFile(), true, file);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  assert.equal(pkg.version, VERSION);
});

test("example mcp config only contains placeholders", () => {
  const config = JSON.parse(readFileSync(join(root, "mcp-config.example.json"), "utf8")) as {
    mcpServers: { "mcd-cooldown": { env: Record<string, string> } };
  };
  const env = config.mcpServers["mcd-cooldown"].env;
  assert.equal(env.MCD_MCP_TOKEN, "${MCD_MCP_TOKEN}");
  assert.equal(env.MCD_MCP_URL, "https://mcp.mcd.cn");
  const raw = readFileSync(join(root, "mcp-config.example.json"), "utf8");
  assert.equal(/Bearer\s+(?!\$\{)(?!YOUR_)[A-Za-z0-9._~+/-]{12,}/.test(raw), false);
});

test("contest issue is paste-ready", () => {
  const body = readFileSync(join(root, "docs/contest-issue.md"), "utf8").trim();
  assert.ok(body.startsWith("【参赛申请】"));
  assert.match(body, /项目名称：mcd-cooldown/);
  assert.match(body, /项目地址：https:\/\/github.com\/Adonis0123\/mcd-cooldown/);
  assert.match(body, /项目简介：/);
  assert.ok(body.length <= 1000, `issue length ${body.length}`);
  assert.equal(body.includes("!["), false);
  assert.equal(/\.(png|gif|jpe?g)/i.test(body), false);
});

test("readme shows the demo and avoids comparison or excess-eating copy", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(readme.includes(renderDemo()));
  assert.match(readme, /mcd · 午饭时间 · 起来吃一点 · 现在确认，约 12:05 可取/);
  assert.match(readme, /现在确认，约 12:05 送达/);
  assert.match(readme, /非麦当劳官方产品/);
  assert.match(readme, /doctor/);
  const banned = [
    "\u80af\u5fb7\u57fa",
    "\u6c49\u5821\u738b",
    "\u5fc5\u80dc\u5ba2",
    "\u5783\u573e\u98df\u54c1",
    "\u7206\u5403",
    "\u4e0d\u5065\u5eb7",
  ];
  const files = sourceFiles(root);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const word of banned) {
      assert.equal(text.includes(word), false, `${relative(root, file)} contains banned copy`);
    }
  }
});

function sourceFiles(dir: string): string[] {
  const skip = new Set(["node_modules", "dist", ".git", "coverage", "uploads", "agent-tools"]);
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(md|ts|json|yml)$/.test(entry)) out.push(full);
  }
  return out;
}
