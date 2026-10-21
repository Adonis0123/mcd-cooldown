import assert from "node:assert/strict";
import test from "node:test";
import { moneyDecision, extractCents, formatYuanFromCents } from "../src/money.js";
import { scrubForLog, scrubSecrets } from "../src/redact.js";
import { describeSchedule } from "../src/schedule.js";
import { defaultConfig, readyConfig } from "../src/config.js";
import { DEMO_NOW, DEMO_RESET, renderDemo } from "../src/demo.js";
import { isQuietHour, shanghaiParts } from "../src/time.js";
import { assertTokenUrl } from "../src/url-policy.js";
import { stringWidth } from "../src/width.js";
import { createFrameParser } from "../src/frame.js";
import { extractSession } from "../src/session.js";
import { formatStatusline } from "../src/cooldown.js";
import { userCommand } from "../src/user-command.js";
import { zonedInstant } from "../src/time.js";
import { HomeStore } from "../src/store.js";

test("money uses integer cents and blocks the over-limit order", () => {
  assert.equal(formatYuanFromCents(3650), "36.50");
  assert.equal(extractCents({ success: true, data: { price: 3650 } }), 3650);
  assert.equal(extractCents({ data: { price: "36.50" } }), null);
  const blocked = moneyDecision({ cents: 20_000, spentCents: 0, maxOrderCents: 8000, dailyLimitCents: 15_000 });
  assert.equal(blocked.ok, false);
  const daily = moneyDecision({ cents: 3650, spentCents: 14_000, maxOrderCents: 8000, dailyLimitCents: 15_000 });
  assert.equal(daily.ok, false);
});

test("secrets are removed and phone numbers are masked only in logs", () => {
  const token = "local-test-token";
  assert.equal(scrubSecrets(`Bearer ${token} and ${token}`, token).includes(token), false);
  assert.match(scrubForLog("联系 13812345678", null), /138\*\*\*\*5678/);
  assert.match(scrubSecrets("联系 13812345678", null), /13812345678/);
});

test("shanghai quiet hours and quota countdown are stable", () => {
  const quiet = new Date("2026-10-10T16:30:00.000Z");
  assert.equal(shanghaiParts(quiet).hm, "00:30");
  assert.equal(isQuietHour(quiet, 23, 6), true);
  assert.equal(isQuietHour(DEMO_NOW, 23, 6), false);
  const schedule = describeSchedule(DEMO_NOW, DEMO_RESET.getTime(), defaultConfig());
  assert.equal(schedule.headline, "约 41 分钟后恢复");
  assert.match(schedule.hint, /21:41/);
  assert.match(schedule.hint, /起身活动一下/);
  const late = describeSchedule(quiet, DEMO_RESET.getTime(), defaultConfig());
  assert.match(late.headline, /先休息/);
});

test("token is only sent to the official host or loopback", () => {
  assert.equal(assertTokenUrl("https://mcp.mcd.cn").hostname, "mcp.mcd.cn");
  assert.equal(assertTokenUrl("http://127.0.0.1:9/").hostname, "127.0.0.1");
  assert.throws(() => assertTokenUrl("http://mcp.mcd.cn"));
  assert.throws(() => assertTokenUrl("https://mcp.mcd.cn.evil.example"));
  assert.throws(() => assertTokenUrl("https://user:pass@mcp.mcd.cn"));
  assert.throws(() => assertTokenUrl("https://evil.example/mcp"));
});

