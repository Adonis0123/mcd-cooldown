import { asNumber, asText, isRecord } from "./is.js";

export function cnyToCents(cny: number): number {
  return Math.round(cny * 100);
}

export function formatYuanFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${yuan}.${frac}`;
}

export function extractCents(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  for (const key of ["price", "realPrice", "totalPrice", "payPrice", "realPayAmount"]) {
    const value = data[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 100_000_000) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed < 100_000_000) return parsed;
    }
  }
  return null;
}

export function moneyDecision(input: {
  cents: number;
  spentCents: number;
  maxOrderCents: number;
  dailyLimitCents: number;
}): { ok: true } | { ok: false; reason: string } {
  if (input.cents > input.maxOrderCents) {
    return {
      ok: false,
      reason: `未下单。核价 ¥${formatYuanFromCents(input.cents)} 超过单笔上限 ¥${formatYuanFromCents(input.maxOrderCents)}。可以少点一些再试。网关没有把下单转发给麦当劳。`,
    };
  }
  if (input.spentCents + input.cents > input.dailyLimitCents) {
    return {
      ok: false,
      reason: `未下单。加上这笔 ¥${formatYuanFromCents(input.cents)} 后，将超过今日上限 ¥${formatYuanFromCents(input.dailyLimitCents)}（今日已确认 ¥${formatYuanFromCents(input.spentCents)}）。`,
    };
  }
  return { ok: true };
}

export function totalQuantity(args: Record<string, unknown>): number | null {
  if (!Array.isArray(args.items)) return null;
  let sum = 0;
  for (const item of args.items) {
    if (!isRecord(item)) return null;
    const quantity = asNumber(item.quantity);
    sum += quantity == null ? 1 : quantity;
  }
  return sum;
}

/** 得来速 5、外送 2、团餐 6 才有 beCode。到店自取 1 不传。 */
export function beCodeRequired(beType: number): boolean {
  return beType === 2 || beType === 5 || beType === 6;
}

export function validateCreateOrder(args: Record<string, unknown>, maxItemQuantity: number): string | null {
  const beType = asNumber(args.beType);
  const required = ["storeCode", "beType", "items"];
  if (beType != null && beCodeRequired(beType)) required.push("beCode");
  const missing: string[] = [];
  for (const key of required) {
    if (args[key] == null || args[key] === "") missing.push(key);
  }
  if (missing.length > 0) {
    return `未下单。create-order 缺少 ${missing.join("、")}。网关没有转发。`;
  }
  if (!Array.isArray(args.items) || args.items.length === 0) {
    return "未下单。create-order 的 items 必须是非空数组。网关没有转发。";
  }
  for (const item of args.items) {
    if (!isRecord(item) || !asText(item.productCode)) {
      return "未下单。items 里的每一项都需要 productCode。网关没有转发。";
    }
  }
  const quantity = totalQuantity(args);
  if (quantity == null || quantity <= 0) {
    return "未下单。份数需要是正数。网关没有转发。";
  }
  if (quantity > maxItemQuantity) {
    return `未下单。这份请求共 ${quantity} 份，超过单笔份数上限 ${maxItemQuantity}。网关没有转发。`;
  }
  if (beType === 1 || beType === 5) {
    if (!asText(args.takeWayCode)) {
      return "未下单。到店取餐需要 takeWayCode。请先看 calculate-price 返回的 takeWayList，把用户选定的编码放进参数。网关没有转发。";
    }
  }
  if (beType === 2 || beType === 6) {
    if (!asText(args.addressId)) {
      return "未下单。外送需要 addressId。网关没有转发。";
    }
  }
  if (beType === 6 && !asText(args.gmServiceCode)) {
    return "未下单。企业团餐需要 gmServiceCode。网关没有转发。";
  }
  return null;
}
