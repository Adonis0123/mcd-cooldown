import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { RpcRequest, RpcResponse } from "./types.js";

export interface LoopbackServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function listenLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  port = 0,
): Promise<LoopbackServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("没有拿到监听端口");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(res: ServerResponse, status: number, body: unknown, session?: string): void {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (session) headers["Mcp-Session-Id"] = session;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export function sendSse(res: ServerResponse, body: RpcResponse, session: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Mcp-Session-Id": session,
  });
  res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
