"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { NewsItem } from "@/lib/news-parse";
import type { NewsSourceStatus } from "@/lib/news";
import { EIGHT_K_ITEMS } from "@/lib/news-sources";

interface NewsAsideProps {
  filings: NewsItem[];
  hot: { ticker: string; count: number }[];
  sources: NewsSourceStatus[];
  onPickTicker: (ticker: string) => void;
}

/** 右栏：SEC 8-K 官方快讯 + 热门标的 + 新闻源健康度 */
export default function NewsAside({ filings, hot, sources, onPickTicker }: NewsAsideProps) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale],
  );
  const visibleFilings = expanded ? filings.slice(0, 40) : filings.slice(0, 7);
  const okCount = sources.filter((source) => source.ok).length;

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
          <div>
            <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
              <span className="flex h-4 w-4 items-center justify-center rounded bg-accent-soft text-accent">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 3h9l5 5v13H5V3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M14 3v5h5M8 13h7M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </span>
              {t("SEC 8-K 快讯")}
            </h2>
            <p className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
              {t("大公司与重大事项的 SEC 8-K 备案")}
            </p>
          </div>
          <span className="rounded border border-border px-1.5 py-[1px] font-mono text-[10px] text-muted-foreground">
            {filings.length}
          </span>
        </header>

        {visibleFilings.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">
            {t("暂无符合条件的大公司备案")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visibleFilings.map((item) => (
              <li key={item.id}>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block px-3 py-2 transition-colors hover:bg-hover/50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] font-medium leading-4">
                      {item.filing?.company ?? item.title}
                    </span>
                    {item.filing?.ticker && (
                      <span className="shrink-0 font-mono text-[10px] text-accent">
                        {item.filing.ticker}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(item.filing?.items ?? []).slice(0, 3).map((code) => (
                      <span
                        key={code}
                        className="rounded bg-muted px-1 py-[1px] text-[10px] text-muted-foreground"
                      >
                        {t(EIGHT_K_ITEMS[code] ?? `Item ${code}`)}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {dateFormat.format(new Date(item.publishedAt))} · {t("官方备案")}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}

        {filings.length > 7 && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="w-full border-t border-border py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            {expanded ? t("收起") : `${t("查看全部")} ${filings.length}`}
          </button>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card px-3 py-2.5">
        <h2 className="text-[13px] font-medium">{t("新闻热点标的")}</h2>
        <p className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
          {t("按新闻提及次数统计，点击查看行情")}
        </p>
        {hot.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">{t("暂无")}</p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {hot.map(({ ticker, count }) => (
              <button
                key={ticker}
                type="button"
                onClick={() => onPickTicker(ticker)}
                className="flex items-center justify-between rounded-lg border border-border px-2 py-1.5 transition-colors hover:border-accent/40 hover:bg-accent-soft"
              >
                <span className="font-mono text-[11.5px] font-medium">{ticker}</span>
                <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                  <span className="h-1 w-1 rounded-full bg-accent/70" aria-hidden="true" />
                  {count}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card">
        <details>
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[13px] font-medium">
            <span className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  okCount === sources.length ? "bg-positive" : okCount > 0 ? "bg-accent" : "bg-negative"
                }`}
                aria-hidden="true"
              />
              {t("新闻源状态")}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {okCount}/{sources.length}
            </span>
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {sources.map((source) => (
              <li key={source.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`h-1 w-1 shrink-0 rounded-full ${source.ok ? "bg-positive" : "bg-negative"}`}
                    aria-hidden="true"
                  />
                  <span className="truncate text-[11px]">{source.name}</span>
                </span>
                <span
                  className="shrink-0 font-mono text-[10px] text-muted-foreground"
                  title={source.error}
                >
                  {source.ok ? `${source.count} · ${source.ms}ms` : t("失败")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <p className="px-1 text-[10px] leading-4 text-muted-foreground">
        {t("新闻来自公开 RSS 与 SEC EDGAR，可能存在延迟，仅供参考。")}
      </p>
    </div>
  );
}
