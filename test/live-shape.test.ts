import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { confirmPending } from "../src/confirm.js";
import { assertHomeOutside, exampleConfigText, loadConfig } from "../src/config.js";
import { preparePlan, runHook } from "../src/cooldown.js";
import { extractStores, isFixtureStoreCode, runDoctor } from "../src/doctor.js";
import { breakfastHourHint, beforeNextMealHint } from "../src/init-config.js";
import { prepareMeal } from "../src/meals.js";
import { FixtureBackend } from "../src/mcp/fixtures.js";
import { businessFailed, MEAL_UNAVAILABLE_HINT, unwrapPayload } from "../src/mcp/parse.js";
import type { ToolCaller, ToolDefinition } from "../src/mcp/types.js";
import { calculatePriceArgs, orderArgsFromConfig, quoteCreateOrder } from "../src/order-flow.js";
import { UserError } from "../src/user-error.js";
import { formatAuditLine, formatPendingLine } from "../src/present.js";
import { HomeStore } from "../src/store.js";
import { formatZonedDateTime, zonedInstant } from "../src/time.js";
import { validateCreateOrder } from "../src/money.js";

const quiet = new Date("2026-10-10T16:30:00.000Z");
const afternoon = new Date("2026-10-10T13:20:00.000Z");

test("doctor reads the real store array and warns when it is empty", async () => {
  const backend = new FixtureBackend();
  const found = await runDoctor({
    caller: backend,
    token: null,
    tokenSource: "未配置",
    warnings: [],
    config: loadConfig(mkdtempSync(join(tmpdir(), "mcd-doc-")), {}).config,
    workspace: null,
    city: "示例市",
    keyword: "示例路",
    mock: true,
  });
  const text = found.lines.join("\n");
  assert.equal(found.ok, true);
  assert.match(text, /SAMPLE-STORE/);
  assert.match(text, /营业中/);
  assert.match(text, /00:00-23:59/);
  assert.equal(text.includes("SAMPLE-BE"), false);
  const table = "name|kcal\n示例汉堡|500\n示例玉米杯|80\n";
  assert.match(text, new RegExp(`正文长度 ${table.length} 字符`));

  const empty = await runDoctor({
    caller: new FixtureBackend(),
    token: null,
    tokenSource: "未配置",
    warnings: [],
    config: loadConfig(mkdtempSync(join(tmpdir(), "mcd-doc-")), {}).config,
    workspace: null,
    city: "示例市",
    keyword: "无门店",
    mock: true,
  });
  assert.equal(empty.ok, false);
  assert.match(empty.lines.join("\n"), /0 家门店/);
  assert.match(empty.lines.join("\n"), /换一个城市或关键词/);
});

test("doctor names tools that are upstream but missing from the catalog", async () => {
  const backend = new FixtureBackend();
  const caller: ToolCaller = {
    async listTools() {
      const tools = await backend.listTools();
      return [...tools, { name: "query-future-menu", description: "样例" } satisfies ToolDefinition];
    },
    callTool: (name, args) => backend.callTool(name, args),
  };
  const report = await runDoctor({
    caller,
    token: null,
    tokenSource: "未配置",
    warnings: [],
    config: loadConfig(mkdtempSync(join(tmpdir(), "mcd-doc-")), {}).config,
    workspace: null,
    mock: true,
  });
  assert.match(report.lines.join("\n"), /上游有、目录里没有的工具：query-future-menu/);
});

test("store list falls back through data array, stores, and list", () => {
  const fromArray = extractStores({
    success: true,
    data: [{ storeCode: "SAMPLE-STORE", storeName: "麦当劳示例餐厅", businessStatus: false, businessStartTime: "07:00", businessEndTime: "22:00" }],
  });
  assert.equal(fromArray[0]?.storeCode, "SAMPLE-STORE");
  assert.equal(fromArray[0]?.businessStatus, false);
  assert.equal(fromArray[0]?.beCode, null);
  const drive = extractStores({ data: [{ storeCode: "SAMPLE-STORE", storeName: "示例", beCode: "SAMPLE-BE", businessStatus: true }] });
  assert.equal(drive[0]?.beCode, "SAMPLE-BE");
  assert.equal(extractStores({ data: { stores: [{ storeCode: "A", name: "旧形状" }] } })[0]?.storeCode, "A");
  assert.equal(extractStores({ list: [{ storeCode: "B" }] })[0]?.storeCode, "B");
});

