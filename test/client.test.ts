import assert from "node:assert/strict";
import test from "node:test";
import { McpHttpClient } from "../src/mcp/client.js";
import { FixtureBackend } from "../src/mcp/fixtures.js";
import { fixtureHttpHandler } from "../src/mcp/fixture-http.js";
import { listenLoopback } from "../src/mcp/http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

test("client speaks to the fixture over streamable http without putting the token in the body", async () => {
  const backend = new FixtureBackend();
  const handler = fixtureHttpHandler({ backend });
  const server = await listenLoopback(handler);
  try {
    const token = "fixture-client-token";
    const client = new McpHttpClient({ url: server.url, token });
    const tools = await client.listTools();
    assert.equal(tools.length, 33);
    const result = await client.callTool("now-time-info", {});
    assert.match(result.content[0]?.text ?? "", /2026-10-10 21:20:00/);
    assert.ok(handler.observations.sessionHeaders >= 1);
    assert.equal(handler.observations.bodies.some((body) => body.includes(token)), false);
    assert.equal(backend.called("create-order"), 0);
  } finally {
    await server.close();
  }
});

test("sse responses and a single expired session are recovered", async () => {
  const handler = fixtureHttpHandler({ sse: true, failFirstToolCall404: true });
  const server = await listenLoopback(handler);
  try {
    const client = new McpHttpClient({ url: server.url, token: "fixture-client-token" });
    const result = await client.callTool("campaign-calendar", {});
    assert.match(result.content[0]?.text ?? "", /示例活动/);
  } finally {
    await server.close();
  }
});

test("a 401 that echoes the token is scrubbed", async () => {
  const handler = fixtureHttpHandler({ rejectAuth: true, echoAuthOn401: true });
  const server = await listenLoopback(handler);
  const token = "echoed-token-value";
  try {
    const client = new McpHttpClient({ url: server.url, token });
    await assert.rejects(() => client.listTools(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /401/);
      assert.equal(message.includes(token), false);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("redirects are not followed", async () => {
  const server = await listenLoopback((req: IncomingMessage, res: ServerResponse) => {
    void req;
    res.writeHead(302, { Location: "https://evil.example/collect" });
    res.end();
  });
  try {
    const client = new McpHttpClient({ url: server.url, token: "fixture-client-token" });
    await assert.rejects(() => client.callTool("now-time-info", {}), /重定向/);
  } finally {
    await server.close();
  }
});
