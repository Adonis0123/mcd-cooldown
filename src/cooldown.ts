import type { AppConfig } from "./config.js";
import { placeholderConfig } from "./config.js";
import { mealStatusFor, prepareMeal, type MealStatus } from "./meals.js";
import { cnyToCents, formatYuanFromCents, moneyDecision, validateCreateOrder } from "./money.js";
import { MEAL_UNAVAILABLE_HINT, payloadRecord, unwrapPayload } from "./mcp/parse.js";
import type { ToolCaller } from "./mcp/types.js";
import { orderArgsFromConfig, quoteCreateOrder } from "./order-flow.js";
import { asText } from "./is.js";
import { describeSchedule } from "./schedule.js";
import { extractSession, formatWindow, primaryWindow, type SessionSignals } from "./session.js";
import type { HomeStore, PickupState, PlanState, QuotaSnapshot } from "./store.js";
import { formatRemaining, isQuietHour, zonedParts } from "./time.js";
import { userCommand } from "./user-command.js";

export interface StatusInput {
  now: Date;
  config: AppConfig;
  session: SessionSignals;
  plan: PlanState | null;
  pickup: PickupState | null;
  pickupStaleMs: number;
  meal?: MealStatus | null;
}

export function formatStatusline(input: StatusInput): string {
  const quiet = isQuietHour(input.now, input.config.quietStartHour, input.config.quietEndHour, input.config.meals.timezone);
  const primary = primaryWindow(input.session.windows);
  const high = primary != null && primary.usedPercentage >= input.config.quotaThreshold;
  const remaining = primary?.resetsAtMs != null ? formatRemaining(primary.resetsAtMs - input.now.getTime()) : null;
  const quote = input.plan?.quoteCents != null ? `已核价 ¥${formatYuanFromCents(input.plan.quoteCents)}` : null;
  const pickup = input.pickup && !input.pickup.terminal ? input.pickup : null;
  const stale = pickup != null && input.now.getTime() - Date.parse(pickup.updatedAt) > input.pickupStaleMs;
  const longMinutes =
    input.session.durationMs != null && input.session.durationMs >= input.config.longSessionMinutes * 60_000
      ? Math.round(input.session.durationMs / 60_000)
      : null;
  const meal = quiet ? null : input.meal ?? null;
  const segs: string[] = [];
  if (pickup) {
    segs.push(`取餐 ${pickup.code ?? pickup.orderId} · ${pickup.status}`);
    if (stale) segs.push("运行 watch 刷新");
    if (high && primary) segs.push(formatWindow(primary));
  } else if (quiet) {
    segs.push("夜深了，先休息");
    if (quote) segs.push(quote);
    segs.push("适量即可");
    if (input.plan?.pendingId) segs.push("确认需 --allow-quiet");
  } else if (meal && high && primary) {
    pushMeal(segs, meal, false);
    segs.push(formatWindow(primary));
    if (remaining) segs.push(`${remaining}后恢复`);
  } else if (meal) {
    pushMeal(segs, meal, true);
  } else if (high && primary) {
    segs.push(formatWindow(primary));
    if (remaining) segs.push(`${remaining}后恢复`);
    if (quote) segs.push(quote);
    if (input.plan?.pendingId) segs.push(`确认 ${input.plan.pendingId}`);
  } else if (longMinutes != null) {
    segs.push(`已连续 ${longMinutes} 分钟`);
    segs.push("起来活动一下");
  } else if (primary) {
    segs.push(formatWindow(primary));
  } else {
    segs.push("待命");
  }
  return ["mcd", ...segs].join(" · ").replace(/\s*\n\s*/g, " ");
}

function overlayMeal(
  prior: MealStatus,
  saved: { quoteCents: number | null; pendingId: string | null; prepMinutes: number | null; prepSource: "mcp" | "default" | null; note?: string | null } | null,
  now: Date,
  timeZone: string,
): MealStatus {
  if (!saved) return prior;
  const prep = saved.prepMinutes ?? prior.prepMinutes;
  return {
    ...prior,
    quoteCents: saved.quoteCents,
    pendingId: saved.pendingId,
    prepMinutes: prep,
    prepSource: saved.prepSource === "mcp" ? "mcp" : prior.prepSource,
    arriveHm: zonedParts(new Date(now.getTime() + prep * 60_000), timeZone).hm,
    note: saved.note ?? prior.note,
  };
}

function pushMeal(segs: string[], meal: MealStatus, withRest: boolean): void {
  segs.push(meal.phrase);
  if (withRest) segs.push("起来吃一点");
  segs.push(`现在确认，约 ${meal.arriveHm} ${meal.verb}`);
  if (meal.quoteCents != null) segs.push(`已核价 ¥${formatYuanFromCents(meal.quoteCents)}`);
  if (meal.pendingId) segs.push(`确认 ${meal.pendingId}`);
}