test("demo box is aligned and statusline stays one calm line", () => {
  const demo = renderDemo();
  const box = demo.split("\n").slice(0, -1);
  const width = stringWidth(box[0] ?? "");
  for (const line of box) assert.equal(stringWidth(line), width);
  assert.match(demo, /只核价，未下单/);
  assert.match(demo, /非麦当劳官方产品/);
  const line = formatStatusline({
    now: DEMO_NOW,
    config: defaultConfig(),
    session: extractSession({
      rate_limits: { five_hour: { used_percentage: 96, resets_at: DEMO_RESET.getTime() / 1000 } },
    }),
    plan: {
      preparedAt: DEMO_NOW.toISOString(),
      headline: "约 41 分钟后恢复",
      hint: "",
      quiet: false,
      quoteCents: 3650,
      label: "常点一份",
      pendingId: "7f3a2c1b",
      note: "",
      clock: null,
      resetAtMs: DEMO_RESET.getTime(),
    },
    pickup: null,
    pickupStaleMs: 120_000,
  });
  assert.equal(line.includes("\n"), false);
  assert.equal(line, "mcd · 5h 96% · 41 分钟后恢复 · 已核价 ¥36.50 · 确认 7f3a2c1b");
  const calm = formatStatusline({
    now: DEMO_NOW,
    config: defaultConfig(),
    session: extractSession({ rate_limits: { five_hour: { used_percentage: 23, resets_at: DEMO_RESET.getTime() / 1000 } } }),
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
  });
  assert.equal(calm, "mcd · 5h 23%");
});

test("idle statusline says the next meal when configured, otherwise init", () => {
  const morning = zonedInstant(2026, 10, 21, 9, 30, "Asia/Shanghai");
  const bare = formatStatusline({
    now: morning,
    config: defaultConfig(),
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
  });
  assert.equal(bare, `mcd · 还没选门店和常点，运行 ${userCommand()} init`);
  assert.equal(bare.includes("待命"), false);
  assert.equal(readyConfig(defaultConfig()), false);

  const placeholder = defaultConfig();
  placeholder.store = { storeCode: "YOUR_STORE_CODE", beType: 1, orderType: 1, takeWayCode: "eat-in" };
  placeholder.usual = { label: "常点一份", items: [{ productCode: "YOUR_PRODUCT_CODE", quantity: 1 }] };
  const unfinished = formatStatusline({
    now: morning,
    config: placeholder,
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
  });
  assert.equal(unfinished, bare);

  const ready = defaultConfig();
  ready.store = { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" };
  ready.usual = { label: "鸡薯双全盒", items: [{ productCode: "SAMPLE-001", quantity: 1 }] };
  const input = {
    config: ready,
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
  };
  assert.equal(
    formatStatusline({ ...input, now: morning }),
    "mcd · 已就绪 · 午饭 12:00 · 常点 鸡薯双全盒",
  );
  assert.equal(
    formatStatusline({ ...input, now: zonedInstant(2026, 10, 21, 13, 0, "Asia/Shanghai") }),
    "mcd · 已就绪 · 晚饭 18:30 · 常点 鸡薯双全盒",
  );
  assert.equal(
    formatStatusline({ ...input, now: zonedInstant(2026, 10, 21, 19, 10, "Asia/Shanghai") }),
    "mcd · 已就绪 · 午饭 12:00 · 常点 鸡薯双全盒",
  );
  const quiet = formatStatusline({ ...input, now: zonedInstant(2026, 10, 21, 23, 30, "Asia/Shanghai") });
  assert.match(quiet, /先休息/);
  assert.equal(quiet.includes("已就绪"), false);
  assert.equal(quiet.includes("鸡薯双全盒"), false);
});

test("stdio parser accepts newline json and content-length frames", async () => {
  const messages: unknown[] = [];
  const parser = createFrameParser(
    (message) => messages.push(message),
    () => undefined,
  );
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  parser(Buffer.from(payload.slice(0, 4)));
  parser(Buffer.from(`${payload.slice(4)}\n`));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  parser(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  assert.equal(messages.length, 2);
});

test("daily spend follows the Shanghai date", () => {
  const store = new HomeStore(`/tmp/mcd-cooldown-spend-${Date.now()}`);
  store.appendAudit({
    at: "2026-10-10T15:00:00.000Z",
    tool: "create-order",
    decision: "forward",
    amountCents: 1000,
  });
  store.appendAudit({
    at: "2026-10-10T16:10:00.000Z",
    tool: "create-order",
    decision: "forward",
    amountCents: 2000,
  });
  const now = new Date("2026-10-10T16:30:00.000Z");
  assert.equal(store.spentTodayCents(now), 2000);
});
