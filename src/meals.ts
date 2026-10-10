import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import { loadConfig, modifyConfig, placeholderConfig } from "./config.js";
import { cnyToCents, moneyDecision, validateCreateOrder } from "./money.js";
import type { ToolCaller } from "./mcp/types.js";
import { orderArgsFromConfig, quoteCreateOrder } from "./order-flow.js";
import type { HomeStore, MealRecord, MealSlotId } from "./store.js";
import { formatHm, isQuietHour, parseHm, zonedInstant, zonedParts } from "./time.js";
import { UserError } from "./user-error.js";

export interface MealStatus {
  slot: MealSlotId;
  ymd: string;
  phrase: string;
  arriveHm: string;
  verb: "可取" | "送达";
  quoteCents: number | null;
  pendingId: string | null;
  prepMinutes: number;
  prepSource: "mcp" | "default";
}

interface MealWindow {
  slot: MealSlotId;
  ymd: string;
  target: Date;
  start: Date;
  end: Date;
}

const SLOT_COPY: Record<MealSlotId, { label: string; phrase: string }> = {
  lunch: { label: "午饭", phrase: "午饭时间" },
  dinner: { label: "晚饭", phrase: "晚饭时间" },
};

export function mealStatusFor(now: Date, config: AppConfig, store: HomeStore): MealStatus | null {
  const window = currentWindow(now, config, store);
  if (!window) return null;
  const record = store.readMeal(window.ymd, window.slot);
  if (record?.dismissed || record?.ordered) return null;
  if (record?.snoozeUntil && Date.parse(record.snoozeUntil) > now.getTime()) return null;
  const prep = displayPrep(config, record, store.readLearnedPrep());
  const arrive = zonedParts(new Date(now.getTime() + prep * 60_000), config.meals.timezone);
  return {
    slot: window.slot,
    ymd: window.ymd,
    phrase: SLOT_COPY[window.slot].phrase,
    arriveHm: arrive.hm,
    verb: arrivalVerb(config),
    quoteCents: record?.quoteCents ?? null,
    pendingId: usablePending(store, record, now),
    prepMinutes: prep,
    prepSource: record?.prepSource === "mcp" ? "mcp" : "default",
  };
}

export async function prepareMeal(input: {
  caller: ToolCaller;
  store: HomeStore;
  config: AppConfig;
  now: Date;
}): Promise<MealRecord | null> {
  const window = currentWindow(input.now, input.config, input.store);
  if (!window) return null;
  const existing = input.store.readMeal(window.ymd, window.slot);
  if (existing && freshQuote(existing, input.store, input.now)) return existing;
  const record = blankMeal(window.ymd, window.slot);
  record.label = input.config.usual?.label ?? null;
  record.nudged = existing?.nudged === true;
  record.dismissed = existing?.dismissed ?? null;
  record.ordered = existing?.ordered === true;
  record.snoozeUntil = existing?.snoozeUntil ?? null;
  const args = !placeholderConfig(input.config) ? orderArgsFromConfig(input.config) : null;
  if (!args) {
    record.note = "还没有配置常点餐品，这次只提醒，不猜测你要点什么。";
    record.prepMinutes = clampPrep(input.config.meals.prepMinutes);
    record.prepSource = "default";
    record.preparedAt = input.now.toISOString();
    input.store.writeMeal(record);
    return input.store.readMeal(window.ymd, window.slot);
  }
  const problem = validateCreateOrder(args, input.config.maxItemQuantity);
  let quoted: { cents: number | null; note: string; prepMinutes: number | null };
  try {
    quoted = await quoteCreateOrder(input.caller, args);
  } catch {
    quoted = { cents: null, prepMinutes: null, note: "这次没有核上价。先起来吃饭，程序没有下单。" };
  }
  record.prepMinutes = quoted.prepMinutes ?? clampPrep(input.config.meals.prepMinutes);
  record.prepSource = quoted.prepMinutes != null ? "mcp" : "default";
  if (quoted.prepMinutes != null) input.store.writeLearnedPrep(quoted.prepMinutes);
  record.quoteCents = quoted.cents;
  record.preparedAt = input.now.toISOString();
  record.note = quoted.note;
  if (!problem && quoted.cents != null) {
    const limit = moneyDecision({
      cents: quoted.cents,
      spentCents: input.store.spentTodayCents(input.now),
      maxOrderCents: cnyToCents(input.config.maxOrderCny),
      dailyLimitCents: cnyToCents(input.config.dailyLimitCny),
    });
    if (!limit.ok) record.note = limit.reason;
    else {
      const pending = input.store.createPending({
        tool: "create-order",
        args,
        quoteCents: quoted.cents,
        now: input.now,
        ttlMinutes: input.config.pendingTtlMinutes,
      });
      record.pendingId = pending.id;
      record.note = `${quoted.note}尚未下单。确认：mcd-cooldown confirm ${pending.id}`;
      input.store.appendAudit({
        at: input.now.toISOString(),
        tool: "create-order",
        decision: "hold",
        pendingId: pending.id,
        amountCents: quoted.cents,
        note: "按饭点准备的核价",
      });
    }
  } else if (problem) {
    record.note = `${quoted.note} ${problem}`.trim();
  }
  input.store.writeMeal(record);
  return input.store.readMeal(window.ymd, window.slot);
}

