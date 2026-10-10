import { isRecord } from "../is.js";
import type { RpcResponse, ToolResult } from "./types.js";

export function parseMcpHttpBody(contentType: string, body: string): RpcResponse | null {
  if (!body.trim()) return null;
  if (contentType.toLowerCase().includes("text/event-stream")) {
    const messages: RpcResponse[] = [];
    for (const block of body.split(/\n\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      messages.push(JSON.parse(data) as RpcResponse);
    }
    return messages.find((message) => message.id != null) ?? messages.at(-1) ?? null;
  }
  return JSON.parse(body) as RpcResponse;
}

export function toolMessage(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function textOf(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

export function unwrapPayload(result: ToolResult): unknown {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = textOf(result).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const embedded = extractEmbeddedJson(text);
    return embedded === undefined ? text : embedded;
  }
}

function extractEmbeddedJson(text: string): unknown | undefined {
  const marker = '{"success"';
  const start = text.lastIndexOf(marker);
  if (start < 0) return undefined;
  return parseJsonValue(text, start);
}

function parseJsonValue(text: string, start: number): unknown | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.data)) return { ...payload, ...payload.data };
  return payload;
}

export const STORE_CLOSED_HINT = "门店当前不营业，可换 24 小时门店或改用预约（reservationDate）";

export function businessFailed(payload: unknown): string | null {
  if (!isRecord(payload) || payload.success !== false) return null;
  if (payload.code === 600057 || payload.code === "600057") return STORE_CLOSED_HINT;
  return typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : "上游返回失败";
}
