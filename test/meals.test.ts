import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confirmPending } from "../src/confirm.js";
import { defaultConfig, type AppConfig } from "../src/config.js";
import { formatStatusline, runHook } from "../src/cooldown.js";
import { mealCommand, mealStatusFor, prepareMeal, dismissMeal } from "../src/meals.js";
import { extractPrepMinutes } from "../src/order-flow.js";
import { FixtureBackend } from "../src/mcp/fixtures.js";
import { userCommand } from "../src/user-command.js";
import { extractSession } from "../src/session.js";
import { HomeStore } from "../src/store.js";
import { zonedInstant, zonedParts } from "../src/time.js";

const tz = "Asia/Shanghai";

function home(): { store: HomeStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mcd-meals-"));
  const store = new HomeStore(root);
  store.ensure();
  return { store, root };
}

function mealsOn(extra: Partial<AppConfig["meals"]> = {}): AppConfig {
  const config = defaultConfig();
  config.meals = { ...config.meals, enabled: true, ...extra };
  config.store = { storeCode: "SAMPLE-STORE", beCode: "SAMPLE-BE", beType: 1, orderType: 1, takeWayCode: "1" };
  config.usual = { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] };
  return config;
}

function at(year: number, month: number, day: number, hour: number, minute: number): Date {
  return zonedInstant(year, month, day, hour, minute, tz);
}

test("prep minutes prefer an explicit estimate and ignore prices", () => {
  assert.equal(extractPrepMinutes({ price: 3650, expectMinutes: 25 }), 25);
  assert.equal(extractPrepMinutes({ data: { deliveryTime: "15分钟", productPrice: 3650 } }), 15);
  assert.equal(extractPrepMinutes({ price: 3650, timestamp: 1_700_000_000_000 }), null);
});

test("meal window opens by the prep lead and closes after the linger", () => {
  const { store } = home();
  const config = mealsOn();
  const target = at(2026, 10, 12, 12, 0);
  assert.equal(zonedParts(target, tz).weekday, 1);
  assert.equal(mealStatusFor(new Date(target.getTime() - 20 * 60_000 - 1), config, store), null);
  const open = mealStatusFor(new Date(target.getTime() - 20 * 60_000), config, store);
  assert.equal(open?.phrase, "午饭时间");
  assert.equal(open?.arriveHm, "12:00");
  assert.equal(open?.verb, "可取");
  assert.ok(mealStatusFor(new Date(target.getTime() + 45 * 60_000 - 1), config, store));
  assert.equal(mealStatusFor(new Date(target.getTime() + 45 * 60_000), config, store), null);
});

test("a learned prep time moves the reminder earlier than the default", () => {
  const { store } = home();
  const config = mealsOn();
  store.writeLearnedPrep(25);
  const target = at(2026, 10, 12, 12, 0);
  assert.equal(mealStatusFor(new Date(target.getTime() - 26 * 60_000), config, store), null);
  const open = mealStatusFor(new Date(target.getTime() - 25 * 60_000), config, store);
  assert.equal(open?.arriveHm, "12:00");
  assert.equal(open?.prepMinutes, 25);
  store.writeMeal({
    ymd: zonedParts(target, tz).ymd,
    slot: "lunch",
    nudged: false,
    dismissed: null,
    snoozeUntil: null,
    ordered: false,
    prepMinutes: 10,
    prepSource: "mcp",
    quoteCents: null,
    pendingId: null,
    label: null,
    preparedAt: null,
    note: null,
  });
  assert.equal(mealStatusFor(new Date(target.getTime() - 15 * 60_000), config, store), null);
  const shorter = mealStatusFor(new Date(target.getTime() - 10 * 60_000), config, store);
  assert.equal(shorter?.prepMinutes, 10);
  assert.equal(shorter?.arriveHm, "12:00");
});

test("weekends stay quiet until asked, and another timezone uses its own clock", () => {
  const { store } = home();
  const saturday = at(2026, 10, 10, 11, 50);
  assert.equal(zonedParts(saturday, tz).weekday, 6);
  assert.equal(mealStatusFor(saturday, mealsOn(), store), null);
  assert.equal(mealStatusFor(saturday, mealsOn({ weekends: true }), store)?.phrase, "午饭时间");
  const shanghaiLunch = at(2026, 10, 12, 11, 50);
  assert.equal(mealStatusFor(shanghaiLunch, mealsOn({ timezone: "America/New_York" }), store), null);
  assert.equal(mealStatusFor(shanghaiLunch, mealsOn(), store)?.phrase, "午饭时间");
});