export function markOrderedMeal(store: HomeStore, config: AppConfig, now: Date, pendingId: string): void {
  const ymd = zonedParts(now, config.meals.timezone).ymd;
  const open = currentWindow(now, config, store);
  for (const slot of ["lunch", "dinner"] as const) {
    const record = store.readMeal(ymd, slot);
    const matches = record?.pendingId === pendingId;
    const active = open?.slot === slot && open.ymd === ymd;
    if (!matches && !active) continue;
    store.writeMeal({ ...(record ?? blankMeal(ymd, slot)), ordered: true, nudged: true });
  }
}

export function dismissMeal(
  store: HomeStore,
  config: AppConfig,
  now: Date,
  action: "ate" | "later" | "skip",
  slotArg?: string,
): string {
  if (!config.meals.enabled) throw new UserError("饭点提醒还没开。先运行 mcd-cooldown meals on");
  const slot = resolveSlot(now, config, store, slotArg);
  const ymd = zonedParts(now, config.meals.timezone).ymd;
  const existing = store.readMeal(ymd, slot) ?? blankMeal(ymd, slot);
  const label = SLOT_COPY[slot].label;
  if (action === "later") {
    store.writeMeal({
      ...existing,
      dismissed: null,
      snoozeUntil: new Date(now.getTime() + 15 * 60_000).toISOString(),
      nudged: false,
    });
    return `好，15 分钟后状态栏会再提一次${label}。`;
  }
  store.writeMeal({ ...existing, dismissed: action, snoozeUntil: null, nudged: true });
  if (action === "ate") return `记下了，今天${label}不再提醒。吃好再回来写。`;
  return `今天${label}先跳过。饿了再按自己的份量吃就好。`;
}

