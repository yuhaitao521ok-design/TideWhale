"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import Sparkline from "@/components/Sparkline";
import { formatNumber, formatSigned, formatTimeInZone } from "@/lib/format";
import {
  FEAR_GREED_BANDS,
  clampFearGreedScore,
  fearGreedBand,
  type FearGreedData,
  type FearGreedRating,
} from "@/lib/fear-greed";

/** CNN 的指数每隔几分钟才更新一次，不需要跟着行情 30 秒轮询 */
const POLL_MS = 300_000;

/** 文字用与卡片底色对比度更高的语义色，刻度条用 FEAR_GREED_BANDS 里的颜色 */
const RATING_TEXT_CLASS: Record<FearGreedRating, string> = {
  "extreme-fear": "text-negative-text",
  fear: "text-orange-500",
  neutral: "text-amber-500",
  greed: "text-lime-600 dark:text-lime-400",
  "extreme-greed": "text-positive-text",
};

interface FearGreedCardProps {
  /** 跟随行情页的「自动刷新」开关；暂停时不轮询 */
  autoRefresh?: boolean;
}

/** 市场全景：CNN Business 恐惧贪婪指数（独立请求，失败只影响本卡片） */
export default function FearGreedCard({ autoRefresh = true }: FearGreedCardProps) {
  const { t } = useI18n();
  const [data, setData] = useState<FearGreedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 只接受最后一次请求的结果，避免慢请求覆盖新数据 */
  const requestRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestRef.current;
    try {
      const response = await fetch("/api/fear-greed", { cache: "no-store", signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `加载失败（${response.status}）`);
      }
      const next = (await response.json()) as FearGreedData;
      if (requestId !== requestRef.current) return;
      setData(next);
      setError(null);
    } catch (cause) {
      if (signal?.aborted || requestId !== requestRef.current) return;
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      if (!signal?.aborted && requestId === requestRef.current) setLoading(false);
    }
  }, []);

  // 首屏加载（卸载时中止）
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // 「自动刷新」开启时每 5 分钟拉一次；关闭后立刻停止轮询
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const band = data ? fearGreedBand(data.score) : null;

  const retry = () => {
    setError(null);
    void load();
  };

  const ratingLabel = (rating: FearGreedRating) =>
    rating === "extreme-fear"
      ? t("极度恐惧")
      : rating === "fear"
        ? t("恐惧")
        : rating === "neutral"
          ? t("中性")
          : rating === "greed"
            ? t("贪婪")
            : t("极度贪婪");

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card"
      aria-label={t("恐惧贪婪指数")}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[12px] font-medium">{t("恐惧贪婪指数")}</h2>
        <a
          href="https://www.cnn.com/markets/fear-and-greed"
          target="_blank"
          rel="noreferrer"
          className="text-[9.5px] text-muted-foreground transition-colors hover:text-accent"
        >
          CNN Business
        </a>
      </div>

      {error && !data ? (
        <div className="space-y-2 px-3 py-3">
          <p className="truncate text-[10.5px] text-negative-text" title={error}>
            {t("加载失败，请重试")}
          </p>
          <button
            type="button"
            onClick={retry}
            className="h-6 rounded border border-border px-2 text-[10px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            {t("重试")}
          </button>
        </div>
      ) : !data ? (
        <div className="space-y-2 px-3 py-3">
          <div className="skeleton h-8 w-24 rounded-md" />
          <div className="skeleton h-2.5 rounded-full" />
          <div className="skeleton h-9 rounded-md" />
          <p className="text-[9px] text-muted-foreground/70">
            {loading ? t("加载中") : "--"}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5 px-3 py-3">
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span
                  className={`num text-[32px] font-medium leading-none ${RATING_TEXT_CLASS[data.rating]}`}
                >
                  {formatNumber(data.score, 1)}
                </span>
                <span className={`text-[13px] font-medium ${RATING_TEXT_CLASS[data.rating]}`}>
                  {ratingLabel(data.rating)}
                </span>
              </div>
              <p className="mt-1 text-[9px] text-muted-foreground">
                {t("0 = 极度恐惧，100 = 极度贪婪")}
              </p>
            </div>
            <span className="num shrink-0 text-[9px] text-muted-foreground/70">{t("今日")}</span>
          </div>

          <div>
            <div className="relative h-2.5 overflow-hidden rounded-full">
              <div className="flex h-full w-full">
                {FEAR_GREED_BANDS.map((item) => (
                  <span
                    key={item.rating}
                    className="h-full opacity-80"
                    style={{
                      width: `${item.max - item.min}%`,
                      backgroundColor: item.color,
                    }}
                  />
                ))}
              </div>
              <span
                aria-hidden="true"
                className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm ring-2 ring-card"
                style={{
                  left: `${clampFearGreedScore(data.score)}%`,
                  backgroundColor: band?.color,
                }}
              />
            </div>
            <div className="num mt-0.5 flex justify-between text-[8.5px] text-muted-foreground/70">
              <span>0</span>
              <span>50</span>
              <span>100</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {[
              { key: "prev-close", label: t("昨收"), value: data.previousClose },
              { key: "prev-week", label: t("一周前"), value: data.previousWeek },
              { key: "prev-month", label: t("一月前"), value: data.previousMonth },
              { key: "prev-year", label: t("一年前"), value: data.previousYear },
            ].map((item) => {
              const delta = item.value === null ? null : data.score - item.value;
              return (
                <div key={item.key} className="rounded-lg bg-muted/50 px-2 py-1.5">
                  <p className="text-[9px] text-muted-foreground">{item.label}</p>
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="num text-[11.5px] text-foreground">
                      {item.value === null ? "--" : formatNumber(item.value, 1)}
                    </span>
                    <span
                      className={`num text-[9px] ${
                        delta === null
                          ? "text-muted-foreground/60"
                          : delta >= 0
                            ? "text-positive-text"
                            : "text-negative-text"
                      }`}
                    >
                      {delta === null ? "--" : formatSigned(delta, { digits: 1 })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t border-border/60 pt-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[9.5px] text-muted-foreground">
                {t("近 30 日走势")}
                <span className="ml-1 text-muted-foreground/60">
                  {data.history.length} {t("个交易日")}
                </span>
              </p>
              {data.history.length > 1 && (
                <span className="num text-[8.5px] text-muted-foreground/60">
                  {data.history[0].date.slice(5)} →{" "}
                  {data.history[data.history.length - 1].date.slice(5)}
                </span>
              )}
            </div>
            <Sparkline
              data={data.history.map((point) => point.score)}
              positive={data.score >= 50}
              className="mt-1 h-9 w-full"
            />
          </div>

          {error && (
            <button
              type="button"
              onClick={retry}
              title={error}
              className="w-full rounded-md border border-border px-2 py-1 text-left text-[9px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              {t("加载失败，请重试")}
            </button>
          )}

          <p className="flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[8.5px] text-muted-foreground/70">
            <span>{t("CNN Business · 仅供情绪参考")}</span>
            {data.updatedAt && (
              <span className="num" title={data.updatedAt}>
                {t("更新于")}{" "}
                {formatTimeInZone(data.updatedAt, "America/New_York", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}{" "}
                ET
              </span>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
