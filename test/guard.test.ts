import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
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
import { findTokenInTree, scanForToken } from "../src/leak.js";
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
  for (const call of backend.calls) {
    if (call.name === "calculate-price" || call.name === "create-order") assert.equal("beCode" in call.args, false);
  }
});

test("in-store create-order without beCode is held", async () => {
  const { guard, backend, store } = context();
  const response = await guard.handle({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "create-order",
      arguments: {
        storeCode: "SAMPLE-STORE",
        beType: 1,
        takeWayCode: "eat-in",
        items: [{ productCode: "SAMPLE-001", quantity: 1 }],
      },
    },
  });
  const text = JSON.stringify(response);
  assert.match(text, /未向麦当劳提交/);
  assert.equal(text.includes("缺少 beCode"), false);
  assert.equal(backend.called("create-order"), 0);
  assert.equal(store.listPending().length, 1);
  assert.equal("beCode" in (store.listPending()[0]?.args ?? {}), false);
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

test("doctor does not treat the config directory or dependency folders as a leak", async () => {
  const token = "home-config-token-0123456789";
  const root = mkdtempSync(join(tmpdir(), "mcd-home-scan-"));
  const configHome = join(root, ".mcd-cooldown");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(join(root, ".secret"));
  mkdirSync(join(root, "proj"));
  mkdirSync(join(root, "Library"));
  writeFileSync(join(configHome, "token"), `${token}\n`);
  writeFileSync(join(configHome, "config.json"), `{"note":"${token}"}\n`);
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), token);
  writeFileSync(join(root, ".secret", "hidden.txt"), token);
  writeFileSync(join(root, ".env"), `MCD_MCP_TOKEN=${token}\n`);
  writeFileSync(join(root, "proj", "notes.txt"), `token = ${token}\n`);
  writeFileSync(join(root, "Library", "notes.txt"), token);

  const atHome = scanForToken(root, token, { ignore: [configHome], skipTopHiddenDirs: true });
  assert.deepEqual(new Set(atHome.hits), new Set([".env", "proj/notes.txt"]));
  assert.equal(atHome.truncated, false);
  assert.equal(atHome.hits.some((hit) => hit.includes("node_modules") || hit.includes(".mcd-cooldown")), false);

  const inProject = scanForToken(root, token, { ignore: [configHome] });
  assert.equal(inProject.hits.includes("proj/notes.txt"), true);
  assert.equal(inProject.hits.includes(".secret/hidden.txt"), true);
  assert.equal(inProject.hits.some((hit) => hit.includes("node_modules") || hit.startsWith(".mcd-cooldown")), false);

  const onlyDeps = mkdtempSync(join(tmpdir(), "mcd-deps-only-"));
  mkdirSync(join(onlyDeps, "node_modules"), { recursive: true });
  writeFileSync(join(onlyDeps, "node_modules", "leak.txt"), token);
  assert.deepEqual(findTokenInTree(onlyDeps, token), []);

  const capped = mkdtempSync(join(tmpdir(), "mcd-cap-"));
  for (let i = 0; i < 5; i += 1) writeFileSync(join(capped, `f${i}.txt`), "plain\n");
  const stopped = scanForToken(capped, token, { maxFiles: 2 });
  assert.deepEqual(stopped.hits, []);
  assert.equal(stopped.truncated, true);

  const clean = await runDoctor({
    caller: new FixtureBackend(),
    token,
    tokenSource: "本机 token 文件",
    warnings: [],
    config: defaultConfig(),
    workspace: root,
    configHome,
    mock: true,
  });
  assert.equal(clean.ok, false);
  assert.match(clean.lines.join("\n"), /proj\/notes\.txt/);
  assert.equal(clean.lines.join("\n").includes(".mcd-cooldown"), false);
  assert.equal(clean.lines.join("\n").includes("node_modules"), false);

  const homeOnly = mkdtempSync(join(tmpdir(), "mcd-doctor-config-"));
  const homeConfig = join(homeOnly, ".mcd-cooldown");
  mkdirSync(homeConfig);
  writeFileSync(join(homeConfig, "token"), `${token}\n`);
  const passed = await runDoctor({
    caller: new FixtureBackend(),
    token,
    tokenSource: "本机 token 文件",
    warnings: [],
    config: defaultConfig(),
    workspace: homeOnly,
    configHome: homeConfig,
    mock: true,
  });
  assert.equal(passed.ok, true, passed.lines.join("\n"));
  const passedText = passed.lines.join("\n");
  assert.match(passedText, /本机配置目录不算泄露/);
  assert.match(passedText, /只读自检完成/);
  assert.equal(passedText.includes("请删掉"), false);
  assert.equal(passedText.includes(token), false);
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
