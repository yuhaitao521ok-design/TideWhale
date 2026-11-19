"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PageShell from "@/components/PageShell";
import NewsFeed from "@/components/news/NewsFeed";
import NewsAside from "@/components/news/NewsAside";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime, formatTimeInZone } from "@/lib/format";
import type { NewsItem } from "@/lib/news-parse";
import type { NewsPayload } from "@/lib/news";
import { NEWS_SOURCES } from "@/lib/news-sources";

const HUES: Record<string, number> = Object.fromEntries(
  NEWS_SOURCES.map((source) => [source.id, source.hue]),
);

const TABS = [
  { key: "all", label: "全部新闻" },
  { key: "hot", label: "突发" },
  { key: "company", label: "公司" },
  { key: "market", label: "市场" },
  { key: "macro", label: "宏观" },
  { key: "world", label: "国际" },
  { key: "filing", label: "官方 8-K" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** 新闻页：美国大公司突发 + 国际市场要闻 + SEC 8-K 官方备案 */
export default function NewsDashboard() {
  const { t, locale } = useI18n();
  const router = useRouter();

  const [data, setData] = useState<NewsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("all");
  const [draft, setDraft] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [auto, setAuto] = useState(true);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (appliedQuery) params.set("q", appliedQuery);
        // 语言切换只影响翻译层：源站抓取结果复用同一份缓存
        if (locale !== "en") params.set("lang", locale);
        if (refresh) params.set("refresh", "1");
        const query = params.toString();
        const response = await fetch(`/api/news${query ? `?${query}` : ""}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setData((await response.json()) as NewsPayload);
      } catch (err) {
        setError(err instanceof Error ? err.message : "network");
      } finally {
        setLoading(false);
      }
    },
    [appliedQuery, locale],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  const items = data?.items ?? [];
  const filings = data?.filings;
  const filtered = useMemo(() => {
    if (tab === "filing") return filings ?? [];
    if (tab === "all") return items;
    if (tab === "hot") return items.filter((item) => item.hot);
    return items.filter((item) => item.category === tab);
  }, [items, tab, filings]);

  const lead = useMemo(() => {
    if (tab !== "all" && tab !== "hot") return null;
    const hot = filtered.filter((item) => item.hot && !item.filing);
    const now = Date.now();
    // 优先 6 小时内的突发；没有新突发时置顶最新一条，避免把旧闻一直挂在「突发」位
    const fresh = hot.filter((item) => now - Date.parse(item.publishedAt) <= 6 * 3600 * 1000);
    if (fresh.length > 0) {
      return fresh.reduce((best, item) => (item.score > best.score ? item : best));
    }
    const latest = filtered
      .filter((item) => !item.filing)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    return latest[0] ?? null;
  }, [filtered, tab]);

  const feedItems = useMemo(() => {
    const rest = lead ? filtered.filter((item) => item.id !== lead.id) : filtered;
    const now = Date.now();
    // 时间桶：1h / 6h / 24h / 更早。桶内按重要度排，既保证新鲜度，又让低价值长文沉下去
    const bucket = (iso: string) => {
      const age = now - Date.parse(iso);
      if (age <= 3600_000) return 0;
      if (age <= 6 * 3600_000) return 1;
      if (age <= 24 * 3600_000) return 2;
      return 3;
    };
    return [...rest].sort((a, b) => {
      const bucketDiff = bucket(a.publishedAt) - bucket(b.publishedAt);
      if (bucketDiff !== 0) return bucketDiff;
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });
  }, [filtered, lead]);

  const onPickTicker = useCallback(
    (ticker: string) => router.push(`/?symbol=${encodeURIComponent(ticker)}`),
    [router],
  );

  const updatedLabel = data
    ? formatTimeInZone(data.fetchedAt, "America/New_York", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "--";

  return (
    <PageShell
      title={t("市场快讯")}
      description={t("美国大公司突发消息与国际要闻，实时更新")}
      actions={
        <>
          <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" aria-hidden="true" />
            {t("最后更新")} {updatedLabel} ET
          </span>
          <button
            type="button"
            onClick={() => setAuto((value) => !value)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            aria-pressed={auto}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${auto ? "animate-pulse bg-positive" : "bg-muted-foreground"}`}
              aria-hidden="true"
            />
            {auto ? t("实时刷新") : t("已暂停")}
          </button>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium transition-colors hover:bg-hover disabled:opacity-60"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className={loading ? "animate-spin" : undefined}
            >
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {t("刷新")}
          </button>
        </>
      }
    >
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="scroll-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
          {TABS.map((item) => {
            const active = item.key === tab;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                aria-pressed={active}
                className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                  active
                    ? "border-accent/40 bg-accent-soft font-medium text-accent"
                    : "border-border text-muted-foreground hover:bg-hover hover:text-foreground"
                }`}
              >
                {t(item.label)}
              </button>
            );
          })}
          <span className="ml-auto hidden shrink-0 self-center pl-2 text-[11px] text-muted-foreground sm:block">
            {filtered.length} {t("条")}
          </span>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedQuery(draft.trim());
          }}
          className="relative"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.9" />
            <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("搜索公司、标的或关键词")}
            aria-label={t("搜索公司、标的或关键词")}
            className="h-8 w-full rounded-lg border border-border bg-card pl-7 pr-7 text-[12px] outline-none transition-colors focus:border-accent/50 sm:w-[260px]"
          />
          {draft && (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                setAppliedQuery("");
              }}
              aria-label={t("清空搜索")}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              ×
            </button>
          )}
        </form>
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0 space-y-3">
          {lead && <LeadCard item={lead} locale={locale} onPickTicker={onPickTicker} />}

          {loading && !data ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <div
                  key={index}
                  className="h-[92px] animate-pulse rounded-xl border border-border bg-card/60"
                />
              ))}
            </div>
          ) : error && !data ? (
            <div className="rounded-xl border border-negative/30 bg-negative-soft/40 px-4 py-8 text-center">
              <p className="text-[12.5px]">
                {t("加载失败")}
                <span className="ml-1 text-muted-foreground">（{error}）</span>
              </p>
              <button
                type="button"
                onClick={() => void load(true)}
                className="mt-3 rounded-lg border border-border bg-card px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-hover"
              >
                {t("点击重试")}
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-12 text-center">
              <p className="text-[13px] font-medium">{t("暂无匹配的新闻")}</p>
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                {t("试试切换分类或清空关键词")}
              </p>
            </div>
          ) : (
            <NewsFeed items={feedItems} hues={HUES} onPickTicker={onPickTicker} />
          )}
        </div>

        <aside className="min-w-0 space-y-3">
          {data ? (
            <NewsAside
              filings={data.filings ?? []}
              hot={data.hot ?? []}
              sources={data.sources ?? []}
              translation={data.translation}
              onPickTicker={onPickTicker}
            />
          ) : (
            [0, 1, 2].map((index) => (
              <div
                key={index}
                className="h-28 animate-pulse rounded-xl border border-border bg-card/60"
              />
            ))
          )}
        </aside>
      </div>
    </PageShell>
  );
}

function LeadCard({
  item,
  locale,
  onPickTicker,
}: {
  item: NewsItem;
  locale: string;
  onPickTicker: (ticker: string) => void;
}) {
  const { t } = useI18n();
  const hue = HUES[item.sourceId] ?? 220;
  const breaking = item.hot && Date.now() - Date.parse(item.publishedAt) <= 6 * 3600 * 1000;

  return (
    <article
      className={`relative overflow-hidden rounded-xl border p-4 ${
        breaking
          ? "border-negative/25 bg-gradient-to-br from-negative-soft via-card to-card"
          : "border-accent/25 bg-gradient-to-br from-accent-soft via-card to-card"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            breaking ? "bg-negative text-white" : "bg-accent text-accent-foreground"
          }`}
        >
          {breaking && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden="true" />}
          {breaking ? t("突发") : t("最新")}
        </span>
        <span
          className="news-source-chip rounded px-1.5 py-[1px] text-[10.5px] font-medium"
          style={{ "--news-hue": hue } as React.CSSProperties}
        >
          {item.source}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {formatRelativeTime(item.publishedAt, locale)}
        </span>
      </div>

      <h2 className="mt-2 text-[18px] font-medium leading-[1.4] tracking-[-0.01em]">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          title={item.titleOriginal}
          className="transition-colors hover:text-accent"
        >
          {item.title}
        </a>
      </h2>

      {item.summary && (
        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-5 text-muted-foreground">
          {item.summary}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        {item.tickers.map((ticker) => (
          <button
            key={ticker}
            type="button"
            onClick={() => onPickTicker(ticker)}
            className="rounded-md border border-border bg-card/80 px-1.5 py-[1px] font-mono text-[10.5px] transition-colors hover:border-accent/40 hover:text-accent"
            title={t("查看该标的行情")}
          >
            {ticker}
          </button>
        ))}
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto text-[10.5px] text-muted-foreground transition-colors hover:text-accent"
        >
          {t("原文")} ↗
        </a>
      </div>
    </article>
  );
}