export function mealCommand(home: string, args: string[]): string {
  const action = args[0] ?? "status";
  if (action === "on" || action === "off") {
    const enabled = action === "on";
    const config = modifyConfig(home, (draft) => {
      draft.meals.enabled = enabled;
    });
    return enabled ? enabledText(config) : "饭点提醒已关。状态栏不再提午饭和晚饭。";
  }
  if (action === "lunch" || action === "dinner") {
    const parsed = args[1] ? parseHm(args[1]) : null;
    if (!parsed) throw new UserError("时间要写成 18:30 这种 24 小时格式。例如：mcd-cooldown meals dinner 18:30");
    const hm = formatHm(parsed.hour, parsed.minute);
    modifyConfig(home, (draft) => {
      draft.meals[action] = hm;
    });
    return `${SLOT_COPY[action].label}改到 ${hm}。提醒会按出餐时间提前出现在状态栏。`;
  }
  if (action === "weekends") {
    if (args[1] !== "on" && args[1] !== "off") throw new UserError("用法：mcd-cooldown meals weekends on");
    const weekends = args[1] === "on";
    modifyConfig(home, (draft) => {
      draft.meals.weekends = weekends;
    });
    return weekends ? "周末也会在状态栏提醒午饭和晚饭。" : "周末不再提醒。工作日保持原样。";
  }
  if (action === "notify") {
    if (args[1] !== "on" && args[1] !== "off") throw new UserError("用法：mcd-cooldown meals notify on");
    const notify = args[1] === "on";
    modifyConfig(home, (draft) => {
      draft.meals.notify = notify;
    });
    return notify
      ? "系统通知已开。只在 Stop hook 真正提醒的那一次尝试发送，没有常驻进程。"
      : "系统通知已关。提醒只留在状态栏。";
  }
  if (action === "prep") {
    const minutes = readMinutes(args[1], false);
    modifyConfig(home, (draft) => {
      draft.meals.prepMinutes = minutes;
    });
    return `没有出餐预计时，会在饭点前 ${minutes} 分钟提醒。`;
  }
  if (action === "linger") {
    const minutes = readMinutes(args[1], true);
    modifyConfig(home, (draft) => {
      draft.meals.lingerMinutes = minutes;
    });
    return `过了饭点 ${minutes} 分钟后，状态栏不再提这顿。`;
  }
  if (action === "status") return mealsStatusText(loadConfig(home, {}).config);
  throw new UserError("用法：mcd-cooldown meals on，或 meals lunch 12:00 / dinner 18:30 / weekends on");
}

export function mealsStatusText(config: AppConfig): string {
  const meals = config.meals;
  const lines = [
    `饭点提醒：${meals.enabled ? "开" : "关"}`,
    `时区：${meals.timezone}`,
    `午饭 ${meals.lunch} · 晚饭 ${meals.dinner}`,
    `周末：${meals.weekends ? "开" : "关"}`,
    `没有出餐时间时提前 ${meals.prepMinutes} 分钟，饭点后 ${meals.lingerMinutes} 分钟内还看得到`,
    `系统通知：${meals.notify ? "开" : "关"}`,
  ];
  if (!meals.enabled) lines.push("开启：mcd-cooldown meals on");
  return lines.join("\n");
}

export function spawnDesktopNotify(title: string, body: string): void {
  const command = process.platform === "darwin" ? "osascript" : "notify-send";
  const args =
    process.platform === "darwin"
      ? ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]
      : ["--urgency=low", title, body];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", () => undefined);
  } catch {
    return;
  }
}

function currentWindow(now: Date, config: AppConfig, store: HomeStore): MealWindow | null {
  if (!config.meals.enabled) return null;
  const timeZone = config.meals.timezone;
  if (isQuietHour(now, config.quietStartHour, config.quietEndHour, timeZone)) return null;
  const parts = zonedParts(now, timeZone);
  if ((parts.weekday === 0 || parts.weekday === 6) && !config.meals.weekends) return null;
  const learned = store.readLearnedPrep();
  const hits: MealWindow[] = [];
  for (const slot of ["lunch", "dinner"] as const) {
    const record = store.readMeal(parts.ymd, slot);
    const window = buildWindow(config, slot, parts.year, parts.month, parts.day, parts.ymd, leadFor(config, record, learned));
    if (!window) continue;
    if (now.getTime() >= window.start.getTime() && now.getTime() < window.end.getTime()) hits.push(window);
  }
  hits.sort((a, b) => Math.abs(a.target.getTime() - now.getTime()) - Math.abs(b.target.getTime() - now.getTime()));
  return hits[0] ?? null;
}

function buildWindow(
  config: AppConfig,
  slot: MealSlotId,
  year: number,
  month: number,
  day: number,
  ymd: string,
  lead: number,
): MealWindow | null {
  const clock = parseHm(slot === "lunch" ? config.meals.lunch : config.meals.dinner);
  if (!clock) return null;
  const target = zonedInstant(year, month, day, clock.hour, clock.minute, config.meals.timezone);
  return {
    slot,
    ymd,
    target,
    start: new Date(target.getTime() - lead * 60_000),
    end: new Date(target.getTime() + config.meals.lingerMinutes * 60_000),
  };
}

