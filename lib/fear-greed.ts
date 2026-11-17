/**
 * CNN Business 恐惧贪婪指数（Fear & Greed Index）的分档、解析与纯函数：
 *   0 = 极度恐惧，100 = 极度贪婪。
 *
 * 本文件不依赖 fetch / 缓存，可安全被客户端组件引用；
 * 取数与缓存见 lib/cnn.ts（服务端）。
 */

export type FearGreedRating =
  | "extreme-fear"
  | "fear"
  | "neutral"
  | "greed"
  | "extreme-greed";

export interface FearGreedBand {
  rating: FearGreedRating;
  /** 区间下界（含） */
  min: number;
  /** 区间上界（不含，最高档到 100） */
  max: number;
  /** 刻度条配色（两端跟随主题，中间固定橙 / 黄 / 青绿） */
  color: string;
}

/** 五档刻度：与 CNN 页面一致（0–25 / 25–45 / 45–55 / 55–75 / 75–100） */
export const FEAR_GREED_BANDS: FearGreedBand[] = [
  { rating: "extreme-fear", min: 0, max: 25, color: "var(--negative)" },
  { rating: "fear", min: 25, max: 45, color: "#f97316" },
  { rating: "neutral", min: 45, max: 55, color: "#eab308" },
  { rating: "greed", min: 55, max: 75, color: "#84cc16" },
  { rating: "extreme-greed", min: 75, max: 100, color: "var(--positive)" },
];

/** 迷你走势只保留最近 30 个交易日 */
export const FEAR_GREED_HISTORY_DAYS = 30;

/** 分数夹到 0-100（指针位置与展示用，不参与异常数据的分档判断） */
export function clampFearGreedScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

/** 按分数归档；非法值落到「中性」，避免把脏数据说成极度恐惧 */
export function classifyFearGreed(score: number): FearGreedRating {
  if (!Number.isFinite(score)) return "neutral";
  const value = clampFearGreedScore(score);
  for (const band of FEAR_GREED_BANDS) {
    if (value < band.max) return band.rating;
  }
  return "extreme-greed";
}

/** 分数对应的整档（含配色），组件用来给刻度条与指针上色 */
export function fearGreedBand(score: number): FearGreedBand {
  const value = clampFearGreedScore(score);
  return (
    FEAR_GREED_BANDS.find((band) => value < band.max) ??
    FEAR_GREED_BANDS[FEAR_GREED_BANDS.length - 1]
  );
}

/** 兼容 CNN 返回的 rating 文案（如 "extreme fear"）；无法识别时按分数归档 */
export function normalizeFearGreedRating(
  raw: string | null | undefined,
  score: number,
): FearGreedRating {
  const text = (raw ?? "").trim().toLowerCase();
  switch (text) {
    case "extreme fear":
    case "extreme-fear":
      return "extreme-fear";
    case "fear":
      return "fear";
    case "neutral":
      return "neutral";
    case "greed":
      return "greed";
    case "extreme greed":
    case "extreme-greed":
      return "extreme-greed";
    default:
      return classifyFearGreed(score);
  }
}

export interface FearGreedHistoryPoint {
  /** YYYY-MM-DD（UTC） */
  date: string;
  score: number;
  rating: FearGreedRating;
}

export interface FearGreedData {
  /** 当前分数 0–100（保留 CNN 原始精度，展示时取 1 位小数） */
  score: number;
  rating: FearGreedRating;
  /** CNN 自己的更新时间（ISO） */
  updatedAt: string | null;
  previousClose: number | null;
  previousWeek: number | null;
  previousMonth: number | null;
  previousYear: number | null;
  /** 近 30 日走势（按时间升序，同一天只保留最后一个点） */
  history: FearGreedHistoryPoint[];
  fetchedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 解析 CNN graphdata 响应（纯函数，方便单测）。
 *
 * 规则：
 *  - 只要求当前分数存在；对比值 / 历史缺失时降级为 null / 空数组
 *  - 历史数据以「最新一个点」回溯 30 天，同一天只保留最后一个点（CNN 盘中会给多个点）
 *  - 脏行（x / y 缺失）直接跳过，不做猜测
 *  - 格式异常（缺 score）抛错，由 lib/cnn.ts 包装成 CnnError
 */
export function parseFearGreed(payload: unknown): FearGreedData {
  const root = payload as
    | {
        fear_and_greed?: {
          score?: unknown;
          rating?: unknown;
          timestamp?: unknown;
          previous_close?: unknown;
          previous_1_week?: unknown;
          previous_1_month?: unknown;
          previous_1_year?: unknown;
        } | null;
        fear_and_greed_historical?: {
          data?: Array<{ x?: unknown; y?: unknown; rating?: unknown }> | null;
        } | null;
      }
    | null
    | undefined;

  const current = root?.fear_and_greed;
  const score = toFiniteNumber(current?.score);
  if (score === null) throw new Error("CNN 恐惧贪婪数据格式异常");

  const ratingText = typeof current?.rating === "string" ? current.rating : null;
  const rating = normalizeFearGreedRating(ratingText, score);
  const timestamp = typeof current?.timestamp === "string" ? current.timestamp : null;
  const updatedAt =
    timestamp && !Number.isNaN(new Date(timestamp).getTime())
      ? new Date(timestamp).toISOString()
      : null;

  const points: { at: number; score: number; rating: FearGreedRating }[] = [];
  const rows = root?.fear_and_greed_historical?.data;
  for (const item of Array.isArray(rows) ? rows : []) {
    const at = toFiniteNumber(item?.x);
    const value = toFiniteNumber(item?.y);
    if (at === null || value === null) continue;
    points.push({
      at,
      score: value,
      rating: normalizeFearGreedRating(
        typeof item?.rating === "string" ? item.rating : null,
        value,
      ),
    });
  }
  points.sort((left, right) => left.at - right.at);

  const latest = points[points.length - 1]?.at ?? null;
  const cutoff = latest === null ? null : latest - FEAR_GREED_HISTORY_DAYS * DAY_MS;
  const byDate = new Map<string, FearGreedHistoryPoint>();
  for (const point of points) {
    if (cutoff !== null && point.at < cutoff) continue;
    const date = new Date(point.at).toISOString().slice(0, 10);
    byDate.set(date, { date, score: point.score, rating: point.rating });
  }
  const history = [...byDate.values()].slice(-FEAR_GREED_HISTORY_DAYS);

  return {
    score,
    rating,
    updatedAt,
    previousClose: toFiniteNumber(current?.previous_close),
    previousWeek: toFiniteNumber(current?.previous_1_week),
    previousMonth: toFiniteNumber(current?.previous_1_month),
    previousYear: toFiniteNumber(current?.previous_1_year),
    history,
    fetchedAt: new Date().toISOString(),
  };
}
