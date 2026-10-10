import { UserError } from "./user-error.js";

export interface ShanghaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  ymd: string;
  hm: string;
}

export function clockFromEnv(env: NodeJS.ProcessEnv, fallback: () => Date = () => new Date()): Date {
  const raw = env.MCD_NOW;
  if (!raw) return fallback();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new UserError("MCD_NOW 不是有效的 ISO 时间");
  }
  return date;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function shanghaiParts(date: Date): ShanghaiParts {
  return zonedParts(date, "Asia/Shanghai");
}

export function zonedParts(date: Date, timeZone: string): ShanghaiParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  const year = Number(pick("year"));
  const month = Number(pick("month"));
  const day = Number(pick("day"));
  const minute = Number(pick("minute"));
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mi = String(minute).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: WEEKDAYS[pick("weekday")] ?? 0,
    ymd: `${year}-${mm}-${dd}`,
    hm: `${hh}:${mi}`,
  };
}

export function parseHm(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatHm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const parts = zonedParts(new Date(utc), timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const delta = desired - actual;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function isQuietHour(date: Date, startHour: number, endHour: number, timeZone = "Asia/Shanghai"): boolean {
  if (startHour === endHour) return false;
  const { hour } = zonedParts(date, timeZone);
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export function formatRemaining(ms: number): string {
  if (ms <= 30_000) return "即将恢复";
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor(totalMin / 60) % 24;
  const minutes = totalMin % 60;
  if (days > 0 && hours > 0) return `${days} 天 ${hours} 小时`;
  if (days > 0) return `${days} 天`;
  if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (hours > 0) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

export function epochToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > 100_000_000_000) return value;
  return value * 1000;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
