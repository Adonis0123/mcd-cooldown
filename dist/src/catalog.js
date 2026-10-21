/** 2026-10-11 对 https://mcp.mcd.cn 的只读实测，共 35 个工具。描述是网关自己的短说明，调用以运行时 schema 为准。 */
export const CATALOG = [
    { name: "list-nutrition-foods", description: "读取餐品营养数据", effect: "read" },
    { name: "delivery-query-addresses", description: "读取已保存的配送地址", effect: "read" },
    { name: "delivery-create-address", description: "新增配送地址", effect: "write" },
    { name: "delivery-query-stores", description: "按配送地址查询可送门店", effect: "read" },
    { name: "query-meal-assistance", description: "查询企业团餐助餐服务", effect: "read" },
    { name: "query-nearby-stores", description: "查询附近可到店的餐厅", effect: "read" },
    { name: "query-store-coupons", description: "查询当前门店可用优惠券", effect: "read" },
    { name: "query-meals", description: "查询门店当前可售餐品", effect: "read" },
    { name: "query-meal-detail", description: "查询套餐组成", effect: "read" },
    { name: "calculate-price", description: "按所选餐品核价，不创建订单", effect: "read" },
    { name: "create-order", description: "创建点餐订单并返回支付链接", effect: "write" },
    { name: "cancel-order", description: "取消点餐订单", effect: "write" },
    { name: "query-order", description: "查询订单状态和取餐信息", effect: "read" },
    { name: "order-list", description: "查询近期点餐订单", effect: "read" },
    { name: "campaign-calendar", description: "查询当月活动日历", effect: "read" },
    { name: "available-coupons", description: "查询当前可领取的优惠券", effect: "read" },
    { name: "auto-bind-coupons", description: "领取当前可领优惠券", effect: "write" },
    { name: "query-my-coupons", description: "查询账户里的优惠券", effect: "read" },
    { name: "query-my-account", description: "查询积分账户", effect: "read" },
    { name: "mall-points-products", description: "查询积分商城商品", effect: "read" },
    { name: "mall-product-detail", description: "查询积分商城商品详情", effect: "read" },
    { name: "mall-create-order", description: "用积分兑换商品", effect: "write" },
    { name: "now-time-info", description: "读取麦当劳 MCP 当前时间", effect: "read" },
    { name: "query-lottery-info", description: "查询积分抽奖活动信息", effect: "read" },
    { name: "draw-lottery", description: "执行一次积分抽奖", effect: "write" },
    { name: "query-my-prizes", description: "查询抽奖奖品记录", effect: "read" },
    { name: "mall-order-list", description: "查询积分商城订单", effect: "read" },
    { name: "mall-order-detail", description: "查询积分商城订单详情", effect: "read" },
    { name: "query-party-city", description: "查询主题活动城市", effect: "read" },
    { name: "query-party-store", description: "查询主题活动门店", effect: "read" },
    { name: "query-party-store-date", description: "查询主题活动可预约日期", effect: "read" },
    { name: "query-party-store-session", description: "查询主题活动可预约场次", effect: "read" },
    { name: "query-promotions", description: "查询企业团餐满减满折规则", effect: "read" },
    { name: "query-survey-coupon", description: "按订单查询满意度答卷和关联奖券", effect: "read" },
    { name: "party-order-create", description: "创建主题活动订单", effect: "write" },
];
const WRITE_RE = /(^|-)(create|cancel|delete|refund|draw|bind|submit)(-|$)|create-order|draw-lottery|auto-bind/;
export function toolEffect(name) {
    if (name === "cooldown-status")
        return "read";
    const known = CATALOG.find((tool) => tool.name === name);
    if (known)
        return known.effect;
    if (WRITE_RE.test(name))
        return "write";
    return "read";
}
export function isUnpricedWrite(name) {
    return toolEffect(name) === "write" && name !== "create-order";
}
export const WRITE_NAME_PATTERN = WRITE_RE;
//# sourceMappingURL=catalog.js.map