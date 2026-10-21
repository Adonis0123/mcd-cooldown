import { isRecord } from "./is.js";
import { epochToMs, formatPercent } from "./time.js";
const WINDOWS = [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
    ["spend_limit", "花费"],
];
export function extractSession(input) {
    const root = isRecord(input) ? input : {};
    const limits = isRecord(root.rate_limits) ? root.rate_limits : {};
    const windows = [];
    for (const [key, label] of WINDOWS) {
        const window = limits[key];
        if (!isRecord(window) || typeof window.used_percentage !== "number")
            continue;
        windows.push({
            key,
            label,
            usedPercentage: window.used_percentage,
            resetsAtMs: epochToMs(window.resets_at),
        });
    }
    const cost = isRecord(root.cost) ? root.cost : {};
    const durationMs = typeof cost.total_duration_ms === "number" ? cost.total_duration_ms : null;
    return { windows, durationMs };
}
export function primaryWindow(windows) {
    if (windows.length === 0)
        return null;
    return [...windows].sort((a, b) => b.usedPercentage - a.usedPercentage)[0] ?? null;
}
export function formatWindow(window) {
    return `${window.label} ${formatPercent(window.usedPercentage)}%`;
}
//# sourceMappingURL=session.js.map