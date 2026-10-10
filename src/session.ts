import { isRecord } from "./is.js";
import { epochToMs, formatPercent } from "./time.js";

export interface QuotaWindow {
  key: "five_hour" | "seven_day" | "spend_limit";
  label: string;
  usedPercentage: number;
  resetsAtMs: number | null;
}

export interface SessionSignals {
  windows: QuotaWindow[];
  durationMs: number | null;
}

const WINDOWS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["spend_limit", "花费"],
] as const;

export function extractSession(input: unknown): SessionSignals {
  const root = isRecord(input) ? input : {};
  const limits = isRecord(root.rate_limits) ? root.rate_limits : {};
  const windows: QuotaWindow[] = [];
  for (const [key, label] of WINDOWS) {
    const window = limits[key];
    if (!isRecord(window) || typeof window.used_percentage !== "number") continue;
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

export function primaryWindow(windows: QuotaWindow[]): QuotaWindow | null {
  if (windows.length === 0) return null;
  return [...windows].sort((a, b) => b.usedPercentage - a.usedPercentage)[0] ?? null;
}

export function formatWindow(window: QuotaWindow): string {
  return `${window.label} ${formatPercent(window.usedPercentage)}%`;
}
