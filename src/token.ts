import { existsSync, readFileSync, statSync } from "node:fs";
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

function assertTokenShape(token: string): void {
  if (token.length < 8) throw new UserError("Token 太短，已拒绝使用");
  if (/\s/.test(token)) throw new UserError("Token 不能包含空白。请只放入 Token 本身");
}