test("text-only tool results still yield the last success json", () => {
  const body = { success: true, code: 200, data: [{ storeCode: "SAMPLE-STORE", storeName: "示例", businessStatus: true }] };
  const text = `字段说明：storeCode 是门店编码\n先出现一个 {"success":false}\n${JSON.stringify(body)}\n`;
  const payload = unwrapPayload({ content: [{ type: "text", text }] });
  assert.equal(extractStores(payload)[0]?.storeCode, "SAMPLE-STORE");
  assert.equal(unwrapPayload({ content: [{ type: "text", text: "只有说明，没有结果" }] }), "只有说明，没有结果");
});

test("closed stores become a readable message and do not create a pending order", async () => {
  assert.equal(
    businessFailed({ success: false, code: 600057, message: "门店可能已关闭或不在营业时间" }),
    "门店当前不营业，可换 24 小时门店或改用预约（reservationDate）",
  );
  const home = mkdtempSync(join(tmpdir(), "mcd-closed-"));
  const store = new HomeStore(home);
  store.ensure();
  const backend = new FixtureBackend();
  const config = loadConfig(home, {}).config;
  config.store = { storeCode: "CLOSED-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" };
  config.usual = { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] };
  const plan = await preparePlan({ caller: backend, store, config, now: afternoon, session: { windows: [], durationMs: null } });
  assert.equal(plan.pendingId, null);
  assert.equal(plan.quoteCents, null);
  assert.match(plan.note, /门店当前不营业/);
  assert.match(plan.note, /reservationDate/);
  assert.equal(backend.called("create-order"), 0);
});

test("unavailable usual items become a plain sentence on plan, hook, and confirm", async () => {
  assert.equal(
    businessFailed({
      success: false,
      code: 60006,
      message: "商品已售罄或不可售，换一个商品或检查orderType/beType",
    }),
    MEAL_UNAVAILABLE_HINT,
  );
  assert.equal(MEAL_UNAVAILABLE_HINT.includes("商品已售罄"), false);
  const textOnly = await quoteCreateOrder(
    {
      async listTools() {
        return [];
      },
      async callTool() {
        const body = JSON.stringify({
          success: false,
          code: "60006",
          message: "商品已售罄或不可售，换一个商品或检查orderType/beType",
        });
        return { isError: true, content: [{ type: "text", text: body }] };
      },
    },
    { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }] },
  );
  assert.equal(textOnly.note, MEAL_UNAVAILABLE_HINT);

  const home = mkdtempSync(join(tmpdir(), "mcd-unavailable-"));
  const store = new HomeStore(home);
  store.ensure();
  const backend = new FixtureBackend();
  const config = loadConfig(home, {}).config;
  config.meals.enabled = true;
  config.store = { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" };
  config.usual = { label: "早餐款", items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }] };
  const plan = await preparePlan({ caller: backend, store, config, now: afternoon, session: { windows: [], durationMs: null } });
  assert.equal(plan.pendingId, null);
  assert.equal(plan.quoteCents, null);
  assert.equal(plan.note, beforeNextMealHint(afternoon, config.meals));
  assert.match(plan.note, /下一顿正餐还没开卖，周一 12:00 前会提前核价/);
  assert.equal(plan.note.includes("午饭 12:00"), false);
  assert.equal((plan.note.match(/核价/g) ?? []).length, 1);
  assert.equal(plan.note.includes("确认"), false);
  assert.equal(plan.note.includes("doctor"), false);
  assert.equal(plan.note.includes("换一份"), false);
  assert.equal(plan.note.includes("orderType"), false);
  assert.equal(backend.calls.some((call) => call.name === "calculate-price" && "reservationDate" in call.args), false);

  const mealHome = mkdtempSync(join(tmpdir(), "mcd-unavailable-hook-"));
  const mealStore = new HomeStore(mealHome);
  mealStore.ensure();
  const hookBackend = new FixtureBackend();
  const hook = await runHook({
    raw: { rate_limits: { five_hour: { used_percentage: 96, resets_at: afternoon.getTime() / 1000 + 3600 } } },
    caller: hookBackend,
    store: mealStore,
    config,
    now: afternoon,
    prepare: true,
  });
  assert.match(hook, /额度约 1 小时后恢复，起来活动一下/);
  assert.match(hook, /下一顿正餐还没开卖，周一 12:00 前会提前核价。程序没有下单/);
  assert.equal((hook.match(/核价/g) ?? []).length, 1);
  assert.equal(hook.includes("确认"), false);
  assert.equal(hook.includes("现在只是核价"), false);
  assert.equal(hook.includes("doctor"), false);
  assert.equal(hook.includes("换一份"), false);
  assert.equal(hook.includes("商品已售罄"), false);
  assert.equal(hookBackend.called("create-order"), 0);

  const pending = store.createPending({
    tool: "create-order",
    args: {
      storeCode: "SAMPLE-STORE",
      beType: 1,
      orderType: 1,
      takeWayCode: "eat-in",
      items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }],
    },
    quoteCents: 2000,
    now: afternoon,
    ttlMinutes: 30,
  });
  await assert.rejects(
    () => confirmPending(store, backend, config, pending.id, { allowQuiet: false, retry: false, now: afternoon, token: null }),
    (error: unknown) => {
      assert.ok(error instanceof UserError);
      assert.match(error.message, /重新跑 init 换一份/);
      assert.equal(error.message.includes("商品已售罄"), false);
      assert.equal(error.message.includes("orderType"), false);
      return true;
    },
  );
  assert.equal(backend.called("create-order"), 0);
});

