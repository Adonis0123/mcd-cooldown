import { defaultConfig } from "./config.js";
import { describeSchedule } from "./schedule.js";
import { renderBox } from "./width.js";

export const DEMO_NOW = new Date("2026-10-10T13:20:00.000Z");
export const DEMO_RESET = new Date("2026-10-10T14:01:00.000Z");

export function renderDemo(now = DEMO_NOW): string {
  const schedule = describeSchedule(now, DEMO_RESET.getTime(), defaultConfig());
  const rows = [
    `5h 额度 96% · ${schedule.headline}`,
    schedule.hint,
    "核价 ¥36.50 · 常点一份 · 只核价，未下单",
    "确认 mcd-cooldown confirm 7f3a2c1b",
    "网关已拦住写操作 · Token 不进模型",
  ];
  return `${renderBox("mcd-cooldown", rows)}\n非麦当劳官方产品 · 默认只核价 · 确认后才下单`;
}
