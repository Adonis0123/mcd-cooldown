import { CATALOG } from "../catalog.js";
import { asNumber, isRecord } from "../is.js";
import { businessFailed } from "./parse.js";
/**
 * 合成样例。返回形状对齐 2026-10-11 对官方 MCP 的只读观察，
 * 门店、餐品和价格都是示例，不是真实账户录制。
 */
export class FixtureBackend {
    calls = [];
    priceCents = 3650;
    prepMinutes = 15;
    orderCount = 0;
    async listTools() {
        return CATALOG.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: { type: "object", additionalProperties: true },
        }));
    }
    async callTool(name, args) {
        this.calls.push({ name, args });
        const data = this.payload(name, args);
        if (data && isRecord(data) && data.success === false) {
            const body = {
                success: false,
                code: data.code ?? 400,
                message: typeof data.message === "string" ? data.message : "样例服务拒绝了这次调用",
                sample: true,
            };
            return { structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] };
        }
        const body = { success: true, code: 200, message: "ok", data, sample: true };
        return { structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] };
    }
    called(name) {
        return this.calls.filter((call) => call.name === name).length;
    }
    payload(name, args) {
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
            case "query-nearby-stores": {
                if (args.keyword === "无门店")
                    return [];
                const beType = asNumber(args.beType) ?? 1;
                const store = {
                    storeName: "麦当劳示例餐厅",
                    storeCode: "SAMPLE-STORE",
                    address: "示例路 1 号（样例，不是真实门店）",
                    businessStatus: true,
                    businessStartTime: "00:00",
                    businessEndTime: "23:59",
                    distance: 100,
                };
                if (beType === 2 || beType === 5 || beType === 6)
                    store.beCode = "SAMPLE-BE";
                if (args.keyword === "打烊") {
                    return [{ ...store, storeName: "麦当劳示例打烊", storeCode: "CLOSED-STORE", businessStatus: false }];
                }
                if (args.keyword === "两家") {
                    return [
                        store,
                        {
                            storeName: "麦当劳示例二店",
                            storeCode: "SAMPLE-STORE-2",
                            address: "示例路 2 号（样例，不是真实门店）",
                            businessStatus: false,
                            businessStartTime: "07:00",
                            businessEndTime: "22:00",
                            distance: 400,
                        },
                    ];
                }
                return [store];
            }
            case "query-meals":
                if (args.storeCode === "CLOSED-STORE") {
                    return { success: false, code: 600057, message: "门店可能已关闭或不在营业时间" };
                }
                return sampleMealMenu();
            case "calculate-price": {
                if (args.storeCode === "CLOSED-STORE") {
                    return { success: false, code: 600057, message: "门店可能已关闭或不在营业时间" };
                }
                if (hasProduct(args, "BREAKFAST-ONLY")) {
                    return { success: false, code: 60006, message: "商品已售罄或不可售，换一个商品或检查orderType/beType" };
                }
                const price = this.priceFor(args);
                const data = {
                    productOriginalPrice: price,
                    productPrice: price,
                    originalPrice: price,
                    discount: 0,
                    price,
                    productList: [
                        { productCode: "SAMPLE-001", productName: "示例套餐", quantity: 1, originalSubtotal: price, subtotal: price },
                    ],
                    takeWayList: [
                        { code: "eat-in", title: "堂食", subtitle: "店内用餐" },
                        { code: "locker-in", title: "外带" },
                    ],
                };
                if (this.prepMinutes != null)
                    data.expectMinutes = this.prepMinutes;
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
    priceFor(args) {
        if (hasProduct(args, "PRICE_OVER"))
            return 20_000;
        return this.priceCents;
    }
}
function sampleMealMenu() {
    const featured = [
        { code: "SAMPLE-001", name: "示例套餐", price: "36.50" },
        { code: "SAMPLE-002", name: "示例玉米杯", price: "8.00" },
    ];
    const rest = Array.from({ length: 30 }, (_, index) => {
        const code = `SAMPLE-${String(index + 3).padStart(3, "0")}`;
        return { code, name: `示例餐品${code.slice("SAMPLE-".length)}`, price: "12.00" };
    });
    const meals = {};
    for (const item of [...featured, ...rest]) {
        meals[item.code] = { name: item.name, currentPrice: item.price, originalPrice: item.price, canWithOrder: false };
    }
    return {
        categories: [
            { name: "人气热卖", meals: featured.map((item) => ({ code: item.code, tags: ["样例"] })) },
            { name: "正餐", meals: rest.map((item) => ({ code: item.code, tags: ["样例"] })) },
        ],
        meals,
    };
}
function hasProduct(args, code) {
    return Array.isArray(args.items) && args.items.some((item) => isRecord(item) && item.productCode === code);
}
export function assertSamplePayload(result) {
    const text = result.content.map((item) => item.text ?? "").join("\n");
    if (businessFailed(JSON.parse(text))) {
        throw new Error("样例服务返回失败");
    }
}
//# sourceMappingURL=fixtures.js.map