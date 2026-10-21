import { containsSecret } from "./redact.js";
import { toolEffect } from "./catalog.js";
import { totalQuantity, validateCreateOrder } from "./money.js";
export function decideIntercept(name, args, config, token) {
    if (containsSecret(args, token)) {
        return {
            kind: "deny",
            reason: "未执行。参数里包含本机凭证，已拒绝。不要把 Token 发给模型。",
        };
    }
    if (toolEffect(name) === "read")
        return { kind: "allow" };
    if (name === "create-order") {
        const problem = validateCreateOrder(args, config.maxItemQuantity);
        if (problem)
            return { kind: "deny", reason: problem };
    }
    else {
        const quantity = totalQuantity(args);
        if (quantity != null && (quantity <= 0 || quantity > config.maxItemQuantity)) {
            return {
                kind: "deny",
                reason: `未执行。份数 ${quantity} 超出单笔上限 ${config.maxItemQuantity}。网关没有转发。`,
            };
        }
    }
    return {
        kind: "hold",
        reason: "有副作用的工具默认只登记，不转发。本机确认后才会执行。",
    };
}
//# sourceMappingURL=policy.js.map