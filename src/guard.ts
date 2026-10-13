import { isUnpricedWrite } from "./catalog.js";
import type { AppConfig } from "./config.js";
import { isRecord } from "./is.js";
import { cnyToCents, moneyDecision } from "./money.js";
import { annotateTool, GUARD_INSTRUCTIONS, holdMessage, quietLabel } from "./messages.js";
import { mealStatusFor } from "./meals.js";
import { orderArgsForUpstream, quoteCreateOrder } from "./order-flow.js";
import { toolMessage } from "./mcp/parse.js";
import type { RpcRequest, RpcResponse, ToolCaller, ToolResult } from "./mcp/types.js";
import { decideIntercept } from "./policy.js";
import { scrubSecrets } from "./redact.js";
import type { HomeStore } from "./store.js";
import { isQuietHour } from "./time.js";
import { userCommand } from "./user-command.js";
import { VERSION } from "./version.js";

export interface GuardDeps {
  caller: ToolCaller;
  store: HomeStore;
  config: AppConfig;
  token: string | null;
  now: () => Date;
}

export class Guard {
  constructor(private readonly deps: GuardDeps) {}

  async handle(message: RpcRequest): Promise<RpcResponse | null> {
    if (!message.method || message.method.startsWith("notifications/")) return null;
    const id = message.id ?? null;
    if (message.id === undefined) return null;
    try {
      const dispatched = await this.dispatch(message.method, message.params);
      if ("error" in dispatched) return { jsonrpc: "2.0", id, error: dispatched.error };
      return { jsonrpc: "2.0", id, result: scrubValue(dispatched.result, this.deps.token) };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id, error: { code: -32000, message: scrubSecrets(text, this.deps.token) } };
    }
  }

  private async dispatch(method: string, params: unknown): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    if (method === "initialize") return { result: initializeResult(params) };
    if (method === "ping") return { result: {} };
    if (method === "resources/list") return { result: { resources: [] } };
    if (method === "resources/templates/list") return { result: { resourceTemplates: [] } };
    if (method === "prompts/list") return { result: { prompts: [] } };
    if (method === "tools/list") return { result: { tools: await this.listTools() } };
    if (method === "tools/call") return { result: await this.callTool(params) };
    return { error: { code: -32601, message: `未知方法 ${method}` } };
  }

  private async listTools() {
    const upstream = await this.deps.caller.listTools();
    const tools = upstream.map((tool) => annotateTool(tool));
    tools.push({
      name: "cooldown-status",
      description: "读取本机额度倒计时、饭点提醒、核价备选和取餐进度。不会下单，也不会访问账户写接口。",
      inputSchema: { type: "object", properties: {} },
    });
    return tools;
  }

  private async callTool(params: unknown): Promise<ToolResult> {
    const record = isRecord(params) ? params : {};
    const name = typeof record.name === "string" ? record.name : "";
    const args = isRecord(record.arguments) ? record.arguments : isRecord(record.args) ? record.args : {};
    if (!name) return toolMessage("缺少工具名。", true);
    if (name === "cooldown-status") return toolMessage(this.localStatus(), false);

    const decision = decideIntercept(name, args, this.deps.config, this.deps.token);
    if (decision.kind === "deny") {
      this.deps.store.appendAudit({ at: this.deps.now().toISOString(), tool: name, decision: "deny", note: decision.reason });
      return toolMessage(decision.reason, true);
    }
    if (decision.kind === "hold") return this.hold(name, args);
    const upstream = await this.deps.caller.callTool(name, args);
    this.deps.store.appendAudit({ at: this.deps.now().toISOString(), tool: name, decision: "allow" });
    return upstream;
  }

  private async hold(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const now = this.deps.now();
    let quoteCents: number | null = null;
    let priceNote = "";
    if (name === "create-order") {
      const quoted = await quoteCreateOrder(this.deps.caller, args);
      quoteCents = quoted.cents;
      priceNote = quoted.note;
      if (quoteCents != null) {
        const limit = moneyDecision({
          cents: quoteCents,
          spentCents: this.deps.store.spentTodayCents(now),
          maxOrderCents: cnyToCents(this.deps.config.maxOrderCny),
          dailyLimitCents: cnyToCents(this.deps.config.dailyLimitCny),
        });
        if (!limit.ok) {
          this.deps.store.appendAudit({
            at: now.toISOString(),
            tool: name,
            decision: "deny",
            amountCents: quoteCents,
            note: limit.reason,
          });
          return toolMessage(limit.reason, true);
        }
      }
    }
    if (isUnpricedWrite(name)) {
      const used = this.deps.store.unpricedForwardsToday(now);
      if (used >= this.deps.config.maxUnpricedWrites) {
        const reason = `未执行。今日非餐饮写操作已有 ${used} 次，达到上限 ${this.deps.config.maxUnpricedWrites}。网关没有转发。`;
        this.deps.store.appendAudit({ at: now.toISOString(), tool: name, decision: "deny", note: reason });
        return toolMessage(reason, true);
      }
    }
    const storedArgs = name === "create-order" ? orderArgsForUpstream(args) : args;
    const pending = this.deps.store.createPending({
      tool: name,
      args: storedArgs,
      quoteCents,
      now,
      ttlMinutes: this.deps.config.pendingTtlMinutes,
    });
    this.deps.store.appendAudit({
      at: now.toISOString(),
      tool: name,
      decision: "hold",
      pendingId: pending.id,
      amountCents: quoteCents ?? undefined,
      note: "已拦截，等待本机确认",
    });
    const quiet = isQuietHour(now, this.deps.config.quietStartHour, this.deps.config.quietEndHour, this.deps.config.meals.timezone);
    return toolMessage(
      holdMessage({
        tool: name,
        id: pending.id,
        priceNote,
        quiet,
        keys: Object.keys(storedArgs),
        quietLabel: quietLabel(this.deps.config.quietStartHour, this.deps.config.quietEndHour),
      }),
      false,
    );
  }

  private localStatus(): string {
    const plan = this.deps.store.readPlan();
    const pickup = this.deps.store.readPickup();
    const quota = this.deps.store.readQuota();
    const lines = ["mcd-cooldown 本地状态。这不是订单。"];
    if (quota && quota.windows.length > 0) {
      const window = [...quota.windows].sort((a, b) => b.usedPercentage - a.usedPercentage)[0];
      if (window) lines.push(`额度 ${window.label} ${window.usedPercentage}%`);
    }
    if (plan) {
      lines.push(plan.headline);
      lines.push(plan.note);
      if (plan.pendingId) lines.push(`确认号 ${plan.pendingId}`);
    } else {
      lines.push(`还没有核价备选。可在本机运行 ${userCommand()} plan。`);
    }
    if (pickup && !pickup.terminal) lines.push(`取餐 ${pickup.code ?? pickup.orderId} · ${pickup.status}`);
    const meal = mealStatusFor(this.deps.now(), this.deps.config, this.deps.store);
    if (meal) lines.push(`${meal.phrase} · 现在确认，约 ${meal.arriveHm} ${meal.verb}`);
    return lines.join("\n");
  }
}

function initializeResult(params: unknown): Record<string, unknown> {
  const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
  const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : "2025-06-18";
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "mcd-cooldown", version: VERSION },
    instructions: GUARD_INSTRUCTIONS,
  };
}

function scrubValue(value: unknown, secret: string | null): unknown {
  if (typeof value === "string") return scrubSecrets(value, secret);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secret));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(authorization|token|password|secret)$/i.test(key)) out[key] = "[redacted]";
    else out[key] = scrubValue(item, secret);
  }
  return out;
}
