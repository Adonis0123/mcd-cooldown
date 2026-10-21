import { toolEffect } from "./catalog.js";
import { formatYuanFromCents } from "./money.js";
import { userCommand } from "./user-command.js";
export const GUARD_INSTRUCTIONS = [
    "你正在通过 mcd-cooldown 本地网关访问麦当劳 MCP。这不是麦当劳官方客户端。",
    "不要向用户索取 MCP Token，不要复述密钥，也不要把 Token 放进工具参数。",
    "询价只用 calculate-price。create-order、cancel-order、auto-bind-coupons、draw-lottery、mall-create-order、party-order-create、delivery-create-address 会被网关拦住。",
    "默认只核价不下单。需要继续时，把网关返回的本机确认命令原样告诉用户，让用户自己在终端执行，不要重试写操作。",
    "如果时间已晚，先提醒休息，餐品保持适量。价格、库存和供应以麦当劳官方实时结果为准。",
    "网关输出不是医疗或营养建议。",
].join("\n");
export function holdMessage(input) {
    const lines = [
        "未向麦当劳提交这次操作。",
        `工具：${input.tool}`,
        input.priceNote,
        `参数字段：${input.keys.join(", ") || "无"}`,
        `请求号：${input.id}`,
        `请用户在本机执行：${userCommand()} confirm ${input.id}`,
        "在此之前不要重试。默认只核价。",
    ];
    if (input.quiet) {
        lines.push(`当前是休息时段（北京时间 ${input.quietLabel}）。确认命令需要额外加上 --allow-quiet。可以先休息。`);
    }
    if (input.tool === "delivery-create-address") {
        lines.push("确认后才会把姓名、手机号和地址发给麦当劳。");
    }
    if (input.tool === "draw-lottery" || input.tool === "mall-create-order") {
        lines.push("确认后才会消耗积分或抽奖次数。");
    }
    if (input.tool === "cancel-order")
        lines.push("确认后才会取消订单。");
    if (input.tool === "party-order-create") {
        lines.push("主题活动订单无法用餐饮核价估算金额，确认后才会提交，并计入每日非餐饮写操作次数。");
    }
    if (input.tool === "auto-bind-coupons")
        lines.push("确认后才会领取当前可领优惠券。");
    return lines.filter((line) => line.trim()).join("\n");
}
export function quietLabel(start, end) {
    const pad = (hour) => String(hour).padStart(2, "0");
    return `${pad(start)}:00–${pad(end)}:00`;
}
export function writeAnnotation(description) {
    const note = `【mcd-cooldown 拦截】有副作用。网关默认不执行，只接受本机 ${userCommand()} confirm。`;
    if (!description)
        return note;
    if (description.includes("mcd-cooldown 拦截"))
        return description;
    return `${description} ${note}`;
}
export function annotateTool(tool) {
    if (toolEffect(tool.name) !== "write")
        return tool;
    return { ...tool, description: writeAnnotation(tool.description) };
}
export function yuanNote(cents) {
    return `核价 ¥${formatYuanFromCents(cents)}（calculate-price，金额单位已从分换算）。`;
}
//# sourceMappingURL=messages.js.map