export async function preparePlan(input: {
  caller: ToolCaller;
  store: HomeStore;
  config: AppConfig;
  now: Date;
  session: SessionSignals;
  allowQuiet?: boolean;
}): Promise<PlanState> {
  const primary = primaryWindow(input.session.windows);
  const schedule = describeSchedule(input.now, primary?.resetsAtMs ?? null, input.config);
  let clock: string | null = null;
  try {
    const time = await input.caller.callTool("now-time-info", {});
    const data = payloadRecord(unwrapPayload(time));
    clock = asText(data.formatted) ?? asText(data.date);
  } catch {
    clock = null;
  }
  let quoteCents: number | null = null;
  let pendingId: string | null = null;
  let note = "还没有配置常点餐品，这次只提醒，不猜测你要点什么。";
  const args = !placeholderConfig(input.config) ? orderArgsFromConfig(input.config) : null;
  if (args) {
    const problem = validateCreateOrder(args, input.config.maxItemQuantity);
    const quoted = await quoteCreateOrder(input.caller, args);
    quoteCents = quoted.cents;
    if (problem) {
      note = `${quoted.note} ${problem}`.trim();
    } else if (quoteCents == null) {
      note = quoted.note;
    } else {
      const limit = moneyDecision({
        cents: quoteCents,
        spentCents: input.store.spentTodayCents(input.now),
        maxOrderCents: cnyToCents(input.config.maxOrderCny),
        dailyLimitCents: cnyToCents(input.config.dailyLimitCny),
      });
      if (!limit.ok) note = limit.reason;
      else if (isQuietHour(input.now, input.config.quietStartHour, input.config.quietEndHour, input.config.meals.timezone) && !input.allowQuiet) {
        note = `${quoted.note}现在是休息时段，只保留核价，不生成待确认单。仍要准备请执行 ${userCommand()} plan --allow-quiet。`;
      } else {
        const pending = input.store.createPending({
          tool: "create-order",
          args,
          quoteCents,
          now: input.now,
          ttlMinutes: input.config.pendingTtlMinutes,
        });
        pendingId = pending.id;
        note = `${quoted.note}尚未下单。确认：${userCommand()} confirm ${pending.id}`;
        input.store.appendAudit({
          at: input.now.toISOString(),
          tool: "create-order",
          decision: "hold",
          pendingId: pending.id,
          amountCents: quoteCents,
          note: "按额度恢复时间准备的核价",
        });
      }
    }
  }
  const plan: PlanState = {
    preparedAt: input.now.toISOString(),
    headline: schedule.headline,
    hint: schedule.hint,
    quiet: schedule.quiet,
    quoteCents,
    label: input.config.usual?.label ?? null,
    pendingId,
    note,
    clock,
    resetAtMs: schedule.resetAtMs,
  };
  input.store.writePlan(plan);
  return plan;
}

export async function runHook(input: {
  raw: unknown;
  caller: ToolCaller | null;
  store: HomeStore;
  config: AppConfig;
  now: Date;
  prepare: boolean;
  notify?: (title: string, body: string) => void;
}): Promise<string> {
  const session = mergeSession(extractSession(input.raw), input.store.readQuota());
  if (session.windows.length > 0 || session.durationMs != null) {
    input.store.writeQuota({
      savedAt: input.now.toISOString(),
      windows: session.windows,
      durationMs: session.durationMs,
    });
  }
  const primary = primaryWindow(session.windows);
  const high = primary != null && primary.usedPercentage >= input.config.quotaThreshold;
  const quiet = isQuietHour(input.now, input.config.quietStartHour, input.config.quietEndHour, input.config.meals.timezone);
  const long = session.durationMs != null && session.durationMs >= input.config.longSessionMinutes * 60_000;
  let meal = quiet ? null : mealStatusFor(input.now, input.config, input.store);
  const nudged = meal != null && input.store.readMeal(meal.ymd, meal.slot)?.nudged === true;
  if (meal && nudged) return "";
  const mealDue = meal != null;
  const cooldownDue = high || quiet || long;
  if (!mealDue && !cooldownDue) return "";
  if (!mealDue) {
    const signature = `${quiet}|${high}|${primary?.resetsAtMs ?? "none"}|${long}`;
    const last = input.store.readHookNotice();
    if (last && last.signature === signature && input.now.getTime() - Date.parse(last.at) < 30 * 60_000) return "";
  }
  let plan = input.store.readPlan();
  const fresh = plan != null && input.now.getTime() - Date.parse(plan.preparedAt) < 20 * 60_000;
  if (input.prepare && input.caller && meal) {
    const prior = meal;
    await prepareMeal({ caller: input.caller, store: input.store, config: input.config, now: input.now });
    const refreshed = mealStatusFor(input.now, input.config, input.store);
    const saved = input.store.readMeal(prior.ymd, prior.slot);
    meal = refreshed ?? overlayMeal(prior, saved, input.now, input.config.meals.timezone);
    if (saved?.pendingId && meal) {
      const schedule = describeSchedule(input.now, primary?.resetsAtMs ?? null, input.config);
      plan = {
        preparedAt: saved.preparedAt ?? input.now.toISOString(),
        headline: schedule.headline,
        hint: schedule.hint,
        quiet: schedule.quiet,
        quoteCents: saved.quoteCents,
        label: saved.label,
        pendingId: saved.pendingId,
        note: saved.note ?? "",
        clock: null,
        resetAtMs: schedule.resetAtMs,
      };
      input.store.writePlan(plan);
    }
  } else if (input.prepare && input.caller && (high || quiet) && !fresh) {
    plan = await preparePlan({ caller: input.caller, store: input.store, config: input.config, now: input.now, session });
  }
  if (meal) {
    const saved = input.store.readMeal(meal.ymd, meal.slot);
    if (saved) input.store.writeMeal({ ...saved, nudged: true });
  } else {
    const signature = `${quiet}|${high}|${primary?.resetsAtMs ?? "none"}|${long}`;
    input.store.writeHookNotice({ at: input.now.toISOString(), signature });
  }
  const text = hookText(input.config, input.now, session, plan, meal);
  if (meal && input.config.meals.notify) input.notify?.("该起来吃饭了", text);
  return text;
}

