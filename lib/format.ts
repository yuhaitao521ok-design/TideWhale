/** 数字与日期格式化工具，前后端共用。 */

export function formatPrice(value: number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const digits = Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 1 ? 2 : 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatSigned(
  value: number | null | undefined,
  options: { suffix?: string; digits?: number } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const { suffix = "", digits = 2 } = options;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(value), digits)}${suffix}`;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  return formatSigned(value, { suffix: "%", digits });
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

/** 按交易所时区格式化时间，例如 16:00:00 EDT */
export function formatTimeInZone(
  iso: string | number | null | undefined,
  timeZone = "America/New_York",
  options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" },
): string {
  if (iso === null || iso === undefined) return "--";
  const date = typeof iso === "number" ? new Date(iso * 1000) : new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat("zh-CN", options).format(date);
  }
}

/** 根据周期与间隔选择合适的横轴时间格式 */
export function formatAxisTime(
  timestamp: number,
  range: string,
  timeZone: string,
  interval?: string,
): string {
  const date = new Date(timestamp * 1000);
  const intraday = interval
    ? ["1m", "2m", "5m", "15m", "30m", "60m", "90m"].includes(interval)
    : range === "1D";

  const base: Intl.DateTimeFormatOptions = intraday
    ? range === "1D"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : { month: "2-digit", day: "2-digit" }
    : range === "MAX" || range === "5Y"
      ? { year: "numeric", month: "2-digit" }
      : { month: "2-digit", day: "2-digit" };

  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone, ...base }).format(date);
  } catch {
    return new Intl.DateTimeFormat("zh-CN", base).format(date);
  }
}

export function formatFullTime(timestamp: number, timeZone: string): string {
  const date = new Date(timestamp * 1000);
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * 相对时间（新闻流用）：刚刚 / 3 分钟前 / 2 小时前。
 * 用 Intl.RelativeTimeFormat 按界面语言输出，不需要在词典里维护时间文案。
 */
const RELATIVE_FORMATTERS = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = RELATIVE_FORMATTERS.get(locale);
  if (cached) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  RELATIVE_FORMATTERS.set(locale, formatter);
  return formatter;
}

export function formatRelativeTime(iso: string, locale: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "--";
  const diffSeconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(diffSeconds);
  try {
    const formatter = relativeFormatter(locale);
    if (abs < 60) return formatter.format(diffSeconds, "second");
    if (abs < 3600) return formatter.format(Math.round(diffSeconds / 60), "minute");
    if (abs < 86400) return formatter.format(Math.round(diffSeconds / 3600), "hour");
    return formatter.format(Math.round(diffSeconds / 86400), "day");
  } catch {
    return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
  }
}