test("morning plan explains 60006 without asking for another init", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-breakfast-"));
  const store = new HomeStore(home);
  store.ensure();
  const backend = new FixtureBackend();
  const config = loadConfig(home, {}).config;
  config.meals.lunch = "12:00";
  config.meals.dinner = "18:30";
  config.store = { storeCode: "1400123", beType: 1, orderType: 1, takeWayCode: "eat-in" };
  config.usual = { label: "午饭", items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }] };
  const morning = zonedInstant(2026, 10, 14, 8, 30, "Asia/Shanghai");
  const plan = await preparePlan({ caller: backend, store, config, now: morning, session: { windows: [], durationMs: null } });
  assert.equal(plan.pendingId, null);
  assert.equal(plan.quoteCents, null);
  assert.equal(plan.note, breakfastHourHint(morning, config.meals));
  assert.equal(plan.note, "早餐时段正餐还没开卖，午饭 12:00 前会提前核价。");
  assert.equal((plan.note.match(/核价/g) ?? []).length, 1);
  assert.equal(plan.note.includes("确认"), false);
  assert.equal(plan.note.includes("换一份"), false);
  assert.equal(plan.note.includes("重新跑 init 换"), false);
  assert.equal(plan.note.includes("商品已售罄"), false);
  const priced = backend.calls.find((call) => call.name === "calculate-price");
  assert.ok(priced);
  assert.equal("reservationDate" in priced.args, false);
  assert.equal(backend.called("create-order"), 0);

  const nearLunch = zonedInstant(2026, 10, 14, 11, 50, "Asia/Shanghai");
  const near = await preparePlan({
    caller: new FixtureBackend(),
    store,
    config,
    now: nearLunch,
    session: { windows: [], durationMs: null },
  });
  assert.equal(near.note, MEAL_UNAVAILABLE_HINT);
  assert.match(near.note, /重新跑 init 换一份/);
});

