export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
        return Number(value.trim());
    return null;
}
export function asText(value) {
    if (typeof value === "string" && value.trim())
        return value.trim();
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return null;
}
//# sourceMappingURL=is.js.map