import { CATALOG } from "../catalog.js";
import { isRecord } from "../is.js";
import { businessFailed } from "./parse.js";
import type { ToolCaller, ToolDefinition, ToolResult } from "./types.js";

export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * 合成样例，形状对齐公开文档里的麦当劳 MCP 工具返回。
 * 这里没有真实账户、订单、地址或 Token，也不能当作官方实时数据。
 */
export class FixtureBackend implements ToolCaller {
  readonly calls: RecordedCall[] = [];
  priceCents = 3650;
  prepMinutes: number | null = 15;
  private orderCount = 0;

  async listTools(): Promise<ToolDefinition[]> {
    return CATALOG.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", additionalProperties: true },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    const data = this.payload(name, args);
    if (data && isRecord(data) && data.error === true) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ success: false, code: 400, message: data.message ?? "样例服务拒绝了这次调用" }) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, code: 200, message: "ok", data, sample: true }),
        },
      ],
    };
  }

  called(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  private payload(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "now-time-info":
        return {
          timestamp: Date.parse("2026-10-10T13:20:00.000Z"),
          formatted: "2026-10-10 21:20:00",
          date: "2026-10-10",
          dayOfWeek: "星期六",
          timezone: "Asia/Shanghai",
        };
      case "campaign-calendar":
        return { markdown: "当月示例活动：程序员节门店互动（样例数据，不是实时活动）。" };
      case "list-nutrition-foods":
        return "name|kcal\n示例汉堡|500\n示例玉米杯|80\n";
      case "query-nearby-stores":
        return {
          stores: [
            {
              storeName: "麦当劳示例餐厅",
              storeCode: "SAMPLE-STORE",
              beCode: "SAMPLE-BE",
              address: "示例路 1 号（样例，不是真实门店）",
            },
          ],
        };
      case "query-meals":
        return { items: [{ productCode: "SAMPLE-001", name: "示例套餐", price: "36.50" }] };
      case "calculate-price": {
        const price = this.priceFor(args);
        const data: Record<string, unknown> = {
          price,
          productPrice: price,
          deliveryPrice: 0,
          takeWayList: [
            { takeWayCode: "1", name: "店内就餐" },
            { takeWayCode: "2", name: "外带" },
          ],
        };
        if (this.prepMinutes != null) data.expectMinutes = this.prepMinutes;
        return data;
      }
      case "create-order": {
        this.orderCount += 1;
        return {
          orderId: `SAMPLE-ORDER-${this.orderCount}`,
          payH5Url: "https://example.invalid/mcd-cooldown/sample-pay",
          statusDesc: "待支付",
        };
      }
      case "query-order": {
        const orderId = typeof args.orderId === "string" ? args.orderId : "SAMPLE-ORDER-1";
        if (orderId.includes("DONE")) {
          return { orderId, statusDesc: "已完成", pickupCode: "A102" };
        }
        return { orderId, statusDesc: "制作中", pickupCode: "A102" };
      }
      case "draw-lottery":
        return { win: false, message: "样例抽奖未连接官方服务" };
      case "cancel-order":
      case "auto-bind-coupons":
      case "mall-create-order":
      case "party-order-create":
      case "delivery-create-address":
        return { accepted: true, sample: true };
      default:
        if (!CATALOG.some((tool) => tool.name === name)) {
          return { error: true, message: `样例服务没有工具 ${name}` };
        }
        return { sample: true, tool: name };
    }
  }

  private priceFor(args: Record<string, unknown>): number {
    if (Array.isArray(args.items) && args.items.some((item) => isRecord(item) && item.productCode === "PRICE_OVER")) {
      return 20_000;
    }
    return this.priceCents;
  }
}

export function assertSamplePayload(result: ToolResult): void {
  const text = result.content.map((item) => item.text ?? "").join("\n");
  if (businessFailed(JSON.parse(text))) {
    throw new Error("样例服务返回失败");
  }
}