test("quiet hours hide the meal reminder", () => {
  const { store } = home();
  const config = mealsOn({ dinner: "23:20", prepMinutes: 40 });
  const beforeQuiet = at(2026, 10, 12, 22, 50);
  assert.equal(mealStatusFor(beforeQuiet, config, store)?.phrase, "晚饭时间");
  const quiet = at(2026, 10, 12, 23, 10);
  assert.equal(mealStatusFor(quiet, config, store), null);
  const line = formatStatusline({
    now: quiet,
    config,
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
    meal: {
      slot: "dinner",
      ymd: "2026-10-12",
      phrase: "晚饭时间",
      arriveHm: "23:30",
      verb: "可取",
      quoteCents: 3650,
      pendingId: "7f3a2c1b",
      prepMinutes: 20,
      prepSource: "default",
    },
  });
  assert.match(line, /先休息/);
  assert.equal(line.includes("晚饭"), false);
});

test("statusline shows one confirm line and merges with a quota countdown", () => {
  const now = at(2026, 10, 12, 11, 50);
  const meal = {
    slot: "lunch" as const,
    ymd: "2026-10-12",
    phrase: "午饭时间",
    arriveHm: "12:05",
    verb: "可取" as const,
    quoteCents: 3650,
    pendingId: "7f3a2c1b",
    prepMinutes: 15,
    prepSource: "mcp" as const,
  };
  const alone = formatStatusline({
    now,
    config: mealsOn(),
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
    meal,
  });
  assert.equal(alone, "mcd · 午饭时间 · 起来吃一点 · 现在确认，约 12:05 可取 · 已核价 ¥36.50 · 确认 7f3a2c1b");
  const merged = formatStatusline({
    now,
    config: mealsOn(),
    session: extractSession({
      rate_limits: { five_hour: { used_percentage: 96, resets_at: now.getTime() / 1000 + 41 * 60 } },
    }),
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
    meal,
  });
  assert.equal(merged, "mcd · 午饭时间 · 现在确认，约 12:05 可取 · 已核价 ¥36.50 · 确认 7f3a2c1b · 5h 96% · 41 分钟后恢复");
  assert.equal(merged.match(/确认 7f3a2c1b/g)?.length, 1);
  const delivery = formatStatusline({
    now,
    config: mealsOn(),
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
    meal: { ...meal, verb: "送达" },
  });
  assert.match(delivery, /现在确认，约 12:05 送达/);
});

test("ate, later, and skip each silence one meal, and later comes back", () => {
  const { store } = home();
  const config = mealsOn();
  const now = at(2026, 10, 12, 11, 50);
  assert.match(dismissMeal(store, config, now, "later"), /15 分钟/);
  assert.equal(mealStatusFor(now, config, store), null);
  assert.equal(mealStatusFor(new Date(now.getTime() + 14 * 60_000), config, store), null);
  assert.equal(mealStatusFor(new Date(now.getTime() + 15 * 60_000), config, store)?.phrase, "午饭时间");
  assert.match(dismissMeal(store, config, now, "ate"), /不再提醒/);
  assert.equal(mealStatusFor(new Date(now.getTime() + 20 * 60_000), config, store), null);
  assert.match(dismissMeal(store, config, at(2026, 10, 13, 11, 50), "skip", "lunch"), /跳过/);
  assert.equal(mealStatusFor(at(2026, 10, 13, 11, 50), config, store), null);
  assert.equal(mealStatusFor(at(2026, 10, 12, 18, 20), config, store)?.phrase, "晚饭时间");
});

