import type { IncomingMessage, ServerResponse } from "node:http";
import { FixtureBackend } from "./fixtures.js";
import { isRpcRequest, readBody, sendJson, sendSse } from "./http.js";
import type { RpcRequest, RpcResponse } from "./types.js";

export interface FixtureHttpOptions {
  backend?: FixtureBackend;
  sse?: boolean;
  rejectAuth?: boolean;
  echoAuthOn401?: boolean;
  failFirstToolCall404?: boolean;
}

export interface FixtureObservations {
  bodies: string[];
  sessionHeaders: number;
}

export function fixtureHttpHandler(options: FixtureHttpOptions = {}) {
  const backend = options.backend ?? new FixtureBackend();
  const observations: FixtureObservations = { bodies: [], sessionHeaders: 0 };
  let toolCalls = 0;
  const handler = async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("fixture mcp expects POST");
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (options.rejectAuth || !auth.startsWith("Bearer ") || auth.slice("Bearer ".length).trim().length < 8) {
      const leaked = options.echoAuthOn401 ? auth : "";
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`当前鉴权码不存在或已失效!${leaked ? ` ${leaked}` : ""}`);
      return;
    }
    if (req.headers["mcp-session-id"]) observations.sessionHeaders += 1;
    const raw = await readBody(req);
    observations.bodies.push(raw);
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid json" } });
      return;
    }
    if (!isRpcRequest(message)) {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
      return;
    }
    if (options.failFirstToolCall404 && message.method === "tools/call") {
      toolCalls += 1;
      if (toolCalls === 1) {
        sendJson(res, 404, { message: "session expired" });
        return;
      }
    }
    const response = await handleFixtureRpc(backend, message);
    if (!response) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (options.sse) sendSse(res, response, "fixture-session");
    else sendJson(res, 200, response, "fixture-session");
  };
  return Object.assign(handler, { observations, backend });
}

export async function handleFixtureRpc(backend: FixtureBackend, message: RpcRequest): Promise<RpcResponse | null> {
  const id = message.id ?? null;
  if (!message.method || message.method.startsWith("notifications/")) return null;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcd-cooldown-fixture", version: "1.0.0" },
      },
    };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: await backend.listTools() } };
  }
  if (message.method === "tools/call") {
    const params = isParams(message.params) ? message.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = isParams(params.arguments) ? params.arguments : {};
    const result = await backend.callTool(name, args);
    return { jsonrpc: "2.0", id, result };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `未知方法 ${message.method}` } };
}

function isParams(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
