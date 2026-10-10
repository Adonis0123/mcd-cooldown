import { isUnpricedWrite } from "./catalog.js";
import type { AppConfig } from "./config.js";
import { cnyToCents, moneyDecision } from "./money.js";
import { businessFailed, textOf, unwrapPayload } from "./mcp/parse.js";
import type { ToolCaller, ToolResult } from "./mcp/types.js";
import { extractOrderId, extractPickup, isTerminalStatus, quoteCreateOrder } from "./order-flow.js";
import { decideIntercept } from "./policy.js";
import { scrubSecrets } from "./redact.js";
import type { HomeStore, PendingAction } from "./store.js";
import { markOrderedMeal } from "./meals.js";
import { isQuietHour } from "./time.js";
import { quietLabel } from "./messages.js";
import { UserError } from "./user-error.js";

export interface ConfirmOptions {
  allowQuiet: boolean;
  retry: boolean;
  now: Date;
  token: string | null;
}

export async function confirmPending(
  store: HomeStore,
  caller: ToolCaller,
  config: AppConfig,
  id: string,
  options: ConfirmOptions,
): Promise<string> {
  if (!/^[a-f0-9]{8}$/.test(id)) throw new UserError("请求号格式不对");
  const pending = store.readPending(id);
  if (!pending) throw new UserError("没有这笔待确认请求");
  if (pending.status === "done") {
    return `这笔请求已经确认过，不再重复提交。\n${pending.resultText ?? ""}`.trim();
  }
  if (pending.status === "denied") throw new UserError("这笔请求已经拒绝，没有提交");
  if (new Date(pending.expiresAt).getTime() <= options.now.getTime()) {
    throw new UserError("请求已过期，没有提交");
  }
  if (pending.status === "confirming" && !options.retry) {
    throw new UserError("上次确认可能已经发出。请先看 mcd-cooldown log，核对之后再加 --retry。不要盲目重试。");
  }
  if (isQuietHour(options.now, config.quietStartHour, config.quietEndHour, config.meals.timezone) && !options.allowQuiet) {
    throw new UserError(
      `现在是休息时段（北京时间 ${quietLabel(config.quietStartHour, config.quietEndHour)}）。可以先休息。确定要继续，请追加 --allow-quiet。尚未提交。`,
    );
  }
  const decision = decideIntercept(pending.tool, pending.args, config, options.token);
  if (decision.kind === "deny") throw new UserError(decision.reason);

  let amountCents: number | null = pending.quoteCents;
  if (pending.tool === "create-order") {
    const quoted = await quoteCreateOrder(caller, pending.args);
    if (quoted.cents == null) {
      throw new UserError(`${quoted.note} 已拒绝下单。`);
    }
    amountCents = quoted.cents;
    const limit = moneyDecision({
      cents: quoted.cents,
      spentCents: store.spentTodayCents(options.now),
      maxOrderCents: cnyToCents(config.maxOrderCny),
      dailyLimitCents: cnyToCents(config.dailyLimitCny),
    });
    if (!limit.ok) throw new UserError(limit.reason);
  } else if (isUnpricedWrite(pending.tool) && store.unpricedForwardsToday(options.now) >= config.maxUnpricedWrites) {
    throw new UserError(`未执行。今日非餐饮写操作已达到上限 ${config.maxUnpricedWrites}。`);
  }

  const confirming: PendingAction = { ...pending, status: "confirming", confirmingAt: options.now.toISOString(), quoteCents: amountCents };
  store.writePending(confirming);
  let result: ToolResult;
  try {
    result = await caller.callTool(pending.tool, pending.args);
  } catch (error) {
    store.writePending({ ...confirming, status: "pending" });
    const message = error instanceof Error ? error.message : String(error);
    store.appendAudit({
      at: options.now.toISOString(),
      tool: pending.tool,
      decision: "forward-failed",
      pendingId: pending.id,
      note: scrubSecrets(message, options.token).slice(0, 300),
    });
    throw new UserError(`提交失败，没有记为成功：${scrubSecrets(message, options.token)}`);
  }
  const payload = unwrapPayload(result);
  const failed = result.isError ? textOf(result).slice(0, 300) : businessFailed(payload);
  if (failed) {
    store.writePending({ ...confirming, status: "pending" });
    store.appendAudit({
      at: options.now.toISOString(),
      tool: pending.tool,
      decision: "forward-failed",
      pendingId: pending.id,
      note: scrubSecrets(failed, options.token).slice(0, 300),
    });
    throw new UserError(`麦当劳没有接受这次操作：${scrubSecrets(failed, options.token)}`);
  }
  const resultText = scrubSecrets(textOf(result), options.token).slice(0, 2000);
  const orderId = pending.tool === "create-order" ? extractOrderId(payload) : null;
  store.writePending({
    ...confirming,
    status: "done",
    resultText,
    quoteCents: amountCents,
    ...(orderId ? { orderId } : {}),
  });
  store.appendAudit({
    at: options.now.toISOString(),
    tool: pending.tool,
    decision: "forward",
    pendingId: pending.id,
    ...(amountCents != null && pending.tool === "create-order" ? { amountCents } : {}),
    note: "本机确认后已转发",
  });
  if (pending.tool === "create-order" && orderId) {
    const pickup = extractPickup(payload);
    store.writePickup({
      orderId,
      status: pickup.status,
      code: pickup.code,
      updatedAt: options.now.toISOString(),
      terminal: isTerminalStatus(pickup.status),
    });
    markOrderedMeal(store, config, options.now, pending.id);
  }
  return successText(pending.tool, resultText, orderId);
}

export function denyPending(store: HomeStore, id: string, now: Date): string {
  if (!/^[a-f0-9]{8}$/.test(id)) throw new UserError("请求号格式不对");
  const pending = store.readPending(id);
  if (!pending) throw new UserError("没有这笔待确认请求");
  if (pending.status === "done") throw new UserError("这笔请求已经提交，不能再拒绝");
  store.writePending({ ...pending, status: "denied" });
  store.appendAudit({ at: now.toISOString(), tool: pending.tool, decision: "deny", pendingId: id, note: "用户拒绝" });
  return "已拒绝，没有提交。";
}

function successText(tool: string, resultText: string, orderId: string | null): string {
  const lines = [`已确认并提交 ${tool}。`];
  if (orderId) {
    lines.push(`订单号：${orderId}`);
    lines.push("支付需要你自己完成，程序不会代付。");
    const url = /https:\/\/[^\s"]+/.exec(resultText)?.[0];
    if (url) lines.push(url);
    lines.push(`取餐进度：mcd-cooldown watch ${orderId}`);
    return lines.join("\n");
  }
  if (resultText.trim()) lines.push(resultText.slice(0, 500));
  return lines.join("\n");
}
