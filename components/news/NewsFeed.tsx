"use client";

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/format";
import type { NewsItem } from "@/lib/news-parse";
import { EIGHT_K_ITEMS } from "@/lib/news-sources";

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** 复用 formatter：新闻列表一次会渲染上百条，避免每条都构造 Intl 实例 */
function shortDateFormatter(locale: string): Intl.DateTimeFormat {
  const cached = DATE_FORMATS.get(locale);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
  DATE_FORMATS.set(locale, formatter);
  return formatter;
}

function easternDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : DAY_FORMAT.format(date);
}

function easternTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${TIME_FORMAT.format(date)} ET`;
}

interface NewsGroup {
  key: string;
  label: string;
  items: NewsItem[];
}

interface NewsFeedProps {
  items: NewsItem[];
  hues: Record<string, number>;
  onPickTicker: (ticker: string) => void;
}

/** 新闻流：按美东交易日分组，每条带来源、相对时间、摘要与相关标的 */
export default function NewsFeed({ items, hues, onPickTicker }: NewsFeedProps) {
  const { t, locale } = useI18n();

  const groups = useMemo<NewsGroup[]>(() => {
    const now = Date.now();
    const today = easternDay(new Date(now).toISOString());
    const yesterday = easternDay(new Date(now - 24 * 3600 * 1000).toISOString());
    const dateLabel = shortDateFormatter(locale);

    const buckets = new Map<string, NewsItem[]>();
    for (const item of items) {
      const key = easternDay(item.publishedAt) || "unknown";
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    }

    return [...buckets.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, bucket]) => {
        let label: string;
        if (key === today) label = t("今天");
        else if (key === yesterday) label = t("昨天");
        else if (key === "unknown") label = t("更早");
        else label = dateLabel.format(new Date(`${key}T12:00:00Z`));
        return { key, label, items: bucket };
      });
  }, [items, locale, t]);

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="mb-1.5 flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
            <span>{group.label}</span>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            <span className="font-mono text-[10px]">{group.items.length}</span>
          </h2>
          <div className="space-y-2">
            {group.items.map((item) => (
              <NewsCard
                key={item.id}
                item={item}
                hue={hues[item.sourceId] ?? 220}
                onPickTicker={onPickTicker}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function NewsCard({
  item,
  hue,
  onPickTicker,
}: {
  item: NewsItem;
  hue: number;
  onPickTicker: (ticker: string) => void;
}) {
  const { t, locale } = useI18n();
  const filing = item.filing;
  const relative = formatRelativeTime(item.publishedAt, locale);
  const dateLabel = shortDateFormatter(locale).format(new Date(item.publishedAt));

  return (
    <article className="group relative overflow-hidden rounded-xl border border-border bg-card px-3.5 py-3 transition-colors hover:border-border-strong">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[2.5px] opacity-70"
        style={{ background: `hsl(${hue} 65% 52%)` }}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span
          className="news-source-chip rounded-md px-1.5 py-[1px] font-medium"
          style={{ "--news-hue": hue } as React.CSSProperties}
        >
          {item.source}
        </span>
        <time
          dateTime={item.publishedAt}
          title={easternTime(item.publishedAt)}
          className="text-muted-foreground"
        >
          {filing ? `${dateLabel} · ${t("美东")}` : relative}
        </time>
        {item.hot && (
          <span className="rounded bg-negative-soft px-1.5 py-[1px] font-medium text-negative">
            {t("突发")}
          </span>
        )}
        {filing && (
          <span className="rounded bg-accent-soft px-1.5 py-[1px] font-medium text-accent">
            {t("官方备案")}
          </span>
        )}
      </div>

      <h3 className="mt-1.5 text-[14.5px] font-medium leading-[1.45] tracking-[-0.01em]">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          title={item.titleOriginal}
          className="transition-colors hover:text-accent"
        >
          {item.title}
        </a>
      </h3>

      {filing ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {filing.items.slice(0, 4).map((code) => (
            <span
              key={code}
              className="rounded border border-border bg-muted/60 px-1.5 py-[1px] text-[10.5px] text-muted-foreground"
            >
              {t(EIGHT_K_ITEMS[code] ?? `Item ${code}`)}
            </span>
          ))}
        </div>
      ) : (
        item.summary && (
          <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
            {item.summary}
          </p>
        )
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {item.tickers.map((ticker) => (
          <button
            key={ticker}
            type="button"
            onClick={() => onPickTicker(ticker)}
            className="rounded-md border border-border px-1.5 py-[1px] font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
            title={t("查看该标的行情")}
          >
            {ticker}
          </button>
        ))}
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-accent"
        >
          {t("原文")}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M7 17 17 7M9 7h8v8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>
    </article>
  );
}
