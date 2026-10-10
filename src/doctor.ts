import { toolEffect } from "./catalog.js";
import type { AppConfig } from "./config.js";
import { asText, isRecord } from "./is.js";
import { findTokenInTree } from "./leak.js";
import { payloadRecord, textOf, unwrapPayload } from "./mcp/parse.js";
import type { ToolCaller } from "./mcp/types.js";
import { scrubForLog } from "./redact.js";
import { UpstreamError } from "./mcp/client.js";

const REQUIRED: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "now-time-info", args: {} },
  { name: "campaign-calendar", args: {} },
  { name: "list-nutrition-foods", args: {} },
];

export interface DoctorInput {
  caller: ToolCaller;
  token: string | null;
  tokenSource: string;
  warnings: string[];
  config: AppConfig;
  workspace: string | null;
  city?: string;
  keyword?: string;
  mock: boolean;
}

export interface DoctorReport {
  ok: boolean;
  lines: string[];
  called: string[];
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const lines: string[] = [];
  const called: string[] = [];
  lines.push(input.mock ? "模式：样例服务，不是麦当劳官方实时数据" : "模式：连接麦当劳 MCP");
  lines.push(
    input.token
      ? `Token：已设置（${input.tokenSource}，长度 ${input.token.length}）`
      : "Token：未设置",
  );
  for (const warning of input.warnings) lines.push(`注意：${warning}`);
  if (!input.mock && !input.token) {
    lines.push("还没有 Token。在本机执行 export MCD_MCP_TOKEN=... 后重新运行 doctor。不要把 Token 写进仓库。");
    return { ok: false, lines, called };
  }
  if (input.token && input.workspace) {
    const leaks = findTokenInTree(input.workspace, input.token);
    if (leaks.length > 0) {
      lines.push(`Token 出现在项目文件里：${leaks.join(", ")}。请删掉后重新申请 Token。`);
      return { ok: false, lines, called };
    }
    lines.push("项目目录里没有发现当前 Token。");
  }

  let tools;
  try {
    tools = await input.caller.listTools();
    called.push("tools/list");
  } catch (error) {
    lines.push(failLine(error, input.token));
    return { ok: false, lines, called };
  }
  lines.push(`工具 ${tools.length} 个：${tools.map((tool) => tool.name).join(", ")}`);
  const writes = tools.map((tool) => tool.name).filter((name) => toolEffect(name) === "write");
  lines.push(`其中写工具 ${writes.length} 个，doctor 不会调用：${writes.join(", ") || "无"}`);

  let ok = true;
  for (const step of REQUIRED) {
    const outcome = await callRead(input, step.name, step.args, called);
    lines.push(outcome.line);
    ok &&= outcome.ok;
  }
  if (input.city || input.keyword) {
    if (!input.city || !input.keyword) {
      lines.push("查询附近门店需要同时提供 --city 和 --keyword。");
      ok = false;
    } else {
      const outcome = await callRead(
        input,
        "query-nearby-stores",
        { searchType: 2, beType: 1, city: input.city, keyword: input.keyword },
        called,
      );
      lines.push(outcome.line);
      ok &&= outcome.ok;
    }
  }
  const illegal = called.filter((name) => name !== "tools/list" && toolEffect(name) === "write");
  if (illegal.length > 0) {
    lines.push(`doctor 意外调用了写工具：${illegal.join(", ")}`);
    ok = false;
  }
  lines.push(ok ? "只读自检完成。没有下单，没有领券，没有抽奖，没有兑换。" : "自检未通过。没有执行写操作。");
  return { ok, lines, called };
}

async function callRead(
  input: DoctorInput,
  name: string,
  args: Record<string, unknown>,
  called: string[],
): Promise<{ ok: boolean; line: string }> {
  if (toolEffect(name) === "write") return { ok: false, line: `${name}：拒绝调用写工具` };
  try {
    const result = await input.caller.callTool(name, args);
    called.push(name);
    if (result.isError) return { ok: false, line: `${name}：上游返回错误` };
    return { ok: true, line: `${name}：${summarize(name, result, input.token)}` };
  } catch (error) {
    return { ok: false, line: `${name}：${failLine(error, input.token)}` };
  }
}

function summarize(name: string, result: Parameters<typeof textOf>[0], token: string | null): string {
  const payload = unwrapPayload(result);
  const data = payloadRecord(payload);
  if (name === "list-nutrition-foods") {
    const text = typeof payload === "string" ? payload : textOf(result);
    return `已返回，正文长度 ${text.length} 字符（不打印正文）`;
  }
  if (name === "now-time-info") {
    return clip(asText(data.formatted) ?? asText(data.date) ?? textOf(result), token);
  }
  if (name === "campaign-calendar") {
    const text = asText(data.markdown) ?? asText(data.content) ?? (typeof payload === "string" ? payload : textOf(result));
    return clip(text.split(/\r?\n/)[0] ?? text, token);
  }
  if (name === "query-nearby-stores") {
    const stores = Array.isArray(data.stores) ? data.stores : Array.isArray(data.list) ? data.list : [];
    const first = stores.find(isRecord);
    const storeName = first ? asText(first.storeName) ?? asText(first.name) ?? "未命名门店" : "没有门店";
    const storeCode = first ? asText(first.storeCode) ?? "" : "";
    const beCode = first ? asText(first.beCode) ?? "" : "";
    return clip(`${stores.length} 家，第一家 ${storeName} ${storeCode} ${beCode}`.trim(), token);
  }
  return "已返回";
}

function clip(text: string, token: string | null): string {
  return scrubForLog(text.replace(/\s+/g, " ").trim(), token).slice(0, 120);
}

function failLine(error: unknown, token: string | null): string {
  if (error instanceof UpstreamError) return scrubForLog(error.message, token);
  const message = error instanceof Error ? error.message : String(error);
  return scrubForLog(message, token);
}
