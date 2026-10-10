import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confirmPending } from "../src/confirm.js";
import { defaultConfig, type AppConfig } from "../src/config.js";
import { preparePlan, runHook } from "../src/cooldown.js";
import { runDoctor } from "../src/doctor.js";
import { Guard } from "../src/guard.js";
import { FixtureBackend } from "../src/mcp/fixtures.js";
import type { ToolCaller, ToolResult } from "../src/mcp/types.js";
import { findTokenInTree } from "../src/leak.js";
import { writeFileSync } from "node:fs";
import { HomeStore } from "../src/store.js";
import { DEMO_RESET } from "../src/demo.js";

function context(now = new Date("2026-10-10T13:20:00.000Z"), config: AppConfig = defaultConfig()) {
  const home = mkdtempSync(join(tmpdir(), "mcd-guard-"));
  const store = new HomeStore(home);
  store.ensure();
  const backend = new FixtureBackend();
  const guard = new Guard({
    caller: backend,
    store,
    config,
    token: "local-test-token",
    now: () => now,
  });
  return { home, store, backend, guard, config, now };
}

const orderArgs = {
  storeCode: "SAMPLE-STORE",
  beCode: "SAMPLE-BE",
  beType: 1,
  items: [{ productCode: "SAMPLE-001", quantity: 1 }],
  takeWayCode: "1",
};

test("create-order is quoted and held, then confirmed once", async () => {
  const { guard, backend, store, config, now } = context();
  const response = await guard.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "create-order", arguments: orderArgs },
  });
  const text = JSON.stringify(response);
  assert.match(text, /未向麦当劳提交/);
  assert.match(text, /¥36\.50/);
  assert.equal(text.includes("local-test-token"), false);
  assert.equal(backend.called("create-order"), 0);
  assert.equal(backend.called("calculate-price"), 1);
  const id = store.listPending()[0]?.id;
  assert.ok(id);
  const confirmed = await confirmPending(store, backend, config, id, {
    allowQuiet: false,
    retry: false,
    now,
    token: "local-test-token",
  });
  assert.match(confirmed, /SAMPLE-ORDER-1/);
  assert.equal(backend.called("create-order"), 1);
  const again = await confirmPending(store, backend, config, id, {
    allowQuiet: false,
    retry: false,
    now,
    token: "local-test-token",
  });
  assert.match(again, /不再重复提交/);
  assert.equal(backend.called("create-order"), 1);
  assert.equal(store.readAudit().some((event) => JSON.stringify(event).includes("local-test-token")), false);
});

test("a price above the limit never reaches create-order", async () => {
  const { guard, backend } = context();
  const response = await guard.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "create-order",
      arguments: { ...orderArgs, items: [{ productCode: "PRICE_OVER", quantity: 1 }] },
    },
  });
  assert.match(JSON.stringify(response), /超过单笔上限/);
  assert.equal(backend.called("create-order"), 0);
  assert.equal(backend.called("calculate-price"), 1);
});

test("confirm re-checks the price and quiet hours", async () => {
  const { guard, backend, store, config } = context();
  await guard.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "create-order", arguments: orderArgs },
  });
  const id = store.listPending()[0]?.id ?? "";
  backend.priceCents = 20_000;
  await assert.rejects(
    () =>
      confirmPending(store, backend, config, id, {
        allowQuiet: false,
        retry: false,
        now: new Date("2026-10-10T13:20:00.000Z"),
        token: null,
      }),
    /超过单笔上限/,
  );
  assert.equal(backend.called("create-order"), 0);
  backend.priceCents = 3650;
  await assert.rejects(
    () =>
      confirmPending(store, backend, config, id, {
        allowQuiet: false,
        retry: false,
        now: new Date("2026-10-10T16:30:00.000Z"),
        token: null,
      }),
    /allow-quiet/,
  );
  assert.equal(backend.called("create-order"), 0);
});

test("upstream echoes of the token are scrubbed before the model sees them", async () => {
  const token = "local-test-token";
  const home = mkdtempSync(join(tmpdir(), "mcd-scrub-"));
  const store = new HomeStore(home);
  const caller: ToolCaller = {
    async listTools() {
      return [{ name: "now-time-info", description: "time" }];
    },
    async callTool(): Promise<ToolResult> {
      return { content: [{ type: "text", text: `secret ${token}` }] };
    },
  };
  const guard = new Guard({ caller, store, config: defaultConfig(), token, now: () => new Date("2026-10-10T13:20:00.000Z") });
  const response = await guard.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "now-time-info", arguments: {} },
  });
  assert.equal(JSON.stringify(response).includes(token), false);
  assert.match(JSON.stringify(response), /\[redacted\]/);
});

test("doctor on the fixture only calls read tools", async () => {
  const backend = new FixtureBackend();
  const workspace = mkdtempSync(join(tmpdir(), "mcd-doctor-"));
  const report = await runDoctor({
    caller: backend,
    token: null,
    tokenSource: "未配置",
    warnings: [],
    config: defaultConfig(),
    workspace,
    mock: true,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.called, ["tools/list", "now-time-info", "campaign-calendar", "list-nutrition-foods"]);
  assert.match(report.lines.join("\n"), /没有下单/);
  assert.equal(backend.called("create-order"), 0);
});

test("doctor fails when the token is sitting in the workspace", async () => {
  const token = "workspace-leak-token";
  const workspace = mkdtempSync(join(tmpdir(), "mcd-leak-"));
  writeFileSync(join(workspace, "notes.txt"), `token = ${token}\n`);
  const report = await runDoctor({
    caller: new FixtureBackend(),
    token,
    tokenSource: "环境变量 MCD_MCP_TOKEN",
    warnings: [],
    config: defaultConfig(),
    workspace,
    mock: true,
  });
  assert.equal(report.ok, false);
  assert.match(report.lines.join("\n"), /notes.txt/);
  assert.deepEqual(findTokenInTree(workspace, token), ["notes.txt"]);
});

test("plan quotes a saved meal and does not create an order", async () => {
  const { store, backend, config } = context();
  config.store = {
    storeCode: "SAMPLE-STORE",
    beCode: "SAMPLE-BE",
    beType: 1,
    orderType: 1,
    takeWayCode: "1",
  };
  config.usual = { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] };
  const plan = await preparePlan({
    caller: backend,
    store,
    config,
    now: new Date("2026-10-10T13:20:00.000Z"),
    session: {
      windows: [{ key: "five_hour", label: "5h", usedPercentage: 96, resetsAtMs: DEMO_RESET.getTime() }],
      durationMs: null,
    },
  });
  assert.equal(plan.quoteCents, 3650);
  assert.ok(plan.pendingId);
  assert.match(plan.headline, /41 分钟/);
  assert.equal(backend.called("create-order"), 0);
  assert.equal(backend.called("calculate-price"), 1);
  assert.equal(backend.called("now-time-info"), 1);
});

test("hook reminds once and stays quiet when nothing is wrong", async () => {
  const { store, backend, config } = context();
  const now = new Date("2026-10-10T16:30:00.000Z");
  const first = await runHook({
    raw: {},
    caller: backend,
    store,
    config,
    now,
    prepare: false,
  });
  assert.match(first, /先休息/);
  const second = await runHook({ raw: {}, caller: backend, store, config, now, prepare: false });
  assert.equal(second, "");
  const calm = await runHook({
    raw: { rate_limits: { five_hour: { used_percentage: 10, resets_at: DEMO_RESET.getTime() / 1000 } } },
    caller: backend,
    store,
    config,
    now: new Date("2026-10-10T13:20:00.000Z"),
    prepare: false,
  });
  assert.equal(calm, "");
});
