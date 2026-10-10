import { UserError } from "./user-error.js";

export function assertTokenUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError("MCD_MCP_URL 不是合法地址");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UserError("MCP 地址不能带账号、查询参数或片段，避免 Token 被带到意外位置");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (loopback) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UserError("本机样例服务只接受 http 或 https");
    }
    return url;
  }
  if (url.protocol !== "https:" || host !== "mcp.mcd.cn" || (url.pathname !== "/" && url.pathname !== "")) {
    throw new UserError("Token 只会发给 https://mcp.mcd.cn 或本机回环地址");
  }
  return url;
}
