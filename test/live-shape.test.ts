import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertHomeOutside, exampleConfigText, loadConfig } from "../src/config.js";
import { preparePlan } from "../src/cooldown.js";
import { extractStores, runDoctor } from "../src/doctor.js";
import { prepareMeal } from "../src/meals.js";
import { FixtureBackend } from "../src/mcp/fixtures.js";
import { businessFailed, unwrapPayload } from "../src/mcp/parse.js";
import type { ToolCaller, ToolDefinition } from "../src/mcp/types.js";
import { calculatePriceArgs, orderArgsFromConfig } from "../src/order-flow.js";
import { formatAuditLine, formatPendingLine } from "../src/present.js";
import { HomeStore } from "../src/store.js";
import { formatZonedDateTime } from "../src/time.js";
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
