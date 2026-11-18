"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { formatCompact } from "@/lib/format";
import type { CongressFiling, CongressTrade } from "@/lib/congress-parse";

const SIDE_LABEL: Record<CongressTrade["side"], string> = {
  buy: "买入",
  sell: "卖出",
  exchange: "置换",
};

const OWNER_LABEL: Record<string, string> = {
  SP: "配偶",
  JT: "共同",
  DC: "子女",
};

function money(value: number | null): string {
  if (value === null) return "--";
  return `$${formatCompact(value)}`;
}

/** 金额区间（PTR 只披露档位，如 $50,001 - $100,000） */
function amountRange(trade: CongressTrade): string {
  if (trade.amountMin !== null && trade.amountMax !== null) {
    if (trade.amountMin === trade.amountMax) return money(trade.amountMin);
    return `${money(trade.amountMin)} - ${money(trade.amountMax)}`;
  }
  return trade.amountText || "--";
}

/**
 * 国会披露交易明细：
 * 国会成员不提交 13F，只有 STOCK Act 的 PTR（交易披露），没有持仓快照，
 * 所以这里展示逐笔交易 + 原始披露文件，明确标注金额是区间。
 */
export default function CongressTradesCard({
  trades,
  filings,
  parsedFilings,
  failedFilings,
}: {
  trades: CongressTrade[];
  filings: CongressFiling[];
  parsedFilings?: number;
  failedFilings?: number;
}) {
  const { t } = useI18n();
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    return trades.filter((trade) => {
      if (side !== "all" && trade.side !== side) return false;
      if (!keyword) return true;
      return (
        trade.asset.toUpperCase().includes(keyword) ||
        (trade.ticker ?? "").toUpperCase().includes(keyword)
      );
    });
  }, [trades, side, query]);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-medium">{t("国会交易明细")}</h2>
        <span className="num rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {rows.length}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {(
            [
              { key: "all", label: t("全部") },
              { key: "buy", label: t("买入") },
              { key: "sell", label: t("卖出") },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSide(item.key)}
              aria-pressed={side === item.key}
              className={`h-6 rounded-md border px-2 text-[10.5px] transition-colors ${
                side === item.key
                  ? "border-accent/50 bg-accent-soft font-medium text-accent"
                  : "border-border text-muted-foreground hover:bg-hover hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("搜索标的或资产")}
            aria-label={t("搜索标的或资产")}
            className="h-7 w-[150px] rounded-md border border-border bg-card px-2 text-[11px] outline-none transition-colors focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
          />
        </div>
      </div>

      <p className="border-b border-border/60 bg-muted/30 px-4 py-1.5 text-[9.5px] leading-relaxed text-muted-foreground">
        {t(
          "国会成员不提交 13F：数据来自众议院 Clerk 的 STOCK Act 定期交易报告（PTR），金额为披露区间，不代表完整持仓",
        )}
      </p>

      {rows.length === 0 ? (
        <p className="px-4 py-5 text-[11.5px] text-muted-foreground">{t("暂无交易")}</p>
      ) : (
        <div className="max-h-[520px] overflow-auto scroll-thin">
          <table className="w-full min-w-[680px] text-[11.5px]">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <tr className="text-[10px] text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-medium">{t("交易日期")}</th>
                <th className="px-3 py-1.5 text-left font-medium">{t("类型")}</th>
                <th className="px-3 py-1.5 text-left font-medium">{t("标的")}</th>
                <th className="px-3 py-1.5 text-left font-medium">{t("资产")}</th>
                <th className="px-3 py-1.5 text-left font-medium">{t("持有人")}</th>
                <th className="px-3 py-1.5 text-right font-medium">{t("金额区间")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((trade, index) => (
                <tr
                  key={`${trade.docId}-${trade.tradeDate}-${trade.ticker ?? trade.asset}-${index}`}
                  className="border-t border-border/60 transition-colors hover:bg-muted/40"
                >
                  <td className="num whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                    {trade.tradeDate}
                  </td>
                  <td
                    className={`whitespace-nowrap px-3 py-1.5 ${
                      trade.side === "buy"
                        ? "text-positive-text"
                        : trade.side === "sell"
                          ? "text-negative-text"
                          : "text-muted-foreground"
                    }`}
                  >
                    {t(SIDE_LABEL[trade.side])}
                    {trade.partial ? (
                      <span className="ml-1 text-[8.5px] text-muted-foreground">
                        {t("部分卖出")}
                      </span>
                    ) : null}
                  </td>
                  <td className="num whitespace-nowrap px-3 py-1.5 text-foreground/85">
                    {trade.ticker ?? "--"}
                  </td>
                  <td className="max-w-[260px] px-3 py-1.5">
                    <span className="block truncate text-foreground/85" title={trade.asset}>
                      {trade.asset}
                    </span>
                    {trade.assetType ? (
                      <span className="block text-[9px] text-muted-foreground/70">
                        {trade.assetType}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                    {trade.owner ? t(OWNER_LABEL[trade.owner] ?? "本人") : t("本人")}
                  </td>
                  <td className="num whitespace-nowrap px-3 py-1.5 text-right">
                    {amountRange(trade)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2 text-[9.5px] text-muted-foreground">
        <span>
          {t("披露文件")} {(parsedFilings ?? 0) + (failedFilings ?? 0)}
          {(failedFilings ?? 0) > 0 ? (
            <span className="ml-1 text-negative-text">
              · {t("解析失败")} {failedFilings}
            </span>
          ) : null}
        </span>
        {filings.map((filing) => (
          <a
            key={filing.docId}
            href={filing.url}
            target="_blank"
            rel="noreferrer"
            className="num text-accent hover:underline"
            title={`${t("来源 PTR")} ${filing.docId}`}
          >
            {filing.filedAt} ↗
          </a>
        ))}
      </div>
    </section>
  );
}