test("hook quotes once, merges with cooldown, and does not order", async () => {
  const { store } = home();
  const config = mealsOn();
  const backend = new FixtureBackend();
  backend.prepMinutes = 15;
  const now = at(2026, 10, 12, 11, 50);
  const raw = { rate_limits: { five_hour: { used_percentage: 96, resets_at: now.getTime() / 1000 + 41 * 60 } } };
  const notes: string[] = [];
  const first = await runHook({
    raw,
    caller: backend,
    store,
    config: { ...config, meals: { ...config.meals, notify: true } },
    now,
    prepare: true,
    notify: (title) => notes.push(title),
  });
  assert.match(first, /午饭时间到了/);
  assert.match(first, /额度/);
  assert.match(first, /¥36\.50/);
  assert.equal(first.split(`${userCommand()} confirm`).length, 2);
  assert.equal(backend.called("create-order"), 0);
  assert.equal(backend.called("calculate-price"), 1);
  assert.deepEqual(notes, ["该起来吃饭了"]);
  const line = formatStatusline({
    now,
    config,
    session: extractSession(raw),
    plan: store.readPlan(),
    pickup: null,
    pickupStaleMs: 120_000,
    meal: mealStatusFor(now, config, store),
  });
  assert.match(line, /12:05 可取/);
  assert.match(line, /5h 96%/);
  const second = await runHook({ raw, caller: backend, store, config, now, prepare: true });
  assert.equal(second, "");
  assert.equal(backend.called("calculate-price"), 1);
  const quiet = await runHook({
    raw: {},
    caller: backend,
    store,
    config,
    now: at(2026, 10, 12, 23, 30),
    prepare: false,
  });
  assert.match(quiet, /先休息/);
  assert.equal(quiet.includes("晚饭"), false);
});

test("hook explains a usual item the current meal cannot sell", async () => {
  const { store } = home();
  const config = mealsOn();
  config.usual = { label: "早餐款", items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }] };
  const backend = new FixtureBackend();
  const now = at(2026, 10, 12, 11, 50);
  const text = await runHook({ raw: {}, caller: backend, store, config, now, prepare: true });
  assert.match(text, /这个时段不卖的餐品/);
  assert.match(text, /重新跑 init/);
  assert.match(text, /换一份。程序没有下单/);
  assert.equal(text.includes("换一份程序"), false);
  assert.match(text, /核价没成功/);
  assert.equal(text.includes("现在确认"), false);
  assert.equal(text.includes("商品已售罄"), false);
  assert.equal(text.includes("orderType"), false);
  assert.equal(backend.called("create-order"), 0);
  assert.equal(store.listPending().length, 0);
});

test("a confirmed order clears that meal", async () => {
  const { store } = home();
  const config = mealsOn();
  const backend = new FixtureBackend();
  const now = at(2026, 10, 12, 11, 50);
  const record = await prepareMeal({ caller: backend, store, config, now });
  if (!record?.pendingId) throw new Error("missing quote");
  assert.equal(backend.called("create-order"), 0);
  await confirmPending(store, backend, config, record.pendingId, { allowQuiet: false, retry: false, now, token: null });
  assert.equal(backend.called("create-order"), 1);
  assert.equal(mealStatusFor(now, config, store), null);
  const line = formatStatusline({
    now,
    config,
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: store.readPickup(),
    pickupStaleMs: 120_000,
    meal: mealStatusFor(now, config, store),
  });
  assert.match(line, /取餐/);
  assert.equal(line.includes("午饭"), false);
});

test("meal commands change the clock and the weekend switch", () => {
  const { root, store } = home();
  assert.match(mealCommand(root, ["on"]), /饭点提醒已开/);
  assert.match(mealCommand(root, ["lunch", "12:30"]), /12:30/);
  assert.match(mealCommand(root, ["dinner", "19:00"]), /19:00/);
  assert.match(mealCommand(root, ["weekends", "on"]), /周末也会/);
  assert.match(mealCommand(root, []), /午饭 12:30/);
  assert.match(mealCommand(root, []), /晚饭 19:00/);
  const saved = mealsOn();
  saved.meals.lunch = "12:30";
  saved.meals.dinner = "19:00";
  saved.meals.weekends = true;
  const early = mealStatusFor(at(2026, 10, 12, 11, 50), saved, store);
  assert.equal(early, null);
  assert.equal(mealStatusFor(at(2026, 10, 12, 12, 15), saved, store)?.phrase, "午饭时间");
  assert.equal(mealStatusFor(at(2026, 10, 10, 12, 15), saved, store)?.phrase, "午饭时间");
});

