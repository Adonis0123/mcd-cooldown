import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./user-error.js";

export interface TokenLoad {
  token: string | null;
  source: string;
  warnings: string[];
}

export function normalizeToken(raw: string): string {
  let token = raw.trim();
  if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, "").trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

export function loadToken(home: string, env: NodeJS.ProcessEnv): TokenLoad {
  const warnings: string[] = [];
  const fromEnv = env.MCD_MCP_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    const token = normalizeToken(fromEnv);
    assertTokenShape(token);
    return { token, source: "环境变量 MCD_MCP_TOKEN", warnings };
  }
  const file = join(home, "token");
  if (!existsSync(file)) return { token: null, source: "未配置", warnings };
  const mode = statSync(file).mode;
  if ((mode & 0o077) !== 0) warnings.push("token 文件对其他用户可读，建议 chmod 600");
  const token = normalizeToken(readFileSync(file, "utf8"));
  if (!token) return { token: null, source: "未配置", warnings };
  assertTokenShape(token);
  return { token, source: "本机 token 文件", warnings };
}

export function assertTokenShape(token: string): void {
  if (token.length < 8) throw new UserError("Token 太短，已拒绝使用");
  if (/\s/.test(token)) throw new UserError("Token 不能包含空白。请只放入 Token 本身");
}

export function tokenFilePath(home: string): string {
  return join(home, "token");
}

/** Write a normalized token to the home file. Returns length only, never the token. */
export function saveTokenFile(home: string, raw: string): { path: string; length: number } {
  const token = normalizeToken(raw);
  if (!token) throw new UserError("没有读到 Token，没有写入。");
  assertTokenShape(token);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = tokenFilePath(home);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return { path: file, length: token.length };
}

export function clearTokenFile(home: string): { path: string; removed: boolean } {
  const file = tokenFilePath(home);
  if (!existsSync(file)) return { path: file, removed: false };
  unlinkSync(file);
  return { path: file, removed: true };
}
