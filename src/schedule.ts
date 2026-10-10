import type { AppConfig } from "./config.js";
import { formatRemaining, isQuietHour, zonedParts } from "./time.js";

export interface Schedule {
  quiet: boolean;
  remainingLabel: string | null;
  confirmByLabel: string | null;
  headline: string;
  hint: string;
  resetAtMs: number | null;
}

export function describeSchedule(now: Date, resetAtMs: number | null, config: AppConfig): Schedule {
  const timeZone = config.meals.timezone;
  const quiet = isQuietHour(now, config.quietStartHour, config.quietEndHour, timeZone);
  if (resetAtMs == null) {
    return {
      quiet,
      remainingLabel: null,
      confirmByLabel: null,
      resetAtMs: null,
      headline: quiet ? "夜深了，先休息" : "还没有额度恢复时间",
      hint: quiet
        ? "建议先休息。饿了再按你保存的份量吃，程序不会自动下单。"
        : "状态栏还没收到额度窗口。可以继续写代码。",
    };
  }
  const remaining = resetAtMs - now.getTime();
  const confirmBy = new Date(resetAtMs - config.prepMinutes * 60_000);
  const remainingLabel = formatRemaining(remaining);
  const confirmByLabel = zonedParts(confirmBy, timeZone).hm;
  if (quiet) {
    return {
      quiet,
      remainingLabel,
      confirmByLabel,
      resetAtMs,
      headline: "夜深了，先休息",
      hint: `额度大约 ${remainingLabel}后恢复。核价可以留着，这个时段确认下单要额外加上 --allow-quiet。`,
    };
  }
  if (remaining <= 30_000) {
    return {
      quiet,
      remainingLabel: "即将恢复",
      confirmByLabel,
      resetAtMs,
      headline: "额度窗口已到恢复时间",
      hint: "如果要取餐，先看核价，确认后才会下单。",
    };
  }
  return {
    quiet,
    remainingLabel,
    confirmByLabel,
    resetAtMs,
    headline: `约 ${remainingLabel}后恢复`,
    hint: `建议 ${confirmByLabel} 前确认。到店自取，起身活动一下。现在只是核价。`,
  };
}