function leadFor(config: AppConfig, record: MealRecord | null, learned: number | null): number {
  if (record?.prepSource === "mcp" && record.prepMinutes != null) return clampPrep(record.prepMinutes);
  if (learned != null) return clampPrep(learned);
  return clampPrep(config.meals.prepMinutes);
}

function displayPrep(config: AppConfig, record: MealRecord | null, learned: number | null): number {
  if (record?.prepMinutes != null) return clampPrep(record.prepMinutes);
  if (learned != null) return clampPrep(learned);
  return clampPrep(config.meals.prepMinutes);
}

function usablePending(store: HomeStore, record: MealRecord | null, now: Date): string | null {
  if (!record?.pendingId) return null;
  const pending = store.readPending(record.pendingId);
  if (!pending || pending.status !== "pending") return null;
  if (Date.parse(pending.expiresAt) <= now.getTime()) return null;
  return pending.id;
}

function freshQuote(record: MealRecord, store: HomeStore, now: Date): boolean {
  if (!record.preparedAt) return false;
  if (now.getTime() - Date.parse(record.preparedAt) >= 20 * 60_000) return false;
  if (!record.pendingId) return true;
  return usablePending(store, record, now) != null;
}

function resolveSlot(now: Date, config: AppConfig, store: HomeStore, slotArg?: string): MealSlotId {
  const named = normalizeSlot(slotArg);
  if (named) return named;
  const open = currentWindow(now, config, store);
  if (open) return open.slot;
  const parts = zonedParts(now, config.meals.timezone);
  for (const slot of ["lunch", "dinner"] as const) {
    const window = buildWindow(config, slot, parts.year, parts.month, parts.day, parts.ymd, clampPrep(config.meals.prepMinutes));
    if (window && now.getTime() < window.end.getTime()) return slot;
  }
  throw new UserError("今天的饭点已经过了。要指定的话：mcd-cooldown ate lunch");
}

function normalizeSlot(value: string | undefined): MealSlotId | null {
  if (!value) return null;
  if (value === "lunch" || value === "午饭" || value === "午餐") return "lunch";
  if (value === "dinner" || value === "晚饭" || value === "晚餐") return "dinner";
  throw new UserError("饭点要写成 lunch 或 dinner");
}

function blankMeal(ymd: string, slot: MealSlotId): MealRecord {
  return {
    ymd,
    slot,
    nudged: false,
    dismissed: null,
    snoozeUntil: null,
    ordered: false,
    prepMinutes: null,
    prepSource: null,
    quoteCents: null,
    pendingId: null,
    label: null,
    preparedAt: null,
    note: null,
  };
}

function arrivalVerb(config: AppConfig): "可取" | "送达" {
  const beType = config.store?.beType;
  const orderType = config.store?.orderType;
  if (beType === 2 || beType === 6 || orderType === 2) return "送达";
  return "可取";
}

function clampPrep(minutes: number): number {
  if (!Number.isFinite(minutes)) return 20;
  return Math.min(180, Math.max(1, Math.trunc(minutes)));
}

function readMinutes(raw: string | undefined, allowZero: boolean): number {
  const minutes = Number(raw);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(minutes) || minutes < min || minutes > 180) {
    throw new UserError(`分钟数要在 ${min} 到 180 之间`);
  }
  return minutes;
}

function enabledText(config: AppConfig): string {
  const meals = config.meals;
  return [
    `饭点提醒已开。工作日午饭 ${meals.lunch}，晚饭 ${meals.dinner}。`,
    "到点前会按出餐时间出现在状态栏，先核价，你确认后才下单。",
    "周末默认不提醒。要连周末也看：mcd-cooldown meals weekends on",
    "关掉：mcd-cooldown meals off",
    "已吃、稍后、跳过：mcd-cooldown ate、later、skip",
  ].join("\n");
}
