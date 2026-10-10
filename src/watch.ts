import { extractPickup, isTerminalStatus } from "./order-flow.js";
import { unwrapPayload } from "./mcp/parse.js";
import type { ToolCaller } from "./mcp/types.js";
import type { HomeStore } from "./store.js";
import { UserError } from "./user-error.js";

export async function watchOrder(caller: ToolCaller, store: HomeStore, orderId: string, now: Date): Promise<string> {
  if (!/^[A-Za-z0-9-]{4,64}$/.test(orderId)) throw new UserError("订单号格式不对");
  const result = await caller.callTool("query-order", { orderId });
  const pickup = extractPickup(unwrapPayload(result));
  const state = {
    orderId: pickup.orderId ?? orderId,
    status: pickup.status,
    code: pickup.code,
    updatedAt: now.toISOString(),
    terminal: isTerminalStatus(pickup.status),
  };
  store.writePickup(state);
  const code = state.code ? ` · 取餐码 ${state.code}` : "";
  return `订单 ${state.orderId} · ${state.status}${code}`;
}
