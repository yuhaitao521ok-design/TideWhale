"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import Sparkline from "@/components/Sparkline";
import { formatNumber, formatSigned } from "@/lib/format";
import {
  FEAR_GREED_BANDS,
  type FearGreedData,
  type FearGreedRating,
} from "@/lib/fear-greed";

const BAND_COLORS: Record<FearGreedRating, string> = {
  "extreme-fear": "var(--negative)",
  fear: "#f97316",
  neutral: "#eab308",
  greed: "#84cc16",
  "extreme-greed": "var(--positive)",
};

const RATING_CLASS: Record<FearGreedRating, string> = {
  "extreme-fear": "text-negative-text",
  fear: "text-orange-500",
  neutral: "text-amber-500",
  greed: "text-lime-600 dark:text-lime-400",
  "extreme-greed": "text-positive-text",
};

/** 市场全景：CNN Business 恐惧贪婪指数（独立请求，失败只影响本卡片） */
export default function FearGreedCard() {
  const { t } = useI18n();
  const [data, setData] = useState<FearGreedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/fear-greed", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `加载失败（${response.status}）`);
      }
      const next = (await response.json()) as FearGreedData;
      setData(next);
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

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
            onClick={() => {
              setError(null);
              void load();
            }}
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
                <span className="num text-[32px] font-medium leading-none text-foreground">
                  {formatNumber(data.score, 1)}
                </span>
                <span className={`text-[13px] font-medium ${RATING_CLASS[data.rating]}`}>
                  {ratingLabel(data.rating)}
                </span>
              </div>
              <p className="mt-1 text-[9px] text-muted-foreground">
                {t("0 = 极度恐惧，100 = 极度贪婪")}
              </p>
            </div>
            <span className="num shrink-0 text-[9px] text-muted-foreground/70">
              {t("今日")}
            </span>
          </div>

          <div>
            <div className="relative h-2.5 overflow-hidden rounded-full">
              <div className="flex h-full w-full">
                {FEAR_GREED_BANDS.map((band) => (
                  <span
                    key={band.rating}
                    className="h-full opacity-80"
                    style={{
                      width: `${band.max - band.min}%`,
                      backgroundColor: BAND_COLORS[band.rating],
                    }}
                  />
                ))}
              </div>
              <span
                aria-hidden="true"
                className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-sm ring-2 ring-card"
                style={{ left: `${Math.min(100, Math.max(0, data.score))}%` }}
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
                  {data.history[0].date.slice(5)} → {data.history[data.history.length - 1].date.slice(5)}
                </span>
              )}
            </div>
            <Sparkline
              data={data.history.map((point) => point.score)}
              positive={data.score >= 50}
              className="mt-1 h-9 w-full"
            />
          </div>

          <p className="flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[8.5px] text-muted-foreground/70">
            <span>{t("CNN Business · 仅供情绪参考")}</span>
            {data.updatedAt && (
              <span className="num" title={data.updatedAt}>
                {data.updatedAt.slice(0, 10)}
              </span>
            )}
          </p>
        </div>
      )}
    </section>
  );
}

