import { formatYuanFromCents } from "./money.js";
import { scrubForLog } from "./redact.js";
import { formatZonedDateTime } from "./time.js";
export function formatPendingLine(row, timeZone) {
    const price = row.quoteCents == null ? "无核价" : `¥${formatYuanFromCents(row.quoteCents)}`;
    const expires = formatZonedDateTime(new Date(row.expiresAt), timeZone);
    return `${row.id}  ${row.status}  ${row.tool}  ${price}  到期 ${expires}`;
}
export function formatAuditLine(event, timeZone, token) {
    const at = formatZonedDateTime(new Date(event.at), timeZone);
    return scrubForLog(JSON.stringify({ ...event, at }), token);
}
//# sourceMappingURL=present.js.map