function priceSentence(cents: number | null, note: string | null | undefined, empty: string): string {
  if (cents != null) return `已按你保存的份量核价 ¥${formatYuanFromCents(cents)}，尚未下单。`;
  if (note?.includes(MEAL_UNAVAILABLE_HINT)) return `${MEAL_UNAVAILABLE_HINT}程序没有下单。`;
  return empty;
}

function hookText(config: AppConfig, now: Date, session: SessionSignals, plan: PlanState | null, meal: MealStatus | null): string {
  const cmd = userCommand();
  const primary = primaryWindow(session.windows);
  const schedule = describeSchedule(now, primary?.resetsAtMs ?? null, config);
  const price = priceSentence(plan?.quoteCents ?? null, plan?.note, "这次没有生成核价。");
  if (schedule.quiet) {
    const confirm = plan?.pendingId
      ? `已有待确认单 ${plan.pendingId}，提交时需要加上 --allow-quiet。`
      : `这个时段不生成待确认单。仍要准备请运行 ${cmd} plan --allow-quiet。`;
    return `已经比较晚了，建议先休息。${price}${confirm}`;
  }
  if (meal) {
    const mealPrice = priceSentence(meal.quoteCents, meal.note, "这次没有生成核价。先起来吃饭就好。");
    const confirm = meal.pendingId ? `要下单请在本机执行 ${cmd} confirm ${meal.pendingId}。` : "";
    const quota = primary && primary.usedPercentage >= config.quotaThreshold ? `额度${schedule.headline}。` : "";
    return `${meal.phrase}到了，起来吃一点。现在确认的话，大约 ${meal.arriveHm} ${meal.verb}。${quota}${mealPrice}${confirm}这顿可以记成已吃、稍后再说或今天跳过：${cmd} ate、later、skip。`;
  }
  if (primary && primary.usedPercentage >= config.quotaThreshold) {
    const confirm = plan?.pendingId ? `要下单请在本机执行 ${cmd} confirm ${plan.pendingId}。` : "";
    return `额度${schedule.headline}。${schedule.hint}${price}${confirm}`.replace(/\s+/g, " ").trim();
  }
  return `这轮已经写了一段时间，起来活动一下。${price}程序不会自动下单。`;
}

export function mergeSession(current: SessionSignals, saved: QuotaSnapshot | null): SessionSignals {
  if (current.windows.length > 0 || current.durationMs != null) return current;
  if (!saved) return current;
  return {
    windows: saved.windows.flatMap((window) => {
      if (window.key !== "five_hour" && window.key !== "seven_day" && window.key !== "spend_limit") return [];
      return [
        {
          key: window.key,
          label: window.label,
          usedPercentage: window.usedPercentage,
          resetsAtMs: window.resetsAtMs,
        },
      ];
    }),
    durationMs: saved.durationMs,
  };
}

export function rememberSession(store: HomeStore, raw: unknown, now: Date): SessionSignals {
  const session = extractSession(raw);
  if (session.windows.length > 0 || session.durationMs != null) {
    store.writeQuota({ savedAt: now.toISOString(), windows: session.windows, durationMs: session.durationMs });
  }
  return mergeSession(session, store.readQuota());
}
