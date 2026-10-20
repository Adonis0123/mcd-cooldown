import { CATALOG, toolEffect } from "./catalog.js";
import type { AppConfig } from "./config.js";
import { asText, isRecord } from "./is.js";
import { findTokenInTree } from "./leak.js";
import { businessFailed, payloadRecord, textOf, unwrapPayload } from "./mcp/parse.js";
import type { ToolCaller } from "./mcp/types.js";
import { scrubForLog } from "./redact.js";
import { UpstreamError } from "./mcp/client.js";
import { userCommand } from "./user-command.js";

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
    lines.push(`还没有 Token。先运行 ${userCommand()} token，把 Token 留在本机后再运行 doctor。不要写进仓库。`);
    return { ok: false, lines, called };
  }
  if (!input.mock) {
    const fixtureStore = fixtureStoreRefusal(input.config.store?.storeCode);
    if (fixtureStore) {
      lines.push(fixtureStore);
      return { ok: false, lines, called };
    }
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
  const known = new Set(CATALOG.map((tool) => tool.name));
  const extra = tools.map((tool) => tool.name).filter((name) => name !== "cooldown-status" && !known.has(name));
  if (extra.length > 0) lines.push(`上游有、目录里没有的工具：${extra.join(", ")}`);
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
    const payload = unwrapPayload(result);
    const failed = businessFailed(payload);
    if (failed) return { ok: false, line: `${name}：${clip(failed, input.token)}` };
    if (name === "query-nearby-stores") {
      const summary = formatStores(extractStores(payload));
      return { ok: summary.ok, line: `${name}：${clip(summary.text, input.token, 800)}` };
    }
    return { ok: true, line: `${name}：${summarize(name, result, input.token)}` };
  } catch (error) {
    return { ok: false, line: `${name}：${failLine(error, input.token)}` };
  }
}

/** True for init --mock store codes and the other fixture store ids in this repo. */
export function isFixtureStoreCode(storeCode: string): boolean {
  const code = storeCode.trim();
  if (!code || /^\d+$/.test(code)) return false;
  if (/^SAMPLE-/i.test(code)) return true;
  if (/SAMPLE/i.test(code)) return true;
  return /^CLOSED-STORE$/i.test(code);
}

export function fixtureStoreRefusal(storeCode: string | undefined): string | null {
  if (!storeCode || !isFixtureStoreCode(storeCode)) return null;
  return `配置里还是 init --mock 写下的样例门店（${storeCode.trim()}）。请用真实 Token 重新运行 ${userCommand()} init。不要把 Token 写进仓库或对话。`;
}

export interface StoreHit {
  storeCode: string;
  storeName: string;
  address: string | null;
  beCode: string | null;
  businessStatus: boolean | null;
  businessStartTime: string | null;
  businessEndTime: string | null;
}

export function extractStores(payload: unknown): StoreHit[] {
  return storeList(payload).flatMap((item) => {
    if (!isRecord(item)) return [];
    return [
      {
        storeCode: asText(item.storeCode) ?? "",
        storeName: asText(item.storeName) ?? asText(item.name) ?? "未命名门店",
        address: asText(item.address),
        beCode: asText(item.beCode),
        businessStatus: typeof item.businessStatus === "boolean" ? item.businessStatus : null,
        businessStartTime: asText(item.businessStartTime),
        businessEndTime: asText(item.businessEndTime),
      },
    ];
  });
}

function storeList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  const data = isRecord(payload.data) ? payload.data : payload;
  if (Array.isArray(data.stores)) return data.stores;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(payload.stores)) return payload.stores;
  if (Array.isArray(payload.list)) return payload.list;
  return [];
}

function formatStores(stores: StoreHit[]): { ok: boolean; text: string } {
  if (stores.length === 0) return { ok: false, text: "0 家门店。换一个城市或关键词再试。" };
  const parts = stores.map((store) => {
    const status = store.businessStatus === true ? "营业中" : store.businessStatus === false ? "未营业" : "营业状态未知";
    const hours = store.businessStartTime && store.businessEndTime ? ` ${store.businessStartTime}-${store.businessEndTime}` : "";
    const be = store.beCode ? ` beCode ${store.beCode}` : "";
    return `${store.storeName} ${store.storeCode}${be} ${status}${hours}`.trim();
  });
  return { ok: true, text: `${stores.length} 家：${parts.join("；")}` };
}

function summarize(name: string, result: Parameters<typeof textOf>[0], token: string | null): string {
  const payload = unwrapPayload(result);
  const data = payloadRecord(payload);
  if (name === "list-nutrition-foods") {
    const text = nutritionText(payload, result);
    return `已返回，正文长度 ${text.length} 字符（不打印正文）`;
  }
  if (name === "now-time-info") {
    return clip(asText(data.formatted) ?? asText(data.date) ?? textOf(result), token);
  }
  if (name === "campaign-calendar") {
    const text = asText(data.markdown) ?? asText(data.content) ?? (typeof payload === "string" ? payload : textOf(result));
    return clip(text.split(/\r?\n/)[0] ?? text, token);
  }
  return "已返回";
}

function nutritionText(payload: unknown, result: Parameters<typeof textOf>[0]): string {
  if (typeof payload === "string") return payload;
  if (isRecord(payload) && typeof payload.data === "string") return payload.data;
  return textOf(result);
}

function clip(text: string, token: string | null, limit = 120): string {
  return scrubForLog(text.replace(/\s+/g, " ").trim(), token).slice(0, limit);
}

function failLine(error: unknown, token: string | null): string {
  if (error instanceof UpstreamError) return scrubForLog(error.message, token);
  const message = error instanceof Error ? error.message : String(error);
  return scrubForLog(message, token);
}
