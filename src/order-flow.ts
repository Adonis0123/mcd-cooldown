import type { AppConfig } from "./config.js";
import { asNumber, isRecord } from "./is.js";
import { extractCents, formatYuanFromCents } from "./money.js";
import { businessFailed, textOf, unwrapPayload } from "./mcp/parse.js";
import type { ToolCaller } from "./mcp/types.js";

export function calculatePriceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const beType = asNumber(args.beType) ?? 1;
  const orderType = asNumber(args.orderType) ?? (beType === 2 || beType === 6 ? 2 : 1);
  const priceArgs: Record<string, unknown> = {
    storeCode: args.storeCode,
    beCode: args.beCode,
    beType,
    orderType,
    items: args.items,
  };
  for (const key of ["reservationDate", "gmServiceCode", "addressId"]) {
    if (args[key] != null && args[key] !== "") priceArgs[key] = args[key];
  }
  return priceArgs;
}

export function orderArgsFromConfig(config: AppConfig): Record<string, unknown> | null {
  if (!config.store || !config.usual || config.usual.items.length === 0) return null;
  const args: Record<string, unknown> = {
    storeCode: config.store.storeCode,
    beCode: config.store.beCode,
    beType: config.store.beType,
    orderType: config.store.orderType,
    items: config.usual.items.map((item) => ({ productCode: item.productCode, quantity: item.quantity })),
  };
  if (config.store.takeWayCode) args.takeWayCode = config.store.takeWayCode;
  if (config.store.addressId) args.addressId = config.store.addressId;
  if (config.store.gmServiceCode) args.gmServiceCode = config.store.gmServiceCode;
  return args;
}

export async function quoteCreateOrder(
  caller: ToolCaller,
  args: Record<string, unknown>,
): Promise<{ cents: number | null; note: string; prepMinutes: number | null }> {
  if (!Array.isArray(args.items) || args.items.length === 0) {
    return { cents: null, prepMinutes: null, note: "缺少 items，无法核价。" };
  }
  const result = await caller.callTool("calculate-price", calculatePriceArgs(args));
  if (result.isError) {
    return { cents: null, prepMinutes: null, note: `calculate-price 返回错误：${textOf(result).slice(0, 180)}` };
  }
  const payload = unwrapPayload(result);
  const failed = businessFailed(payload);
  if (failed) return { cents: null, prepMinutes: null, note: `核价未成功：${failed}` };
  const cents = extractCents(payload);
  const prepMinutes = extractPrepMinutes(payload);
  if (cents == null) {
    return { cents: null, prepMinutes, note: "核价结果里没有可识别的整数金额（分）。确认时核不到价就不会下单。" };
  }
  return { cents, prepMinutes, note: `核价 ¥${formatYuanFromCents(cents)}（calculate-price，金额单位已从分换算）。` };
}

export function extractPrepMinutes(payload: unknown): number | null {
  const best = { score: 0, minutes: null as number | null };
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      const score = prepKeyScore(key);
      const minutes = score > 0 ? asPrepMinutes(inner) : null;
      if (minutes != null && score > best.score) {
        best.score = score;
        best.minutes = minutes;
      }
      if (isRecord(inner) || Array.isArray(inner)) visit(inner, depth + 1);
    }
  };
  const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  visit(root, 0);
  return best.minutes;
}

function prepKeyScore(key: string): number {
  const norm = key.toLowerCase().replace(/[^a-z]/g, "");
  if (norm.includes("price") || norm.includes("amount") || norm.includes("fee")) return 0;
  if (
    [
      "expectminutes",
      "expectedminutes",
      "estimateminutes",
      "estimatedminutes",
      "prepminutes",
      "makeminutes",
      "waitminutes",
      "deliveryminutes",
      "expectdeliverytime",
      "estimateddeliverytime",
      "deliverytime",
      "maketime",
      "waittime",
      "preptime",
      "readyinminutes",
    ].includes(norm)
  ) {
    return 3;
  }
  if (norm.includes("minute")) return 2;
  if (
    (norm.includes("deliver") || norm.includes("expect") || norm.includes("make") || norm.includes("wait") || norm.includes("prep") || norm.includes("ready")) &&
    norm.endsWith("time")
  ) {
    return 2;
  }
  return 0;
}

function asPrepMinutes(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 180) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const zh = /^(\d{1,3})\s*分钟$/.exec(trimmed);
  if (zh) {
    const minutes = Number(zh[1]);
    return minutes >= 1 && minutes <= 180 ? minutes : null;
  }
  if (/^\d{1,3}$/.test(trimmed)) {
    const minutes = Number(trimmed);
    return minutes >= 1 && minutes <= 180 ? minutes : null;
  }
  return null;
}

export function extractOrderId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  for (const key of ["orderId", "orderNo", "orderID"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function extractPickup(payload: unknown): { orderId: string | null; status: string; code: string | null } {
  if (!isRecord(payload)) return { orderId: null, status: "状态未知", code: null };
  const data = isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
  const orderId = extractOrderId(data);
  const status =
    firstText(data, ["statusDesc", "orderStatusDesc", "statusName", "orderStatusText"]) ??
    firstText(data, ["status", "orderStatus"]) ??
    "状态未知";
  const code = firstText(data, ["pickupCode", "takeMealCode", "pickUpCode", "queueCode", "fetchCode"]);
  return { orderId, status, code };
}

export function isTerminalStatus(status: string): boolean {
  return /已完成|已取消|已取餐|已关闭|取消成功/.test(status);
}

function firstText(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}