test("statusline only says confirm when a priced request is waiting", () => {
  const now = at(2026, 10, 12, 11, 50);
  const meal = {
    slot: "lunch" as const,
    ymd: "2026-10-12",
    phrase: "午饭时间",
    arriveHm: "12:02",
    verb: "可取" as const,
    quoteCents: null as number | null,
    pendingId: null as string | null,
    prepMinutes: 20,
    prepSource: "default" as const,
    note: null as string | null,
  };
  const input = {
    now,
    config: mealsOn(),
    session: { windows: [], durationMs: null },
    plan: null,
    pickup: null,
    pickupStaleMs: 120_000,
    meal,
  };
  const missing = formatStatusline({ ...input, tokenMissing: true });
  assert.match(missing, /午饭时间/);
  assert.match(missing, /读不到 Token/);
  assert.match(missing, /\btoken\b/);
  assert.equal(missing.includes("现在确认"), false);
  const failed = formatStatusline({
    ...input,
    tokenMissing: false,
    meal: { ...meal, note: "常点里有这个时段不卖的餐品（比如早餐款），重新跑 init 换一份" },
  });
  assert.match(failed, /核价没成功/);
  assert.match(failed, /\bplan\b/);
  assert.equal(failed.includes("现在确认"), false);
  const waiting = formatStatusline({ ...input, tokenMissing: false });
  assert.equal(waiting, "mcd · 午饭时间 · 起来吃一点");
  assert.equal(waiting.includes("现在确认"), false);
  const lost = formatStatusline({
    ...input,
    tokenMissing: true,
    meal: { ...meal, quoteCents: 3650, pendingId: "7f3a2c1b" },
  });
  assert.match(lost, /读不到 Token/);
  assert.equal(lost.includes("现在确认"), false);
  assert.equal(lost.includes("7f3a2c1b"), false);
  assert.equal(lost.includes("已核价"), false);
});

test("a missing token is explained once, and a later hook can still price", async () => {
  const { store } = home();
  const config = mealsOn();
  const now = at(2026, 10, 12, 11, 50);
  const first = await runHook({ raw: {}, caller: null, store, config, now, prepare: false, tokenMissing: true });
  assert.match(first, /读不到 Token/);
  assert.match(first, /\btoken\b/);
  assert.equal(first.includes("现在确认"), false);
  const second = await runHook({ raw: {}, caller: null, store, config, now, prepare: false, tokenMissing: true });
  assert.equal(second, "");
  const backend = new FixtureBackend();
  const priced = await runHook({ raw: {}, caller: backend, store, config, now, prepare: true, tokenMissing: false });
  assert.match(priced, /现在确认的话/);
  assert.match(priced, /¥36\.50/);
  assert.equal(backend.called("create-order"), 0);
  const line = formatStatusline({
    now,
    config,
    session: { windows: [], durationMs: null },
    plan: store.readPlan(),
    pickup: null,
    pickupStaleMs: 120_000,
    meal: mealStatusFor(now, config, store),
    tokenMissing: false,
  });
  assert.match(line, /现在确认，约 12:05 可取/);
  assert.match(line, /确认 /);
});

test("a priced meal stops offering confirm when the token is gone", async () => {
  const { store } = home();
  const config = mealsOn();
  const now = at(2026, 10, 12, 11, 50);
  const backend = new FixtureBackend();
  const priced = await runHook({ raw: {}, caller: backend, store, config, now, prepare: true, tokenMissing: false });
  assert.match(priced, /现在确认的话/);
  const lost = await runHook({ raw: {}, caller: null, store, config, now, prepare: false, tokenMissing: true });
  assert.match(lost, /读不到 Token/);
  assert.equal(lost.includes("现在确认"), false);
  assert.equal(lost.includes("confirm"), false);
  const line = formatStatusline({
    now,
    config,
    session: { windows: [], durationMs: null },
    plan: store.readPlan(),
    pickup: null,
    pickupStaleMs: 120_000,
    meal: mealStatusFor(now, config, store),
    tokenMissing: true,
  });
  assert.match(line, /读不到 Token/);
  assert.equal(line.includes("现在确认"), false);
  assert.equal(line.includes("确认 "), false);
});
