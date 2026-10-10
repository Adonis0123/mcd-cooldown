import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureHttpHandler } from "../src/mcp/fixture-http.js";
import { listenLoopback } from "../src/mcp/http.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test("meal reminder shows on the statusline and ate clears it", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-meals-"));
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_NOW: "2026-10-12T03:50:00.000Z" };
  const on = await run(["meals", "on"], env);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /饭点提醒已开/);
  const line = await run(["statusline"], env);
  assert.equal(line.code, 0, line.stderr);
  assert.match(line.stdout, /午饭时间/);
  assert.match(line.stdout, /现在确认，约 12:10 可取/);
  const ate = await run(["ate"], env);
  assert.equal(ate.code, 0, ate.stderr);
  const after = await run(["statusline"], env);
  assert.equal(after.stdout.includes("午饭"), false);
});

test("demo, mock doctor, and loopback refusal work from the cli", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-"));
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_NOW: "2026-10-10T13:20:00.000Z" };
  const demo = await run(["demo"], env);
  assert.equal(demo.code, 0);
  assert.match(demo.stdout, /只核价，未下单/);
  const doctor = await run(["doctor", "--mock"], env);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /样例服务/);
  assert.match(doctor.stdout, /没有下单/);
  const exposed = await run(["serve", "--host", "0.0.0.0"], env);
  assert.notEqual(exposed.code, 0);
  assert.match(exposed.stderr, /127\.0\.0\.1/);
});

test("stdio guard holds create-order and confirm submits it once", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-stdio-"));
  const handler = fixtureHttpHandler();
  const server = await listenLoopback(handler);
  const token = "stdio-token-value";
  const env = {
    ...process.env,
    MCD_HOME: home,
    MCD_MCP_URL: server.url,
    MCD_MCP_TOKEN: token,
    MCD_NOW: "2026-10-10T13:20:00.000Z",
  };
  const child = spawn(process.execPath, [cli, "guard"], { env, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout) throw new Error("stdio was not piped");
  const lines = createInterface({ input: child.stdout });
  const queue: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  lines.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
      return;
    }
    queue.push(line);
  });
  const next = () => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve) => {
      waiter = resolve;
    });
  };
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    const init = JSON.parse(await next()) as { result?: { instructions?: string } };
    assert.match(init.result?.instructions ?? "", /不要向用户索取/);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create-order", arguments: { storeCode: "SAMPLE-STORE", beCode: "SAMPLE-BE", beType: 1, takeWayCode: "1", items: [{ productCode: "SAMPLE-001", quantity: 1 }] } } })}\n`);
    const held = await next();
    assert.match(held, /未向麦当劳提交/);
    assert.equal(held.includes(token), false);
    assert.equal(stderr.includes(token), false);
    assert.equal(handler.backend.called("create-order"), 0);
    const id = /请求号：([a-f0-9]{8})/.exec(held)?.[1];
    assert.ok(id);
    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const confirmed = await run(["confirm", id, "--allow-quiet"], env);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /SAMPLE-ORDER-1/);
    assert.equal(confirmed.stdout.includes(token), false);
    assert.equal(handler.backend.called("create-order"), 1);
    assert.equal(handler.observations.bodies.some((body) => body.includes(token)), false);
  } finally {
    lines.close();
    if (child.exitCode == null) child.kill();
    await server.close();
  }
});
