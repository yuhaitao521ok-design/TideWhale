import { cached } from "@/lib/cache";

/**
 * CNN Business 恐惧贪婪指数（Fear & Greed Index）：
 *   0 = 极度恐惧，100 = 极度贪婪。
 * 数据来自 CNN 的公开 dataviz 接口（无需 Key），只用于「市场全景」的情绪参考。
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
}

/** 五档刻度：与 CNN 页面一致（0–25 / 25–45 / 45–55 / 55–75 / 75–100） */
export const FEAR_GREED_BANDS: FearGreedBand[] = [
  { rating: "extreme-fear", min: 0, max: 25 },
  { rating: "fear", min: 25, max: 45 },
  { rating: "neutral", min: 45, max: 55 },
  { rating: "greed", min: 55, max: 75 },
  { rating: "extreme-greed", min: 75, max: 100 },
];

export interface FearGreedHistoryPoint {
  /** YYYY-MM-DD（UTC） */
  date: string;
  score: number;
  rating: FearGreedRating;
}

export interface FearGreedData {
  /** 当前分数 0–100 */
  score: number;
  rating: FearGreedRating;
  /** CNN 的更新时间（ISO） */
  updatedAt: string | null;
  previousClose: number | null;
  previousWeek: number | null;
  previousMonth: number | null;
  previousYear: number | null;
  /** 近 30 日走势（统一按时间升序） */
  history: FearGreedHistoryPoint[];
  fetchedAt: string;
}

/** 按分数归档；边界取「下界」，100 归入极度贪婪 */
export function classifyFearGreed(score: number): FearGreedRating {
  if (!Number.isFinite(score)) return "neutral";
  const value = Math.min(100, Math.max(0, score));
  for (const band of FEAR_GREED_BANDS) {
    if (value < band.max) return band.rating;
  }
  return "extreme-greed";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 解析 CNN graphdata 响应；格式异常时抛出，路由会把失败限制在本卡片 */
export function parseFearGreed(payload: unknown): FearGreedData {
  const root = payload as {
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
  } | null;

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
  for (const item of root?.fear_and_greed_historical?.data ?? []) {
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

  // 以最新一个点为准回溯 30 天；同一天只保留最后一个点
  const latest = points[points.length - 1]?.at ?? null;
  const cutoff = latest === null ? null : latest - HISTORY_DAYS * DAY_MS;
  const byDate = new Map<string, FearGreedHistoryPoint>();
  for (const point of points) {
    if (cutoff !== null && point.at < cutoff) continue;
    const date = new Date(point.at).toISOString().slice(0, 10);
    byDate.set(date, { date, score: point.score, rating: point.rating });
  }
  const history = [...byDate.values()].slice(-HISTORY_DAYS);

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

const CNN_FEAR_GREED_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";

/** CNN 对无浏览器特征（缺 Referer / UA）的请求会返回 418，这里固定一套浏览器头 */
const CNN_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://www.cnn.com/markets/fear-and-greed",
  origin: "https://www.cnn.com",
};

/** 拉取 CNN 恐惧贪婪指数（缓存 60s；失败由路由降级为单卡片报错） */
export async function getFearGreed(): Promise<
  FearGreedData & { cached: boolean; stale: boolean }
> {
  const result = await cached("fear-greed:cnn", 60, 300, async () => {
    const response = await fetch(CNN_FEAR_GREED_URL, {
      headers: CNN_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      throw new Error(`CNN 恐惧贪婪接口不可用（${response.status}）`);
    }
    return parseFearGreed(await response.json());
  });

  return { ...result.value, cached: result.cached, stale: result.stale };
}