test("real doctor rejects a SAMPLE store and still accepts a numeric one", async () => {
  assert.equal(isFixtureStoreCode("SAMPLE-STORE"), true);
  assert.equal(isFixtureStoreCode("sample-store-2"), true);
  assert.equal(isFixtureStoreCode("CLOSED-STORE"), true);
  assert.equal(isFixtureStoreCode("1400123"), false);
  const token = "doctor-fixture-token";
  const home = mkdtempSync(join(tmpdir(), "mcd-sample-doc-"));
  const config = loadConfig(home, {}).config;
  config.store = { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1 };
  const backend = new FixtureBackend();
  const blocked = await runDoctor({
    caller: backend,
    token,
    tokenSource: "环境变量 MCD_MCP_TOKEN",
    warnings: [],
    config,
    workspace: null,
    mock: false,
  });
  assert.equal(blocked.ok, false);
  const blockedText = blocked.lines.join("\n");
  assert.match(blockedText, /init --mock/);
  assert.match(blockedText, /样例门店/);
  assert.match(blockedText, /SAMPLE-STORE/);
  assert.match(blockedText, /真实 Token/);
  assert.equal(blockedText.includes(token), false);
  assert.deepEqual(blocked.called, []);
  assert.equal(backend.calls.length, 0);

  const mocked = await runDoctor({
    caller: new FixtureBackend(),
    token: null,
    tokenSource: "未配置",
    warnings: [],
    config,
    workspace: null,
    mock: true,
  });
  assert.equal(mocked.ok, true);
  assert.equal(mocked.lines.join("\n").includes("样例门店（SAMPLE-STORE）"), false);

  config.store = { storeCode: "1400123", beType: 1, orderType: 1 };
  const numeric = new FixtureBackend();
  const allowed = await runDoctor({
    caller: numeric,
    token,
    tokenSource: "环境变量 MCD_MCP_TOKEN",
    warnings: [],
    config,
    workspace: null,
    mock: false,
  });
  assert.equal(allowed.ok, true, allowed.lines.join("\n"));
  assert.equal(allowed.lines.join("\n").includes(token), false);
  assert.equal(numeric.called("now-time-info"), 1);
});

test("pickup config omits beCode and drive-thru still requires it", () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cfg-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      store: { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "locker-in" },
      usual: { items: [{ productCode: "SAMPLE-001", quantity: 1 }] },
    }),
  );
  const loaded = loadConfig(home, {}).config;
  assert.equal(loaded.store?.beCode, undefined);
  const args = orderArgsFromConfig(loaded);
  assert.ok(args);
  assert.equal("beCode" in args, false);
  assert.equal(validateCreateOrder(args, 12), null);
  assert.equal("beCode" in calculatePriceArgs({ ...args, beCode: "SHOULD-NOT-SEND" }), false);

  const driveHome = mkdtempSync(join(tmpdir(), "mcd-cfg-"));
  writeFileSync(join(driveHome, "config.json"), JSON.stringify({ store: { storeCode: "SAMPLE-STORE", beType: 5, orderType: 1 } }));
  assert.equal(loadConfig(driveHome, {}).config.store, undefined);
  const drive = calculatePriceArgs({ storeCode: "SAMPLE-STORE", beCode: "SAMPLE-BE", beType: 5, items: [] });
  assert.equal(drive.beCode, "SAMPLE-BE");
  const priced = orderArgsFromConfig({
    ...loaded,
    store: { storeCode: "SAMPLE-STORE", beCode: "SAMPLE-BE", beType: 2, orderType: 2, addressId: "ADDR" },
  });
  assert.equal(priced?.beCode, "SAMPLE-BE");
});

