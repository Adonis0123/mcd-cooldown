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
    return text;
  }
}

export function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.data)) return { ...payload, ...payload.data };
  return payload;
}

export function businessFailed(payload: unknown): string | null {
  if (!isRecord(payload) || payload.success !== false) return null;
  return typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : "上游返回失败";
}