test("plan quotes the real price shape and skips pending orders during quiet hours", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-plan-"));
  const store = new HomeStore(home);
  store.ensure();
  const backend = new FixtureBackend();
  backend.priceCents = 4100;
  const config = loadConfig(home, {}).config;
  config.store = { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" };
  config.usual = { label: "常点一份", items: [{ productCode: "1100", quantity: 1 }, { productCode: "4810", quantity: 1 }] };
  const meals = unwrapPayload(await backend.callTool("query-meals", { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1 }));
  assert.ok(meals && typeof meals === "object" && "data" in meals);
  const data = (meals as { data: { categories: unknown; meals: Record<string, { currentPrice: string }> } }).data;
  assert.ok(Array.isArray(data.categories));
  assert.equal(data.meals["SAMPLE-001"]?.currentPrice, "36.50");

  const day = await preparePlan({ caller: backend, store, config, now: afternoon, session: { windows: [], durationMs: null } });
  assert.equal(day.quoteCents, 4100);
  assert.match(day.note, /¥41\.00/);
  assert.ok(day.pendingId);
  const quoted = backend.calls.find((call) => call.name === "calculate-price");
  assert.equal(quoted && "beCode" in quoted.args, false);

  const nightStore = new HomeStore(mkdtempSync(join(tmpdir(), "mcd-night-")));
  nightStore.ensure();
  const night = await preparePlan({
    caller: new FixtureBackend(),
    store: nightStore,
    config,
    now: quiet,
    session: { windows: [], durationMs: null },
  });
  assert.equal(night.pendingId, null);
  assert.equal(night.quoteCents, 3650);
  assert.match(night.note, /休息时段/);
  assert.match(night.note, /不生成待确认单/);

  const allowedHome = mkdtempSync(join(tmpdir(), "mcd-allow-"));
  const allowedStore = new HomeStore(allowedHome);
  allowedStore.ensure();
  const allowed = await preparePlan({
    caller: new FixtureBackend(),
    store: allowedStore,
    config,
    now: quiet,
    session: { windows: [], durationMs: null },
    allowQuiet: true,
  });
  assert.ok(allowed.pendingId);
});

test("quiet hours do not open a meal window or a pending order", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-meal-"));
  const store = new HomeStore(home);
  store.ensure();
  const config = loadConfig(home, {}).config;
  config.meals.enabled = true;
  config.meals.weekends = true;
  config.meals.lunch = "00:30";
  config.store = { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" };
  config.usual = { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] };
  const record = await prepareMeal({ caller: new FixtureBackend(), store, config, now: quiet });
  assert.equal(record, null);
  assert.equal(store.listPending().length, 0);
});

test("running from the home directory does not treat MCD_HOME as a project path", () => {
  assert.doesNotThrow(() => assertHomeOutside(join(homedir(), ".mcd-cooldown"), homedir()));
  const loose = mkdtempSync(join(tmpdir(), "mcd-loose-"));
  assert.doesNotThrow(() => assertHomeOutside(join(loose, ".mcd-cooldown"), loose));
  const repo = mkdtempSync(join(tmpdir(), "mcd-repo-"));
  mkdirSync(join(repo, ".git"));
  assert.throws(() => assertHomeOutside(join(repo, ".mcd-cooldown"), repo), /MCD_HOME 不能放在项目目录里/);
  assert.doesNotThrow(() => assertHomeOutside(join(homedir(), ".mcd-cooldown"), repo));
});

test("pending and audit times render in the configured timezone", () => {
  const at = "2026-10-10T16:11:59.000Z";
  assert.equal(formatZonedDateTime(new Date(at), "Asia/Shanghai"), "2026-10-11 00:11:59");
  const line = formatPendingLine(
    {
      id: "7f3a2c1b",
      tool: "create-order",
      args: {},
      createdAt: at,
      expiresAt: at,
      status: "pending",
      quoteCents: 4100,
    },
    "Asia/Shanghai",
  );
  assert.match(line, /到期 2026-10-11 00:11:59/);
  assert.match(line, /¥41\.00/);
  const audit = formatAuditLine({ at, tool: "create-order", decision: "hold" }, "Asia/Shanghai", null);
  assert.match(audit, /2026-10-11 00:11:59/);
  assert.equal(audit.includes("16:11:59.000Z"), false);
});

test("example config is pickup-shaped and matches the template", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const raw = readFileSync(join(root, "examples/config.example.json"), "utf8");
  const example = JSON.parse(raw) as { store: { beCode?: string; beType: number; takeWayCode: string } };
  const template = JSON.parse(exampleConfigText(false)) as { store: { beCode?: string; beType: number; takeWayCode: string } };
  assert.equal(example.store.beCode, undefined);
  assert.equal(template.store.beCode, undefined);
  assert.equal(example.store.beType, 1);
  assert.equal(example.store.takeWayCode, "eat-in");
  assert.equal(template.store.takeWayCode, "eat-in");
  assert.equal(raw.includes("beCode"), false);
  assert.equal(exampleConfigText(false).includes("beCode"), false);
});
